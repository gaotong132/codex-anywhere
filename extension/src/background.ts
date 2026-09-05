import { browserOrigin, parseBrowserTarget, requireBrowserId, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { parseOperation } from '../../src/browser-control/operations.js';
import { createDeviceIdentity } from '../../src/shared/device-auth.js';
import { ExtensionConnection } from './connection.js';
import { runPageAgent } from './page-agent.js';
import { openManagedTab } from './managed-tabs.js';
import { sitePattern } from './site-permission.js';

type Binding = { grantId: string; environmentId: string; threadId: string; title: string; pageTitle?: string; target: BrowserTarget; sequence: number; rootTabId?: number };
type Frame = Record<string, any>;
const bindings = new Map<number, Binding>();
const intents = new Map<number, object>();
const busy = new Set<Binding>();
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
const summary = (binding: Binding) => ({ grantId: binding.grantId, environmentId: binding.environmentId, title: binding.title, pageTitle: binding.pageTitle,
  threadId: binding.threadId, origin: binding.target.origin, sitePermissionPattern: sitePattern(binding.target.origin), tabId: binding.target.tabId, child: binding.rootTabId !== undefined });
async function status(windowId?: number) {
  const [tab] = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
  const current = tab?.id === undefined ? undefined : bindings.get(tab.id);
  const root = [...bindings.values()].find((entry) => entry.rootTabId === undefined);
  return { connected: connection?.ready() ?? false, relayOnline: connection?.online ?? false,
    connecting, busy: busy.size > 0, origin, error, devices: connection?.devices ?? [], environmentId: connection?.environmentId ?? '', sessions,
    binding: root ? summary(root) : null, currentManaged: Boolean(current), childCount: Math.max(0, bindings.size - (root ? 1 : 0)),
    childPermission: root ? await chrome.permissions.contains({ origins: [sitePattern(root.target.origin)] }) : false,
    extensionOrigin: `chrome-extension://${chrome.runtime.id}` };
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
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(origin, true).catch(() => {}); }, Math.min(30_000, 1000 * 2 ** retries++));
  }
}

async function page(target: BrowserTarget, grantId: string, operation: Parameters<typeof runPageAgent>[0]['operation'], deadline = Date.now() + 15_000) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] }, world: 'ISOLATED',
    func: runPageAgent, args: [{ grantId, origin: target.origin, operation, deadline }] });
  if (!result || result.documentId !== target.documentId || !result.result) throw new Error('browser_document_changed');
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

async function revokeAll() {
  revision++; intents.clear();
  await Promise.all([...bindings.values()].map(revokeBinding));
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
  busy.add(captured);
  try {
    const operation = parseOperation(request.operation);
    if (bindings.get(captured.target.tabId) !== captured || !connection.ready()) throw new Error('browser_not_authorized');
    let result: Record<string, unknown> = await page(captured.target, captured.grantId, operation, request.deadline);
    if ('openInNewTab' in result && typeof result.openInNewTab === 'string') {
      if (bindings.size >= 64) throw new Error('browser_grant_limit');
      const expectedRevision = revision;
      const current = () => revision === expectedRevision && bindings.get(captured.target.tabId) === captured && connection.ready();
      const target = await openManagedTab(result.openInNewTab, captured.target, request.deadline, current);
      if (!current()) throw new Error('browser_authorization_changed');
      const adopted = await connection.request('browser.adopt', { operationRequestId: request.requestId, parentGrantId: captured.grantId, target });
      const child: Binding = { ...captured, target, grantId: adopted.grantId, sequence: 0, pageTitle: undefined, rootTabId: captured.rootTabId ?? captured.target.tabId };
      try {
        if (!current()) throw new Error('browser_authorization_changed');
        await page(target, child.grantId, { method: 'authorize' }, request.deadline);
        if (!current()) throw new Error('browser_authorization_changed');
        bindings.set(target.tabId, child); await persist();
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
    if (bindings.get(captured.target.tabId) !== captured) return;
    // The broker can dispatch its next call before this response's acknowledgement.
    // Release the local execution slot before publishing completion.
    busy.delete(captured);
    await connection.request('browser.result', { requestId: request.requestId, grantId: captured.grantId, ok: true, result });
  } catch (failure) {
    if (bindings.get(captured.target.tabId) === captured && captured.sequence === request.sequence) {
      busy.delete(captured);
      const code = failure instanceof Error ? failure.message : '';
      await connection.request('browser.result', { requestId: request.requestId, grantId: captured.grantId, ok: false,
        errorCode: ['browser_child_permission_required', 'browser_child_origin_denied', 'browser_operation_timeout'].includes(code) ? code : undefined }).catch(() => {});
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
    fresh = await connection.request('browser.bind', { threadId: captured.threadId, target: captured.target });
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
  await connection.select(environmentId);
  if (revision !== expectedRevision) throw new Error('browser_environment_changed');
  const capability = await connection.request('connector.status');
  if (revision !== expectedRevision) throw new Error('browser_environment_changed');
  if (!capability.capabilities?.browserControl) throw new Error('browser_control_not_enabled_on_connector');
  const response = await connection.request('sessions.list');
  if (revision !== expectedRevision) throw new Error('browser_environment_changed');
  sessions = (response.sessions ?? []).slice(0, 200).map((session: Frame) => ({ id: session.id, title: String(session.name || session.title || session.preview || session.id).slice(0, 100) }));
}

async function connect(url: string, restoring = false) {
  clearTimeout(reconnectTimer); reconnectTimer = undefined;
  let expectedRevision: number;
  if (!restoring) {
    reconnectEnabled = false; retries = 0;
    const revoking = revokeAll(); expectedRevision = revision;
    await revoking; if (revision !== expectedRevision) return;
  } else expectedRevision = ++revision;
  connecting = true; error = ''; sessions = [];
  try {
    origin = await connection.connect(url);
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
    if (revision === expectedRevision) error = safeError(failure);
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
    const result = await connection.request('browser.bind', { threadId, target });
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
  if (message.relayOrigin !== origin || connecting || !connection.ready()) throw new Error('browser_connector_offline');
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
  if (connection.environmentId !== environmentId) {
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
  const messages: Record<string, string> = {
    browser_https_url_required: '请使用 HTTPS 地址；本机 HTTP 仅支持 localhost 或 127.0.0.1。',
    browser_control_not_enabled_on_connector: '这个环境尚未启用浏览器工具，请先按安装文档配置连接器和 MCP。',
    browser_origin_not_allowed: '请在普通 HTTP/HTTPS 网页上授权；浏览器设置页和扩展页面不支持。',
    browser_grant_limit: '已达到 64 个页面的保护上限，请先撤销不再需要的页面。',
    browser_session_already_bound: '这个 Session 已有一个起始页，请先在原浏览器中撤销授权。',
    browser_authorization_changed: '页面或连接已变化，请在目标页面重新授权。',
    browser_connect_timeout: '连接超时。检查 Relay 的扩展 Origin 白名单、配对链接和代理。',
    browser_pairing_failed: '配对失败。请生成新的单次配对链接后重试。',
  };
  return messages[code] || '连接或授权未完成。检查网络、扩展 Origin 白名单及页面权限后重试。';
}

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['privateKey', 'origin']);
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
        ...(Number.isSafeInteger(saved.rootTabId) && saved.rootTabId >= 0 ? { rootTabId: saved.rootTabId } : {}) });
    } catch { /* Discard invalid saved consent; never broaden it. */ }
  }
  await persist();
  origin = typeof saved.origin === 'string' ? saved.origin : '';
  if (origin) void connect(origin, true).catch(() => {});
})();

chrome.runtime.onMessage.addListener((message: Frame, sender, respond) => {
  const panel = sender.url === chrome.runtime.getURL('sidepanel.html');
  if (sender.id !== chrome.runtime.id || sender.tab || (!panel && sender.url !== chrome.runtime.getURL('popup.html'))) return false;
  if (message.type === 'panel.grant' && !panel) return false;
  void ready.then(async () => {
    if (message.type === 'status') return status(panel && Number.isSafeInteger(message.windowId) ? message.windowId : undefined);
    error = '';
    if (message.type === 'connect') await connect(String(message.url));
    else if (message.type === 'cancel') { revision++; intents.clear(); reconnectEnabled = false; connecting = false; clearTimeout(reconnectTimer); reconnectTimer = undefined; connection.close(); }
    else if (message.type === 'environment') {
      const revoking = revokeAll(); const expectedRevision = revision;
      await revoking; if (revision === expectedRevision) await selectEnvironment(String(message.environmentId), expectedRevision);
    }
    else if (message.type === 'grant') await authorize(String(message.threadId));
    else if (message.type === 'panel.grant') await authorizeFromPanel(message);
    else if (message.type === 'revoke') await revokeAll();
    else if (message.type === 'disconnect') { reconnectEnabled = false; await revokeAll(); connection.close(); origin = ''; await chrome.storage.local.remove('origin'); }
    else throw new Error('browser_invalid_request');
    return status();
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
  if (change.url !== undefined || change.status === 'loading') void revokeTab(tabId).catch(() => {});
});
setInterval(() => {
  if (bindings.size && connection?.ready()) void Promise.all([...bindings.values()].map((binding) => connection.request('browser.heartbeat', { grantId: binding.grantId }))).catch(() => {
    if (!connecting) void connect(origin, true).catch(() => {});
  });
  else if (reconnectEnabled && connection?.online && !connection.ready() && bindings.size && !connecting) void connect(origin, true).catch(() => {});
}, 20_000);
