import { browserOrigin, parseBrowserTarget, requireBrowserId, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { browserOperationErrorCode, parseOperation } from '../../src/browser-control/operations.js';
import { createDeviceIdentity, type DeviceAuthProof } from '../../src/shared/device-auth.js';
import type { BrowserLinkRequest } from '../../src/shared/browser-link.js';
import { ExtensionConnection } from './connection.js';
import { runPageAgent } from './page-agent.js';
import { inspectCreatedTab, openManagedTab } from './managed-tabs.js';
import { observeClickNavigation } from './click-navigation.js';
import { sitePattern } from './site-permission.js';
import { canRetireTab, RECENT_CHILD_TABS } from './tab-lifecycle.js';

type Binding = { grantId: string; environmentId: string; threadId: string; title: string; pageTitle?: string; target: BrowserTarget; sequence: number; rootTabId?: number; lastUsedAt?: number };
type Frame = Record<string, any>;
const bindings = new Map<number, Binding>();
const intents = new Map<number, object>();
const busy = new Set<Binding>();
const retiring = new Set<Binding>();
let pruning = false;
let pruneAgain = false;
let saving = Promise.resolve();
let origin = '';
let connection: ExtensionConnection;
let identity: ReturnType<typeof createDeviceIdentity>;
let revision = 0;
let sessions: { id: string; title: string }[] = [];
let connecting = false;
let error = '';
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let reconnectEnabled = false;
let autoConnectPaused = false;
let grantReplacementSupported = false;
let pendingLink: { request: BrowserLinkRequest; windowId: number; channel: string;
  resolve: (proof: DeviceAuthProof) => void; reject: (error: Error) => void } | undefined;

function cancelLink() {
  const pending = pendingLink; pendingLink = undefined;
  pending?.reject(new Error('browser_connection_cancelled'));
}

function requestLink(challenge: string, windowId: number, channel: string): Promise<DeviceAuthProof> {
  cancelLink();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cancelLink(); }, 8000);
    pendingLink = { windowId, channel, request: { requestId: crypto.randomUUID(), challenge,
      extensionOrigin: `chrome-extension://${chrome.runtime.id}`, device: { id: identity.id, publicKey: identity.publicKey } },
      resolve: (proof) => { clearTimeout(timer); resolve(proof); },
      reject: (failure) => { clearTimeout(timer); reject(failure); } };
  });
}
const summary = (binding: Binding) => ({ grantId: binding.grantId, environmentId: binding.environmentId, title: binding.title, pageTitle: binding.pageTitle,
  threadId: binding.threadId, origin: binding.target.origin, sitePermissionPattern: sitePattern(binding.target.origin), tabId: binding.target.tabId, child: binding.rootTabId !== undefined });
async function status(windowId?: number) {
  const [tab] = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
  const current = tab?.id === undefined ? undefined : bindings.get(tab.id);
  const root = [...bindings.values()].find((entry) => entry.rootTabId === undefined);
  return { connected: !connecting && (connection?.ready() ?? false), relayOnline: connection?.online ?? false,
    connecting, autoConnectPaused, busy: busy.size > 0, origin, error, devices: connection?.devices ?? [], environmentId: connection?.environmentId ?? '', sessions,
    binding: root ? summary(root) : null, currentManaged: Boolean(current), childCount: Math.max(0, bindings.size - (root ? 1 : 0)),
    childPermission: root ? await chrome.permissions.contains({ origins: [sitePattern(root.target.origin)] }) : false,
    extensionOrigin: `chrome-extension://${chrome.runtime.id}`,
    linkRequest: pendingLink && pendingLink.windowId === windowId ? { ...pendingLink.request, channel: pendingLink.channel } : null };
}

function persist() {
  const snapshot = [...bindings.values()].map((binding) => ({ ...binding }));
  const write = saving.catch(() => {}).then(async () => {
    await chrome.storage.session.set({ bindings: snapshot });
    await chrome.storage.session.remove('binding'); // migrate the old single-page format
  });
  saving = write;
  return write;
}

async function badge(tabId: number) {
  const binding = bindings.get(tabId);
  const active = Boolean(binding);
  await chrome.action.setBadgeText({ tabId, text: active ? (connection?.ready() ? '•' : '!') : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: connection?.ready() ? '#22a884' : '#b77926' });
  await chrome.action.setTitle({ tabId, title: active ? `Anywhere · ${connection?.ready() ? '已授权' : '离线'} · ${binding?.title}` : 'Codex Anywhere · 打开聊天侧栏' });
}

function changed() {
  for (const tabId of bindings.keys()) void badge(tabId).catch(() => {});
  if (!connecting && reconnectEnabled && !connection?.online && !reconnectTimer && retries < 5) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (reconnectEnabled && !autoConnectPaused) void connect(origin, true).catch(() => {});
    }, Math.min(30_000, 1000 * 2 ** retries++));
  }
}

async function page(target: BrowserTarget, grantId: string, operation: Parameters<typeof runPageAgent>[0]['operation'], deadline = Date.now() + 15_000) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] }, world: 'ISOLATED', injectImmediately: true,
    func: runPageAgent, args: [{ grantId, origin: target.origin, operation, deadline }] });
  if (!result || result.documentId !== target.documentId || !result.result) throw new Error('browser_document_changed');
  if ('errorCode' in result.result) throw new Error(browserOperationErrorCode(result.result.errorCode));
  if ('denied' in result.result && result.result.denied === 'browser_child_origin_denied') throw new Error(result.result.denied);
  return result.result;
}

async function revokeBinding(old: Binding) {
  if (bindings.get(old.target.tabId) !== old) return;
  bindings.delete(old.target.tabId); busy.delete(old);
  const children = old.rootTabId === undefined ? [...bindings.values()].filter((entry) => entry.rootTabId === old.target.tabId) : [];
  const removedChildren = children.map(revokeBinding);
  const saved = persist();
  await Promise.all([saved, ...removedChildren, Promise.allSettled([page(old.target, old.grantId, { method: 'revoke' }),
    connection.request('browser.revoke', { grantId: old.grantId }), badge(old.target.tabId)])]);
}

async function revokeTab(tabId: number) {
  intents.delete(tabId);
  const old = bindings.get(tabId);
  if (old) await revokeBinding(old);
}

async function checkDocument(tabId: number, url?: string) {
  intents.delete(tabId);
  const captured = bindings.get(tabId);
  if (!captured) return;
  try {
    const currentUrl = url ?? (await chrome.tabs.get(tabId)).url;
    if (browserOrigin(currentUrl) !== captured.target.origin) throw new Error('browser_document_changed');
    // SPA routes can change the URL without replacing the authorized document.
    // Probe only that exact document; never inspect or adopt its replacement.
    const [proof] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [captured.target.documentId] }, world: 'ISOLATED', injectImmediately: true, func: () => location.origin,
    });
    if (!proof || proof.documentId !== captured.target.documentId || proof.result !== captured.target.origin) {
      throw new Error('browser_document_changed');
    }
  } catch { await revokeBinding(captured); }
}

async function revokeAll() {
  revision++; intents.clear();
  await Promise.all([...bindings.values()].map(revokeBinding));
}

function sameTree(a: Binding, b: Binding) {
  return a.environmentId === b.environmentId && a.threadId === b.threadId
    && (a.rootTabId ?? a.target.tabId) === (b.rootTabId ?? b.target.tabId);
}

async function reuseChild(url: string, parent: Binding, current: () => boolean, deadline: number) {
  for (const candidate of [...bindings.values()].reverse()) {
    if (Date.now() >= deadline) throw new Error('browser_operation_timeout');
    if (candidate.rootTabId === undefined || !sameTree(candidate, parent)
      || retiring.has(candidate) || (candidate !== parent && busy.has(candidate))) continue;
    try {
      const tab = await chrome.tabs.get(candidate.target.tabId);
      const parentTab = await chrome.tabs.get(parent.target.tabId);
      if (tab.url !== url || tab.pendingUrl || tab.windowId !== parentTab.windowId
        || !await canRetireTab(candidate.target, candidate.grantId)) continue;
      const latest = await chrome.tabs.get(candidate.target.tabId);
      if (latest.url !== url || latest.pendingUrl || latest.windowId !== parentTab.windowId) continue;
      if (!current()) throw new Error('browser_authorization_changed');
      if (bindings.get(candidate.target.tabId) !== candidate || retiring.has(candidate)
        || (candidate !== parent && busy.has(candidate))) continue;
      await chrome.tabs.update(candidate.target.tabId, { active: true });
      if (!current() || bindings.get(candidate.target.tabId) !== candidate) throw new Error('browser_authorization_changed');
      candidate.lastUsedAt = Date.now();
      void persist().catch(() => {});
      return { opened: true, reused: true, pageId: candidate.grantId, origin: candidate.target.origin };
    } catch (failure) { if (!current()) throw failure; }
  }
  return null;
}

async function pruneChildTabs() {
  if (pruning) { pruneAgain = true; return; }
  if (connecting || !connection?.ready()) return;
  pruning = true;
  const expectedRevision = revision;
  try {
    const root = [...bindings.values()].find((binding) => binding.rootTabId === undefined);
    if (!root) return;
    const children = [...bindings.values()].filter((binding) => binding.rootTabId !== undefined && sameTree(binding, root));
    if (children.length <= RECENT_CHILD_TABS) return;
    const rootTab = await chrome.tabs.get(root.target.tabId);
    const ordinary: { binding: Binding; usedAt: number; sequence: number }[] = [];
    for (const child of children) {
      if (revision !== expectedRevision || !connection.ready()) return;
      try {
        const tab = await chrome.tabs.get(child.target.tabId);
        if (tab.windowId === rootTab.windowId && !tab.pendingUrl && !tab.pinned && !tab.audible && await canRetireTab(child.target, child.grantId)) {
          ordinary.push({ binding: child, usedAt: child.lastUsedAt || 0, sequence: child.sequence });
        }
      } catch { /* A closed or replaced tab is handled by its lifecycle event. */ }
    }
    ordinary.sort((a, b) => b.usedAt - a.usedAt);
    for (const candidate of ordinary.slice(RECENT_CHILD_TABS)) {
      const old = candidate.binding;
      if (revision !== expectedRevision || !connection.ready()) return;
      if (bindings.get(old.target.tabId) !== old || busy.has(old)) continue;
      retiring.add(old);
      try {
        if (!await canRetireTab(old.target, old.grantId)) continue;
        const tab = await chrome.tabs.get(old.target.tabId);
        if (tab.active || tab.pendingUrl || tab.pinned || tab.audible || tab.windowId !== rootTab.windowId
          || busy.has(old) || old.sequence !== candidate.sequence || (old.lastUsedAt || 0) !== candidate.usedAt || revision !== expectedRevision
          || bindings.get(old.target.tabId) !== old) continue;
        await chrome.tabs.remove(old.target.tabId);
        await revokeBinding(old);
      } catch { /* Failed cleanup must never fail or replay a browser operation. */ }
      finally { retiring.delete(old); }
    }
  } finally {
    pruning = false;
    if (pruneAgain) { pruneAgain = false; void pruneChildTabs().catch(() => {}); }
  }
}

async function handleOperation(frame: Frame) {
  if (frame.event !== 'browser.operation') return;
  const request = frame.payload;
  const captured = bindings.get(request?.target?.tabId);
  if (!captured || !request || request.grantId !== captured.grantId || request.threadId !== captured.threadId
    || request.environmentId !== captured.environmentId || JSON.stringify(request.target) !== JSON.stringify(captured.target)
    || !Number.isSafeInteger(request.sequence) || request.sequence <= captured.sequence || !Number.isSafeInteger(request.deadline)
    || request.deadline <= Date.now() || request.deadline > Date.now() + 20_000 || busy.has(captured)) return;
  captured.sequence = request.sequence;
  captured.lastUsedAt = Date.now();
  busy.add(captured);
  try {
    if (retiring.has(captured)) throw new Error('browser_authorization_changed');
    const operation = parseOperation(request.operation);
    if (bindings.get(captured.target.tabId) !== captured || !connection.ready()) throw new Error('browser_not_authorized');
    const expectedRevision = revision;
    const current = () => revision === expectedRevision && bindings.get(captured.target.tabId) === captured && connection.ready();
    const run = () => page(captured.target, captured.grantId, operation, request.deadline);
    const observed = operation.method === 'click'
      ? await observeClickNavigation(captured.target, request.deadline, current, run)
      : { result: await run(), targets: [] };
    let result: Record<string, unknown> = observed.result;
    let scriptTabId: number | undefined;
    if (result.clicked === true && observed.targets.length) {
      if (observed.targets.length === 1) {
        try { browserOrigin(observed.targets[0].url); scriptTabId = observed.targets[0].tabId; }
        catch { /* Non-HTTP destinations require explicit user handling, without injection. */ }
      }
      if (scriptTabId === undefined) result = { clicked: true, opened: true, authorizationRequired: true, newPageCount: observed.targets.length };
    }
    const linkUrl = typeof result.openInNewTab === 'string' ? result.openInNewTab : undefined;
    if (linkUrl !== undefined || scriptTabId !== undefined) {
      const reused = linkUrl === undefined ? null : await reuseChild(linkUrl, captured, current, request.deadline);
      if (reused) result = reused;
      else {
        if (bindings.size >= 64) throw new Error('browser_grant_limit');
        const opened = scriptTabId === undefined
          ? await openManagedTab(linkUrl!, captured.target, request.deadline, current)
          : await inspectCreatedTab(scriptTabId, captured.target, request.deadline, current);
        if (!current()) throw new Error('browser_authorization_changed');
        if ('authorizationRequired' in opened) {
          result = { opened: true, authorizationRequired: true, origin: opened.origin };
        } else {
          const target = opened.target;
          const adopted = await connection.request('browser.adopt', { operationRequestId: request.requestId, parentGrantId: captured.grantId, target });
          const child: Binding = { ...captured, target, grantId: adopted.grantId, sequence: 0, lastUsedAt: Date.now(), pageTitle: undefined, rootTabId: captured.rootTabId ?? captured.target.tabId };
          try {
            if (!current()) throw new Error('browser_authorization_changed');
            await page(target, child.grantId, { method: 'authorize' }, request.deadline);
            if (!current()) throw new Error('browser_authorization_changed');
            bindings.set(target.tabId, child); await persist();
            await canRetireTab(target, child.grantId);
            await connection.request('browser.heartbeat', { grantId: child.grantId });
            await badge(target.tabId);
            result = { opened: true, pageId: child.grantId, origin: target.origin };
          } catch (failure) {
            await revokeBinding(child);
            await page(target, child.grantId, { method: 'revoke' }).catch(() => {});
            await connection.request('browser.revoke', { grantId: child.grantId }).catch(() => {});
            throw failure;
          }
        }
      }
    }
    if (bindings.get(captured.target.tabId) !== captured) return;
    // The broker can dispatch its next call before this response's acknowledgement.
    // Release the local execution slot before publishing completion.
    busy.delete(captured);
    await connection.request('browser.result', { requestId: request.requestId, grantId: captured.grantId, ok: true, result });
    // The source operation must finish before its old child can be retired.
    void pruneChildTabs().catch(() => {});
  } catch (failure) {
    if (bindings.get(captured.target.tabId) === captured && captured.sequence === request.sequence) {
      busy.delete(captured);
      const code = failure instanceof Error ? failure.message : '';
      await connection.request('browser.result', { requestId: request.requestId, grantId: captured.grantId, ok: false,
        errorCode: browserOperationErrorCode(code) }).catch(() => {});
    }
  } finally { if (captured.sequence === request.sequence) busy.delete(captured); }
}

async function restoreBinding(captured: Binding, expectedRevision: number) {
  let fresh;
  try { fresh = await connection.request('browser.restore', { grantId: captured.grantId, target: captured.target }); }
  catch {
    // A restarted connector has no child provenance. Restore only the root;
    // never recreate child consent from an arbitrary target submitted as bind.
    if (captured.rootTabId !== undefined || revision !== expectedRevision || bindings.get(captured.target.tabId) !== captured) throw new Error('browser_restore_unavailable');
    for (const child of [...bindings.values()]) if (child.rootTabId === captured.target.tabId) await revokeBinding(child);
    fresh = await connection.request('browser.bind', { threadId: captured.threadId, target: captured.target, recoverOnly: true });
  }
  if (revision !== expectedRevision || bindings.get(captured.target.tabId) !== captured) {
    await connection.request('browser.revoke', { grantId: fresh.grantId }).catch(() => {}); return;
  }
  const next = { ...captured, grantId: fresh.grantId, sequence: 0 };
  try {
    await page(next.target, next.grantId, { method: 'authorize' });
    if (revision !== expectedRevision || bindings.get(captured.target.tabId) !== captured) throw new Error('browser_authorization_changed');
    bindings.set(next.target.tabId, next); busy.delete(captured); await persist();
    if (bindings.get(next.target.tabId) === next) await connection.request('browser.heartbeat', { grantId: next.grantId });
  } catch (failure) {
    await page(next.target, next.grantId, { method: 'revoke' }).catch(() => {});
    await connection.request('browser.revoke', { grantId: fresh.grantId }).catch(() => {});
    const current = bindings.get(captured.target.tabId);
    if (current === captured || current === next) await revokeBinding(current);
    throw failure;
  }
}

async function selectEnvironment(environmentId: string, expectedRevision = revision) {
  grantReplacementSupported = false;
  await connection.select(environmentId);
  if (revision !== expectedRevision) throw new Error('browser_environment_changed');
  const capability = await connection.request('connector.status');
  if (revision !== expectedRevision) throw new Error('browser_environment_changed');
  if (!capability.capabilities?.browserControl) throw new Error('browser_control_not_enabled_on_connector');
  grantReplacementSupported = capability.capabilities.browserGrantReplacement === true;
  const response = await connection.request('sessions.list');
  if (revision !== expectedRevision) throw new Error('browser_environment_changed');
  sessions = (response.sessions ?? []).slice(0, 200).map((session: Frame) => ({ id: session.id, title: String(session.name || session.title || session.preview || session.id).slice(0, 100) }));
}

async function connect(url: string, restoring = false, link?: (challenge: string) => Promise<DeviceAuthProof>) {
  cancelLink();
  clearTimeout(reconnectTimer); reconnectTimer = undefined;
  let expectedRevision: number;
  if (!restoring) {
    reconnectEnabled = false; retries = 0;
    const revoking = revokeAll(); expectedRevision = revision;
    await revoking; if (revision !== expectedRevision) return;
  } else expectedRevision = ++revision;
  if (restoring && origin && !link) reconnectEnabled = true;
  connecting = true; error = ''; sessions = [];
  try {
    origin = await connection.connect(url, link);
    if (revision !== expectedRevision) return;
    await chrome.storage.local.set({ origin });
    reconnectEnabled = true;
    const captured = [...bindings.values()];
    const environment = captured[0]?.environmentId || connection.devices[0];
    if (environment) {
      await selectEnvironment(environment, expectedRevision);
      // Restore the one root first, retaining server-attested child lineage.
      let failed = false;
      for (const binding of captured.sort((a, b) => Number(a.rootTabId !== undefined) - Number(b.rootTabId !== undefined))) {
        if (bindings.get(binding.target.tabId) !== binding) continue;
        if (binding.environmentId !== environment) { await revokeBinding(binding); continue; }
        try { await restoreBinding(binding, expectedRevision); }
        catch { await revokeBinding(binding); failed = true; }
      }
      if (revision === expectedRevision && failed) error = '部分页面未恢复。请重新授权起始页，或让 AI 重新打开所需子页。';
    }
    retries = 0;
  } catch (failure) {
    if (revision === expectedRevision) {
      error = safeError(failure);
      if (failure instanceof Error && failure.message === 'browser_device_not_approved') reconnectEnabled = false;
    }
    throw failure;
  } finally { if (revision === expectedRevision) connecting = false; changed(); }
}

type PanelTarget = { tabId: number; windowId: number; url: string; documentId: string };

async function authorize(threadId: string, requested?: PanelTarget) {
  if (connecting || !connection.ready() || !sessions.some((session) => session.id === threadId)) throw new Error('browser_select_existing_session');
  let expectedRevision = revision;
  const tab = requested ? await chrome.tabs.get(requested.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined) throw new Error('browser_no_tab');
  if (requested && (!tab.active || tab.windowId !== requested.windowId || tab.url !== requested.url)) throw new Error('browser_document_changed');
  const tabOrigin = browserOrigin(tab.url);
  if (revision !== expectedRevision) throw new Error('browser_authorization_changed');
  const revoking = revokeAll(); expectedRevision = revision;
  const intent = {}; intents.set(tab.id, intent);
  const current = () => revision === expectedRevision && intents.get(tab.id!) === intent;
  try {
    await revoking; if (!current()) throw new Error('browser_authorization_changed');
    const [document] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: () => location.origin });
    if (!document?.documentId || document.result !== tabOrigin || !current()
      || (requested && document.documentId !== requested.documentId)) throw new Error('browser_document_changed');
    const target: BrowserTarget = { browserDeviceId: identity.id, tabId: tab.id, documentId: document.documentId, origin: tabOrigin };
    // Only a fresh authorization click can replace an orphaned root. Automatic
    // restore intentionally omits this flag and cannot retake a replaced page.
    const result = await connection.request('browser.bind', { threadId, target, replaceExisting: true });
    const candidate: Binding = { grantId: result.grantId, environmentId: connection.environmentId, threadId,
      title: sessions.find((session) => session.id === threadId)?.title || threadId, pageTitle: tab.title?.slice(0, 100), target, sequence: 0 };
    try {
      if (!current()) throw new Error('browser_authorization_changed');
      await page(target, candidate.grantId, { method: 'authorize' });
      if (!current()) throw new Error('browser_authorization_changed');
      bindings.set(tab.id, candidate); await persist();
      if (bindings.get(tab.id) === candidate) await connection.request('browser.heartbeat', { grantId: candidate.grantId });
      await badge(tab.id);
    } catch (failure) {
      if (bindings.get(tab.id) === candidate) await revokeBinding(candidate);
      await page(target, candidate.grantId, { method: 'revoke' }).catch(() => {});
      await connection.request('browser.revoke', { grantId: candidate.grantId }).catch(() => {}); throw failure;
    }
  } finally { if (intents.get(tab.id) === intent) intents.delete(tab.id); }
}

async function authorizeFromPanel(message: Frame) {
  if (message.relayOrigin !== origin || connecting || !connection.online) throw new Error('browser_connector_offline');
  if (!Number.isSafeInteger(message.tabId) || message.tabId < 0 || !Number.isSafeInteger(message.windowId)
    || message.windowId < 0 || typeof message.url !== 'string') throw new Error('browser_no_tab');
  const environmentId = requireBrowserId(message.environmentId);
  const threadId = requireBrowserId(message.threadId);
  let expectedRevision = revision;
  const tab = await chrome.tabs.get(message.tabId);
  if (!tab.active || tab.windowId !== message.windowId || tab.url !== message.url) throw new Error('browser_document_changed');
  const tabOrigin = browserOrigin(tab.url);
  const [document] = await chrome.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] },
    world: 'ISOLATED', func: () => location.origin });
  if (!document?.documentId || document.result !== tabOrigin || revision !== expectedRevision) throw new Error('browser_document_changed');
  // Capture the exact document before any network wait. A reload to the same URL
  // must not transfer consent to the replacement document.
  const target: PanelTarget = { tabId: message.tabId, windowId: message.windowId, url: message.url, documentId: document.documentId };
  if (connection.environmentId !== environmentId || !connection.ready()) {
    const revoking = revokeAll(); expectedRevision = revision;
    await revoking;
    if (revision !== expectedRevision) throw new Error('browser_authorization_changed');
    await selectEnvironment(environmentId, expectedRevision);
  } else {
    const response = await connection.request('sessions.list');
    if (revision !== expectedRevision) throw new Error('browser_authorization_changed');
    sessions = (response.sessions ?? []).slice(0, 200).map((session: Frame) => ({ id: session.id,
      title: String(session.name || session.title || session.preview || session.id).slice(0, 100) }));
  }
  if (revision !== expectedRevision || connection.environmentId !== environmentId) throw new Error('browser_authorization_changed');
  await authorize(threadId, target);
}

function safeError(value: unknown) {
  const code = value instanceof Error ? value.message : '';
  if (code === 'browser_session_already_bound' && !grantReplacementSupported) {
    return '当前环境的连接器需更新后才能清理旧页签授权。请更新该环境的 Connector，再授权当前页。';
  }
  const messages: Record<string, string> = {
    browser_https_url_required: '请使用 HTTPS 地址；本机 HTTP 仅支持 localhost 或 127.0.0.1。',
    browser_control_not_enabled_on_connector: '这个环境尚未启用浏览器工具，请先按安装文档配置连接器和 MCP。',
    browser_origin_not_allowed: '请在普通 HTTP/HTTPS 网页上授权；浏览器设置页和扩展页面不支持。',
    browser_document_changed: '页面已切换或刷新，请确认当前页后重新授权。',
    browser_connector_offline: '页面控制尚未连接，请在设置中连接后重试。',
    browser_select_existing_session: '当前会话暂不可用，请在聊天中选择已有会话后重试。',
    browser_grant_limit: '已达到 64 个页面的保护上限，请先撤销不再需要的页面。',
    browser_session_already_bound: '此会话仍被其他浏览器占用。请撤销其授权，或在旧浏览器离线 45 秒后重新授权当前页。',
    browser_authorization_changed: '页面或连接已变化，请在目标页面重新授权。',
    browser_connect_timeout: '连接超时。检查 Relay 的扩展 Origin 白名单、配对链接和代理。',
    browser_pairing_failed: '身份关联失败。请确认侧栏聊天已连接，并重新加载聊天后重试。',
    browser_device_not_approved: '插件设备尚未获准或已被撤销。聊天已配对时会尝试自动关联；已撤销的设备需由管理员重新批准。',
    browser_link_rejected: '自动关联未获允许。请确认聊天身份仍有效；已撤销的插件需由管理员重新批准。',
    browser_link_update_required: '服务器尚不支持一次配对，请更新 Relay 后重试。',
  };
  return messages[code] || '连接或授权未完成。检查网络、扩展 Origin 白名单及页面权限后重试。';
}

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['privateKey', 'origin', 'controlPaused']);
  autoConnectPaused = saved.controlPaused === true;
  identity = createDeviceIdentity(typeof saved.privateKey === 'string' ? saved.privateKey : undefined);
  await chrome.storage.local.set({ privateKey: identity.privateKey });
  connection = new ExtensionConnection(identity, (frame) => { void handleOperation(frame); }, changed);
  const temporary = await chrome.storage.session.get(['bindings', 'binding']);
  const stored = Array.isArray(temporary.bindings) ? temporary.bindings : temporary.binding ? [temporary.binding] : [];
  for (const saved of stored.slice(0, 64)) {
    try {
      const target = parseBrowserTarget(saved.target);
      if (target.browserDeviceId !== identity.id) continue;
      bindings.set(target.tabId, { grantId: requireBrowserId(saved.grantId), environmentId: requireBrowserId(saved.environmentId),
        threadId: requireBrowserId(saved.threadId), target, title: String(saved.title || '').slice(0, 100),
        pageTitle: String(saved.pageTitle || '').slice(0, 100), sequence: 0,
        ...(Number.isSafeInteger(saved.lastUsedAt) && saved.lastUsedAt >= 0 ? { lastUsedAt: saved.lastUsedAt } : {}),
        ...(Number.isSafeInteger(saved.rootTabId) && saved.rootTabId >= 0 ? { rootTabId: saved.rootTabId } : {}) });
    } catch { /* Discard invalid saved consent; never broaden it. */ }
  }
  await persist();
  origin = typeof saved.origin === 'string' ? saved.origin : '';
  if (origin && !autoConnectPaused) void connect(origin, true).catch(() => {});
})();

chrome.runtime.onMessage.addListener((message: Frame, sender, respond) => {
  const panel = sender.url === chrome.runtime.getURL('sidepanel.html');
  if (sender.id !== chrome.runtime.id || sender.tab || (!panel && sender.url !== chrome.runtime.getURL('popup.html'))) return false;
  if (String(message.type).startsWith('panel.') && !panel) return false;
  void ready.then(async () => {
    if (message.type === 'status') return status(panel && Number.isSafeInteger(message.windowId) ? message.windowId : undefined);
    if (message.type === 'panel.connect') {
      const input = new URL(String(message.origin));
      if (input.origin !== message.origin || !Number.isSafeInteger(message.windowId)
        || !/^[a-f0-9]{32}$/.test(message.channel)) throw new Error('browser_invalid_request');
      if (autoConnectPaused && message.force !== true) return status(message.windowId);
      autoConnectPaused = false; await chrome.storage.local.remove('controlPaused');
      if (!connecting && !(connection.online && origin === input.origin)) {
        void connect(input.origin, origin === input.origin,
          (challenge) => requestLink(challenge, message.windowId, message.channel)).catch(() => {});
      }
      return status(message.windowId);
    }
    if (message.type === 'panel.link.complete') {
      const pending = pendingLink;
      if (!pending || pending.windowId !== message.windowId || pending.channel !== message.channel
        || pending.request.requestId !== message.requestId) throw new Error('browser_authorization_changed');
      pendingLink = undefined; pending.resolve(message.sponsor);
      return status(message.windowId);
    }
    error = '';
    if (message.type === 'connect') { autoConnectPaused = false; await chrome.storage.local.remove('controlPaused'); await connect(String(message.url)); }
    else if (message.type === 'cancel') { autoConnectPaused = true; await chrome.storage.local.set({ controlPaused: true }); cancelLink(); revision++; intents.clear(); reconnectEnabled = false; connecting = false; clearTimeout(reconnectTimer); reconnectTimer = undefined; connection.close(); }
    else if (message.type === 'environment') {
      const revoking = revokeAll(); const expectedRevision = revision;
      await revoking; if (revision === expectedRevision) await selectEnvironment(String(message.environmentId), expectedRevision);
    }
    else if (message.type === 'grant') await authorize(String(message.threadId));
    else if (message.type === 'panel.grant') await authorizeFromPanel(message);
    else if (message.type === 'revoke') await revokeAll();
    else if (message.type === 'disconnect') { autoConnectPaused = true; await chrome.storage.local.set({ controlPaused: true }); cancelLink(); reconnectEnabled = false; await revokeAll(); connection.close(); origin = ''; await chrome.storage.local.remove('origin'); }
    else throw new Error('browser_invalid_request');
    return status(panel && Number.isSafeInteger(message.windowId) ? message.windowId : undefined);
  }).then((result) => respond({ ok: true, result })).catch((failure) => { error = safeError(failure); respond({ ok: false, error }); });
  return true;
});
// Each toolbar click also obtains activeTab for that page. Opening the panel
// alone never authorizes page control or injects a script.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => { void revokeTab(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Chrome also emits loading/complete for hash-only navigation. Every operation
  // and this check targets the original document, even while a replacement loads.
  if (change.url !== undefined || change.status !== undefined) void checkDocument(tabId, change.url).catch(() => {});
});
setInterval(() => {
  if (bindings.size && connection?.ready()) void Promise.all([...bindings.values()].map((binding) => connection.request('browser.heartbeat', { grantId: binding.grantId }))).catch(() => {
    if (!connecting) void connect(origin, true).catch(() => {});
  });
  else if (reconnectEnabled && connection?.online && !connection.ready() && bindings.size && !connecting) void connect(origin, true).catch(() => {});
}, 20_000);
