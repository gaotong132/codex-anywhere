import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const extensionId = 'a'.repeat(32);
const origin = 'https://relay.example';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function panelHarness() {
  const { document } = parseHTML(await readFile('extension/dist/sidepanel.html', 'utf8'));
  const frame = document.querySelector('#chat') as HTMLIFrameElement;
  const frameWindow = {};
  Object.defineProperty(frame, 'contentWindow', { value: frameWindow });
  const listeners = new Map<string, (event: any) => void>();
  const timers: Array<() => void> = [];
  const sent: any[] = [];
  const permissions: any[] = [];
  const saved: Record<string, unknown> = { panelOrigin: origin };
  let permitted = true;
  let now = 10000;
  let nonce = 0;
  let openedSettings = 0;
  const dialog = document.querySelector('#control-dialog') as HTMLDialogElement;
  dialog.showModal = () => { openedSettings++; };
  dialog.close = () => {};
  const state = { connected: true, origin, environmentId: 'ecs', binding: null };
  const context = createContext({ document, URL, URLSearchParams, Error,
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => String(++nonce).padStart(32, '0') },
    window: { addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler) },
    setInterval: (callback: () => void) => { timers.push(callback); return timers.length; },
    chrome: { runtime: { id: extensionId, getManifest: () => ({ version_name: 'test-sidepanel' }),
      sendMessage: async (message: any) => { sent.push(message); return { ok: true, result: state }; } },
      windows: { getCurrent: async () => ({ id: 7 }) },
      tabs: { query: async (query: any) => { assert.equal(query.windowId, 7); return [{ id: 11, windowId: 7, url: 'https://page.example/article' }]; } },
      permissions: { contains: async () => permitted, request: async (request: any) => { permissions.push(request); return permitted; } },
      storage: { local: { get: async () => saved, set: async (value: object) => Object.assign(saved, value) } },
    },
  });
  runInContext(await readFile('extension/dist/sidepanel.js', 'utf8'), context);
  await tick();
  const selection = (patch: object = {}) => ({ type: 'anywhere.sidepanel.selection', version: 1,
    channel: new URL(frame.src).searchParams.get('channel'), sequence: 1,
    environmentId: 'ecs', threadId: 'session-a', title: 'Current task', online: true, ...patch });
  const message = (data: object, source: unknown = frameWindow, eventOrigin = origin) => listeners.get('message')!({ data, source, origin: eventOrigin });
  return { document, frame, selection, message, sent, permissions, saved,
    setPermitted: (value: boolean) => { permitted = value; }, openedSettings: () => openedSettings,
    expire: async () => { now += 6000; timers.forEach((timer) => timer()); await tick(); },
  };
}

test('side panel accepts only its own Web frame and fresh channel; a message never grants a page', async () => {
  const h = await panelHarness();
  const grant = h.document.querySelector('#grant') as HTMLButtonElement;
  assert.equal(grant.disabled, true);
  h.message(h.selection(), {}, origin);
  h.message(h.selection(), undefined, 'https://attacker.example');
  h.message(h.selection({ channel: 'f'.repeat(32) }));
  assert.equal(grant.disabled, true);
  h.message(h.selection());
  assert.equal(grant.disabled, false);
  assert.equal(h.sent.filter((message) => message.type === 'panel.grant').length, 0);
  grant.onclick!(new Event('click') as any); await tick();
  const request = h.sent.find((message) => message.type === 'panel.grant');
  assert.equal(request.threadId, 'session-a');
  assert.equal(request.tabId, 11);
  assert.equal(request.windowId, 7);
  h.message(h.selection({ sequence: 1, threadId: 'stale-session' }));
  assert.match(h.document.querySelector('#session-title')!.textContent!, /Current task/);
  await h.expire();
  assert.equal(grant.disabled, true);
  (h.document.querySelector('#reload') as HTMLButtonElement).onclick!(new Event('click') as any);
  assert.equal(grant.disabled, true);
});

test('side panel rejects pairing secrets as saved addresses and handles denied host permission without navigating', async () => {
  const h = await panelHarness();
  const previous = h.frame.src;
  const form = h.document.querySelector('#open-form') as HTMLFormElement;
  const address = h.document.querySelector('#relay-url') as HTMLInputElement;
  address.value = origin + '/#pair=secret';
  form.onsubmit!({ preventDefault() {} } as any); await tick();
  assert.equal(h.permissions.length, 0);
  assert.equal(h.frame.src, previous);
  address.value = 'https://another-relay.example'; h.setPermitted(false);
  form.onsubmit!({ preventDefault() {} } as any); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.permissions)), [{ origins: ['https://another-relay.example/*'] }]);
  assert.equal(h.saved.panelOrigin, origin);
  assert.equal(h.frame.src, previous);
  assert.match(h.document.querySelector('#setup-error')!.textContent!, /需要允许访问/);
});
