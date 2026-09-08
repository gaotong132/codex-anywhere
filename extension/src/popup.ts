import './popup.css';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const url = element<HTMLInputElement>('url');
const manifest = chrome.runtime.getManifest();
element('build-info').textContent = manifest.version_name || manifest.version;
let pending = 0;
let acting = false;
let lastState: any;
function controls() {
  element<HTMLButtonElement>('connect').disabled = acting;
  element<HTMLButtonElement>('enable-children').disabled = acting || !lastState?.binding || lastState?.childPermission;
}
function render(state: any) {
  lastState = state;
  element('status').textContent = state.error || (state.connecting ? '正在连接…' : state.relayOnline ? '页面控制已连接' : '尚未连接');
  element('setup').hidden = state.relayOnline || state.connecting;
  element('ready').hidden = !state.relayOnline || Boolean(state.binding) || state.connecting;
  element('authorized').hidden = !state.binding;
  element('cancel').hidden = !state.connecting;
  element('extension-origin').textContent = state.extensionOrigin;
  if (!url.value && state.origin) url.value = state.origin;
  if (state.binding) {
    element('task').textContent = state.binding.title;
    element('page').textContent = state.binding.origin;
    element('authorized').querySelector('h1')!.textContent = state.connected ? '起始页已授权' : '已授权 · 当前离线';
    element('children-status').textContent = `AI 纳管子页：${state.childCount || 0} 个。${state.currentManaged ? '' : '当前标签页不在授权范围内。'}`;
    element('enable-children').textContent = state.childPermission ? '已允许同站子页' : '允许 AI 打开的同站子页';
  }
  controls();
}
async function command(type: string, payload: object = {}) {
  const revision = ++pending; acting = true;
  controls();
  try {
    if (type === 'enable-children') {
      // Called synchronously from the button handler: Chrome requires a user gesture.
      const granted = await chrome.permissions.request({ origins: [lastState.binding.sitePermissionPattern] });
      if (!granted) throw new Error('未允许同站子页，起始页仍可正常使用。');
    }
    const response = await chrome.runtime.sendMessage({ type: type === 'enable-children' ? 'status' : type, ...payload });
    if (revision !== pending) return;
    if (!response.ok) throw new Error(response.error);
    if (type === 'connect') url.value = '';
    render(response.result);
  } catch (error) {
    if (revision === pending) {
      element('status').textContent = error instanceof Error ? error.message : '操作未完成，请重试';
    }
  }
  finally { if (revision === pending) { acting = false; controls(); } }
}
element('connect').onclick = () => { element('cancel').hidden = false; void command('connect', { url: url.value }); };
element('cancel').onclick = () => void command('cancel');
element('revoke').onclick = () => void command('revoke');
element('enable-children').onclick = () => void command('enable-children');
element('disconnect').onclick = () => void command('disconnect');
void command('status');
setInterval(() => {
  if (acting) return;
  const revision = pending;
  void chrome.runtime.sendMessage({ type: 'status' }).then((response) => { if (revision === pending && response.ok) render(response.result); }).catch(() => {});
}, 1500);
