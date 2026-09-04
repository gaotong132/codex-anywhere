import './popup.css';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const url = element<HTMLInputElement>('url');
const environment = element<HTMLSelectElement>('environment');
const session = element<HTMLSelectElement>('session');
const manifest = chrome.runtime.getManifest();
element('build-info').textContent = manifest.version_name || manifest.version;
let pending = 0;
let signature = '';
let acting = false;
let lastState: any;
function controls() {
  element<HTMLButtonElement>('connect').disabled = acting;
  environment.disabled = acting;
  session.disabled = acting;
  element<HTMLButtonElement>('grant').disabled = acting || !lastState?.connected || !session.value;
}
function render(state: any) {
  lastState = state;
  element('status').textContent = state.error || (state.connecting ? '正在连接…' : state.connected ? '端到端加密连接' : state.relayOnline ? '请选择在线运行环境' : '尚未连接');
  element('setup').hidden = state.relayOnline || state.connecting;
  element('selection').hidden = !state.relayOnline || Boolean(state.binding) || state.connecting;
  element('authorized').hidden = !state.binding;
  element('cancel').hidden = !state.connecting;
  element('extension-origin').textContent = state.extensionOrigin;
  if (!url.value && state.origin) url.value = state.origin;
  if (state.binding) {
    element('task').textContent = state.binding.title;
    element('page').textContent = state.binding.origin;
    element('authorized').querySelector('h1')!.textContent = state.connected ? '已连接到会话' : '已授权 · 当前离线';
  }
  const next = JSON.stringify([state.devices, state.environmentId, state.sessions]);
  if (signature !== next) {
    signature = next;
    const oldSession = session.value;
    environment.replaceChildren(...state.devices.map((id: string) => new Option(id, id)));
    environment.value = state.environmentId;
    session.replaceChildren(new Option('选择已有会话…', ''), ...state.sessions.map((item: any) => new Option(item.title, item.id)));
    if (state.sessions.some((item: any) => item.id === oldSession)) session.value = oldSession;
  }
  controls();
}
async function command(type: string, payload: object = {}) {
  const revision = ++pending; acting = true;
  controls();
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (revision !== pending) return;
    if (!response.ok) throw new Error(response.error);
    if (type === 'connect') url.value = '';
    render(response.result);
  } catch (error) {
    if (revision === pending) {
      if (lastState && (type === 'environment' || type === 'connect')) lastState = { ...lastState, connected: false };
      element('status').textContent = error instanceof Error ? error.message : '操作未完成，请重试';
    }
  }
  finally { if (revision === pending) { acting = false; controls(); } }
}
element('connect').onclick = () => { element('cancel').hidden = false; void command('connect', { url: url.value }); };
element('cancel').onclick = () => void command('cancel');
element('grant').onclick = () => void command('grant', { threadId: session.value });
element('revoke').onclick = () => void command('revoke');
element('disconnect').onclick = () => void command('disconnect');
environment.onchange = () => void command('environment', { environmentId: environment.value });
session.onchange = controls;
void command('status');
setInterval(() => {
  if (acting) return;
  const revision = pending;
  void chrome.runtime.sendMessage({ type: 'status' }).then((response) => { if (revision === pending && response.ok) render(response.result); }).catch(() => {});
}, 1500);
