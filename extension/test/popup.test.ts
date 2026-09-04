import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';

test('compiled popup locks stale selection during an environment switch and recovers after failure', async () => {
  const { document } = parseHTML(await readFile('extension/dist/popup.html', 'utf8'));
  // LinkeDOM does not implement a writable HTMLSelectElement.value.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', { writable: true, value: '' });
  const base = { connected: true, relayOnline: true, devices: ['pc', 'ecs'], environmentId: 'pc',
    sessions: [{ id: 'test-task', title: 'Test task' }], extensionOrigin: 'chrome-extension://fixture' };
  let settle: ((value: unknown) => void) | undefined;
  const manifest = JSON.parse(await readFile('extension/dist/manifest.json', 'utf8'));
  const context = createContext({ document, setInterval: () => 0,
    MutationObserver: class { observe() {} },
    Option: function(text: string, value: string) { const option = document.createElement('option'); option.textContent = text; option.value = value; return option; },
    chrome: { runtime: { getManifest: () => manifest, sendMessage: (message: { type: string }) => message.type === 'status'
      ? Promise.resolve({ ok: true, result: base }) : new Promise((resolve) => { settle = resolve; }) } },
  });
  runInContext(await readFile('extension/dist/popup.js', 'utf8'), context);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  assert.equal(document.querySelector('#build-info')!.textContent, manifest.version_name);
  const session = document.querySelector('#session') as HTMLSelectElement;
  const environment = document.querySelector('#environment') as HTMLSelectElement;
  const grant = document.querySelector('#grant') as HTMLButtonElement;
  session.value = 'test-task'; session.onchange!(new Event('change'));
  assert.equal(grant.disabled, false);
  environment.value = 'ecs'; environment.onchange!(new Event('change'));
  assert.equal(grant.disabled, true);
  assert.equal(session.disabled, true);
  assert.equal(environment.disabled, true);
  assert.equal((document.querySelector('#cancel') as HTMLButtonElement).disabled, false);
  settle!({ ok: false, error: 'Test connection failed' }); await tick();
  assert.equal(environment.disabled, false);
  assert.equal(grant.disabled, true);
  assert.match(document.querySelector('#status')!.textContent!, /Test connection failed/);
});

test('child permission is requested only on its explicit button, for the exact root site', async () => {
  const { document } = parseHTML(await readFile('extension/dist/popup.html', 'utf8'));
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', { writable: true, value: '' });
  const state = { connected: true, relayOnline: true, devices: ['pc'], environmentId: 'pc', sessions: [], childPermission: false,
    binding: { title: 'Root', origin: 'https://example.com', sitePermissionPattern: 'https://example.com/*' } };
  const requested: any[] = [];
  let allow = false;
  const context = createContext({ document, setInterval: () => 0, MutationObserver: class { observe() {} },
    Option: function(text: string, value: string) { const option = document.createElement('option'); option.textContent = text; option.value = value; return option; },
    chrome: { runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async () => ({ ok: true, result: state }) },
      permissions: { request: async (options: any) => { requested.push(options); state.childPermission = allow; return allow; } } } });
  runInContext(await readFile('extension/dist/popup.js', 'utf8'), context);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  await tick(); assert.equal(requested.length, 0);
  const button = document.querySelector('#enable-children') as HTMLButtonElement;
  button.onclick!(new Event('click') as any); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(requested)), [{ origins: ['https://example.com/*'] }]);
  assert.match(document.querySelector('#status')!.textContent!, /起始页仍可正常使用/);
  assert.equal(button.disabled, false);
  allow = true; button.onclick!(new Event('click') as any); await tick();
  assert.equal(button.disabled, true); assert.equal(button.textContent, '已允许同站子页');
});
