import './popup.css';
import type { BrowserSnapshot } from '../../src/browser-control/readonly-controller.js';

const grant = document.querySelector<HTMLButtonElement>('#grant')!;
const snapshot = document.querySelector<HTMLButtonElement>('#snapshot')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const status = document.querySelector<HTMLElement>('#status')!;
const output = document.querySelector<HTMLElement>('#output')!;
let authorized = false;
let revision = 0;

async function command(type: string) {
  const request = ++revision;
  grant.disabled = snapshot.disabled = true;
  // Cancellation remains available while tab discovery or reading is pending.
  stop.disabled = type === 'stop' || type === 'status';
  if (type === 'stop') { authorized = false; output.textContent = ''; status.textContent = '正在撤销…'; }
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (request !== revision) return;
    if (!response?.ok) throw new Error(response?.error || '扩展连接已中断，请重新打开。');
    if (type === 'snapshot') {
      const result = response.result as BrowserSnapshot;
      output.textContent = result.nodes.map((node) => `[${node.tag}] ${node.text}`).join('\n')
        + (result.truncated ? '\n\n[内容已截断]' : '');
    } else {
      output.textContent = '';
      authorized = Boolean(response.result.origin);
      status.textContent = authorized ? `本机只读授权：${response.result.origin}` : '尚未授权';
    }
  } catch (error) {
    if (request !== revision) return;
    authorized = false;
    output.textContent = '';
    status.textContent = error instanceof Error ? error.message : '读取失败，请重新授权。';
  } finally {
    if (request === revision) {
      grant.disabled = false;
      snapshot.disabled = stop.disabled = !authorized;
    }
  }
}
grant.addEventListener('click', () => void command('grant'));
snapshot.addEventListener('click', () => void command('snapshot'));
stop.addEventListener('click', () => void command('stop'));
void command('status');
