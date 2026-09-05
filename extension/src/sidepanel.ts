import './sidepanel.css';
import { SIDEPANEL_PATH, parseSidePanelSession, type SidePanelSession } from '../../src/shared/sidepanel.js';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = element<HTMLIFrameElement>('chat');
const address = element<HTMLInputElement>('relay-url');
const grant = element<HTMLButtonElement>('grant');
const dialog = element<HTMLDialogElement>('control-dialog');
let relayOrigin = '';
let channel = '';
let selection: SidePanelSession | null = null;
let sequence = 0;
let lastSeen = 0;
let loadedAt = 0;
let busy = false;
let windowId: number | undefined;
let activeTab: chrome.tabs.Tab | undefined;
let state: Record<string, any> = {};
let operationError = '';
let refreshRevision = 0;
let targetRevision = 0;

function serverOrigin(input: string) {
  const url = new URL(input.trim());
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('请填写 HTTPS 服务器地址；本机可使用 HTTP。配对链接请粘贴到聊天页或页面控制设置。');
  }
  return url.origin;
}

function currentSelection() {
  return selection?.online && selection.threadId && Date.now() - lastSeen < 5000 ? selection : null;
}

function render() {
  const selected = currentSelection();
  const connected = state.origin === relayOrigin && state.relayOnline;
  const pageAvailable = Boolean(activeTab?.url && /^https?:\/\//.test(activeTab.url));
  grant.disabled = busy || state.connecting === true || !selected || !pageAvailable;
  grant.textContent = state.connecting ? '正在连接…' : connected ? '授权当前页' : '连接页面控制';
  element('session-title').textContent = selected
    ? `${selected.environmentId} · ${selected.title || selected.threadId}`
    : selection ? '请在聊天页连接环境并选择会话' : '正在读取聊天会话…';
  const binding = state.binding;
  element('revoke').hidden = !binding;
  element<HTMLButtonElement>('revoke').disabled = busy;
  element('browser-status').textContent = operationError || (binding
    ? `已授权：${binding.environmentId || state.environmentId} · ${binding.title} · ${binding.origin}${state.connected ? '' : '（离线）'}`
    : !activeTab?.url ? '正在读取当前标签页；请检查扩展是否已重新加载并启用。'
      : !pageAvailable ? '此页面不支持控制，请切换到普通 HTTP/HTTPS 网页。'
        : '点击授权并允许当前站点访问后，上方会话才可读取和操作此页。');
  element('frame-error').hidden = !channel || Date.now() - (lastSeen || loadedAt) < 15_000;
}

function loadChat(origin: string) {
  relayOrigin = origin;
  channel = crypto.randomUUID().replaceAll('-', '');
  selection = null; sequence = 0; lastSeen = 0; loadedAt = Date.now(); operationError = '';
  frame.src = `${origin}${SIDEPANEL_PATH}?extensionId=${chrome.runtime.id}&channel=${channel}`;
  element('setup').hidden = true;
  element('browser-bar').hidden = false;
  element('frame-wrap').hidden = false;
  element('settings').textContent = '设置';
  render();
}

// Remote Web content can publish selection only. It cannot dispatch runtime
// messages, supply a browser target, or perform privileged operations.
window.addEventListener('message', (event) => {
  if (!channel || event.source !== frame.contentWindow || event.origin !== relayOrigin) return;
  const next = parseSidePanelSession(event.data, channel);
  if (!next || next.sequence <= sequence) return;
  sequence = next.sequence; selection = next; lastSeen = Date.now();
  render();
});
frame.addEventListener('load', () => {
  selection = null; sequence = 0; lastSeen = 0; loadedAt = Date.now(); render();
});

async function refresh() {
  const revision = ++refreshRevision;
  try {
    const [response, tabs] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'status', windowId }),
      chrome.tabs.query({ active: true, windowId }),
    ]);
    if (revision !== refreshRevision) return;
    if (response.ok) state = response.result;
    activeTab = tabs[0]; render();
  } catch { /* The next poll recovers a restarted worker. */ }
}

// A side panel stays open across tab switches. Invalidate the previous target
// immediately, including same-URL reloads while a permission prompt is open.
chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId !== windowId) return;
  targetRevision++; activeTab = undefined; render(); void refresh();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== activeTab?.id || (change.url === undefined && change.status !== 'loading')) return;
  targetRevision++; activeTab = undefined; render(); void refresh();
});

function openControls() { dialog.showModal(); }
element('browser-settings').onclick = openControls;
element('close-controls').onclick = () => dialog.close();
element('settings').onclick = () => {
  const opening = element('setup').hidden;
  element('setup').hidden = !opening;
  element('frame-wrap').hidden = opening || !channel;
  element('browser-bar').hidden = opening || !channel;
  element('settings').textContent = opening && channel ? '返回聊天' : '设置';
};
element('reload').onclick = () => { if (relayOrigin) loadChat(relayOrigin); };
element<HTMLFormElement>('open-form').onsubmit = (event) => {
  event.preventDefault();
  if (busy) return;
  element('setup-error').textContent = '';
  let origin: string;
  try { origin = serverOrigin(address.value); }
  catch (error) { element('setup-error').textContent = error instanceof Error ? error.message : '地址无效'; return; }
  // Request from this explicit click, before yielding the user gesture.
  const permission = chrome.permissions.request({ origins: [`${origin}/*`] });
  busy = true; element<HTMLButtonElement>('open-chat').disabled = true;
  void permission.then(async (allowed) => {
    if (!allowed) throw new Error('需要允许访问你的 Anywhere 站点，才能在侧栏打开聊天并复用 Web 配对。');
    await chrome.storage.local.set({ panelOrigin: origin });
    address.value = origin; loadChat(origin);
  }).catch((error) => { element('setup-error').textContent = error instanceof Error ? error.message : '打开失败，请重试'; })
    .finally(() => { busy = false; element<HTMLButtonElement>('open-chat').disabled = false; render(); });
};

grant.onclick = () => {
  const selected = currentSelection();
  const tab = activeTab;
  if (busy || !selected || !tab?.url || !/^https?:\/\//.test(tab.url) || tab.id === undefined || windowId === undefined) return;
  if (state.origin !== relayOrigin || !state.relayOnline) { openControls(); return; }
  const expectedTarget = targetRevision;
  const expectedChannel = channel;
  // Unlike clicking the toolbar action, clicking inside a side panel does not
  // acquire activeTab. Ask for this site's access in the explicit user gesture.
  const site = new URL(tab.url);
  const permission = chrome.permissions.request({ origins: [`${site.protocol}//${site.hostname}/*`] });
  busy = true; operationError = ''; render();
  void permission.then(async (allowed) => {
    if (!allowed) throw new Error('未允许当前站点访问，页面尚未授权。可再次点击「授权当前页」重试。');
    const latest = currentSelection();
    if (channel !== expectedChannel || targetRevision !== expectedTarget || activeTab?.id !== tab.id || activeTab?.url !== tab.url
      || latest?.environmentId !== selected.environmentId || latest?.threadId !== selected.threadId) {
      throw new Error('页面或当前会话已变化，请确认后重新点击「授权当前页」。');
    }
    return chrome.runtime.sendMessage({ type: 'panel.grant', relayOrigin,
      environmentId: selected.environmentId, threadId: selected.threadId,
      tabId: tab.id, windowId, url: tab.url,
    });
  }).then((response) => {
    if (!response.ok) throw new Error(response.error);
    state = response.result;
  }).catch((error) => { operationError = error instanceof Error ? error.message : '授权失败，请重试'; })
    .finally(() => { busy = false; void refresh(); render(); });
};
element('revoke').onclick = () => {
  if (busy) return;
  busy = true; operationError = ''; render();
  void chrome.runtime.sendMessage({ type: 'revoke' }).then((response) => {
    if (!response.ok) throw new Error(response.error);
    state = response.result;
  }).catch((error) => { operationError = error instanceof Error ? error.message : '撤销失败，请重试'; })
    .finally(() => { busy = false; void refresh(); render(); });
};

element('extension-origin').textContent = `chrome-extension://${chrome.runtime.id}`;
const manifest = chrome.runtime.getManifest();
element('build-info').textContent = manifest.version_name || manifest.version;
void (async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  const saved = await chrome.storage.local.get(['panelOrigin', 'origin']);
  try {
    const origin = serverOrigin(String(saved.panelOrigin || saved.origin || ''));
    address.value = origin;
    if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) loadChat(origin);
  } catch { /* First run stays on the setup screen. */ }
  await refresh();
  setInterval(() => { void refresh(); render(); }, 1500);
})().catch(() => { element('setup-error').textContent = '侧栏初始化失败，请重新打开插件。'; });
