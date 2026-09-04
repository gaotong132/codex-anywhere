import { browserOrigin, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { parseOperation } from '../../src/browser-control/operations.js';
import { createDeviceIdentity } from '../../src/shared/device-auth.js';
import { ExtensionConnection } from './connection.js';
import { runPageAgent } from './page-agent.js';

type Binding = { grantId: string; environmentId: string; threadId: string; title: string; target: BrowserTarget; sequence: number };
type Frame = Record<string, any>;
let binding: Binding | undefined;
let origin = '';
let connection: ExtensionConnection;
let identity: ReturnType<typeof createDeviceIdentity>;
let revision = 0;
let sessions: { id: string; title: string }[] = [];
let connecting = false;
let busy = false;
let error = '';
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let reconnectEnabled = false;
const status = () => ({ connected: connection?.ready() ?? false, relayOnline: connection?.online ?? false,
  connecting, busy, origin, error, devices: connection?.devices ?? [], environmentId: connection?.environmentId ?? '', sessions,
  binding: binding ? { title: binding.title, threadId: binding.threadId, origin: binding.target.origin, tabId: binding.target.tabId } : null,
  extensionOrigin: `chrome-extension://${chrome.runtime.id}` });

async function badge(tabId = binding?.target.tabId) {
  if (tabId === undefined) return;
  const active = binding?.target.tabId === tabId;
  await chrome.action.setBadgeText({ tabId, text: active ? (connection?.ready() ? '•' : '!') : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: connection?.ready() ? '#22a884' : '#b77926' });
  await chrome.action.setTitle({ tabId, title: active ? `Anywhere · ${connection?.ready() ? '已授权' : '离线'} · ${binding?.title}` : 'Codex Anywhere · 授权当前页' });
}

function changed() {
  void badge().catch(() => {});
  if (!connecting && reconnectEnabled && !connection?.online && !reconnectTimer && retries < 5) {
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(origin, true).catch(() => {}); }, Math.min(30_000, 1000 * 2 ** retries++));
  }
}

async function page(target: BrowserTarget, grantId: string, operation: Parameters<typeof runPageAgent>[0]['operation'], deadline = Date.now() + 15_000) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] }, world: 'ISOLATED',
    func: runPageAgent, args: [{ grantId, origin: target.origin, operation, deadline }] });
  if (!result || result.documentId !== target.documentId || !result.result) throw new Error('browser_document_changed');
  return result.result;
}

async function revoke() {
  revision++;
  const old = binding; binding = undefined; busy = false;
  await chrome.storage.session.remove('binding');
  if (!old) return;
  await Promise.allSettled([page(old.target, old.grantId, { method: 'revoke' }),
    connection.request('browser.revoke', { grantId: old.grantId }), badge(old.target.tabId)]);
}

async function handleOperation(frame: Frame) {
  if (frame.event !== 'browser.operation') return;
  const captured = binding;
  const request = frame.payload;
  if (!captured || !request || request.grantId !== captured.grantId || request.threadId !== captured.threadId
    || request.environmentId !== captured.environmentId || JSON.stringify(request.target) !== JSON.stringify(captured.target)
    || !Number.isSafeInteger(request.sequence) || request.sequence <= captured.sequence || !Number.isSafeInteger(request.deadline)
    || request.deadline <= Date.now() || request.deadline > Date.now() + 20_000 || busy) return;
  captured.sequence = request.sequence;
  busy = true;
  try {
    const operation = parseOperation(request.operation);
    if (binding !== captured || !connection.ready()) throw new Error('browser_not_authorized');
    const result = await page(captured.target, captured.grantId, operation, request.deadline);
    if (binding !== captured) return;
    // The broker can dispatch its next call before this response's acknowledgement.
    // Release the local execution slot before publishing completion.
    busy = false;
    await connection.request('browser.result', { requestId: request.requestId, grantId: captured.grantId, ok: true, result });
  } catch {
    if (binding === captured && captured.sequence === request.sequence) {
      busy = false;
      await connection.request('browser.result', { requestId: request.requestId, grantId: captured.grantId, ok: false }).catch(() => {});
    }
  } finally { if (binding === captured && captured.sequence === request.sequence) busy = false; }
}

async function restoreBinding(captured: Binding, expectedRevision: number) {
  const fresh = await connection.request('browser.bind', { threadId: captured.threadId, target: captured.target });
  if (revision !== expectedRevision || binding !== captured) {
    await connection.request('browser.revoke', { grantId: fresh.grantId }).catch(() => {}); return;
  }
  const next = { ...captured, grantId: fresh.grantId, sequence: 0 };
  try {
    await page(next.target, next.grantId, { method: 'authorize' });
    if (revision !== expectedRevision || binding !== captured) throw new Error('browser_authorization_changed');
    binding = next; await chrome.storage.session.set({ binding });
    if (binding === next) await connection.request('browser.heartbeat', { grantId: next.grantId });
  } catch (failure) {
    await page(next.target, next.grantId, { method: 'revoke' }).catch(() => {});
    await connection.request('browser.revoke', { grantId: fresh.grantId }).catch(() => {});
    if (binding === captured || binding === next) await revoke();
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
    const revoking = revoke(); expectedRevision = revision;
    await revoking; if (revision !== expectedRevision) return;
  } else expectedRevision = ++revision;
  connecting = true; error = ''; sessions = [];
  try {
    origin = await connection.connect(url);
    if (revision !== expectedRevision) return;
    await chrome.storage.local.set({ origin });
    reconnectEnabled = true;
    const captured = binding;
    const environment = captured?.environmentId || connection.devices[0];
    if (environment) {
      await selectEnvironment(environment, expectedRevision);
      if (captured) await restoreBinding(captured, expectedRevision);
    }
    retries = 0;
  } catch (failure) {
    if (revision === expectedRevision) error = safeError(failure);
    throw failure;
  } finally { if (revision === expectedRevision) connecting = false; changed(); }
}

async function authorize(threadId: string) {
  if (!connection.ready() || !sessions.some((session) => session.id === threadId)) throw new Error('browser_select_existing_session');
  const revoking = revoke();
  const expectedRevision = revision;
  await revoking; if (revision !== expectedRevision) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('browser_no_tab');
  const tabOrigin = browserOrigin(tab.url);
  const [document] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: () => location.origin });
  if (!document?.documentId || document.result !== tabOrigin || revision !== expectedRevision) throw new Error('browser_document_changed');
  const target: BrowserTarget = { browserDeviceId: identity.id, tabId: tab.id, documentId: document.documentId, origin: tabOrigin };
  const result = await connection.request('browser.bind', { threadId, target });
  const candidate: Binding = { grantId: result.grantId, environmentId: connection.environmentId, threadId,
    title: sessions.find((session) => session.id === threadId)!.title, target, sequence: 0 };
  try {
    if (revision !== expectedRevision) throw new Error('browser_authorization_changed');
    await page(target, candidate.grantId, { method: 'authorize' });
    if (revision !== expectedRevision) throw new Error('browser_authorization_changed');
    binding = candidate; await chrome.storage.session.set({ binding });
    if (binding === candidate) await connection.request('browser.heartbeat', { grantId: candidate.grantId });
    await badge();
  } catch (failure) {
    if (binding === candidate) {
      binding = undefined;
      await chrome.storage.session.remove('binding');
      await badge(candidate.target.tabId).catch(() => {});
    }
    await page(target, candidate.grantId, { method: 'revoke' }).catch(() => {});
    await connection.request('browser.revoke', { grantId: candidate.grantId }).catch(() => {}); throw failure;
  }
}

function safeError(value: unknown) {
  const code = value instanceof Error ? value.message : '';
  const messages: Record<string, string> = {
    browser_https_url_required: '请使用 HTTPS 地址；本机 HTTP 仅支持 localhost 或 127.0.0.1。',
    browser_control_not_enabled_on_connector: '这个环境尚未启用浏览器工具，请先按安装文档配置连接器和 MCP。',
    browser_session_already_bound: '这个 Session 已绑定另一标签页或浏览器，请先在那里撤销授权。',
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
  const temporary = await chrome.storage.session.get('binding');
  binding = temporary.binding as Binding | undefined;
  origin = typeof saved.origin === 'string' ? saved.origin : '';
  if (origin) void connect(origin, true).catch(() => {});
})();

chrome.runtime.onMessage.addListener((message: Frame, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  void ready.then(async () => {
    if (message.type === 'status') return status();
    error = '';
    if (message.type === 'connect') await connect(String(message.url));
    else if (message.type === 'cancel') { revision++; reconnectEnabled = false; connecting = false; clearTimeout(reconnectTimer); reconnectTimer = undefined; connection.close(); }
    else if (message.type === 'environment') {
      const revoking = revoke(); const expectedRevision = revision;
      await revoking; if (revision === expectedRevision) await selectEnvironment(String(message.environmentId), expectedRevision);
    }
    else if (message.type === 'grant') await authorize(String(message.threadId));
    else if (message.type === 'revoke') await revoke();
    else if (message.type === 'disconnect') { reconnectEnabled = false; await revoke(); connection.close(); origin = ''; await chrome.storage.local.remove('origin'); }
    else throw new Error('browser_invalid_request');
    return status();
  }).then((result) => respond({ ok: true, result })).catch((failure) => { error = safeError(failure); respond({ ok: false, error }); });
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => { if (binding?.target.tabId === tabId) void revoke(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (binding?.target.tabId === tabId && (change.url !== undefined || change.status === 'loading')) void revoke();
});
setInterval(() => {
  if (binding && connection?.ready()) void connection.request('browser.heartbeat', { grantId: binding.grantId }).catch(() => {
    if (!connecting) void connect(origin, true).catch(() => {});
  });
  else if (reconnectEnabled && connection?.online && !connection.ready() && binding && !connecting) void connect(origin, true).catch(() => {});
}, 20_000);
