import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';

test('page control settings retain pairing but never select an environment, Session or page', async () => {
  const { document } = parseHTML(await readFile('extension/dist/popup.html', 'utf8'));
  const base = { connected: true, relayOnline: true, devices: ['pc', 'ecs'], environmentId: 'pc',
    sessions: [{ id: 'test-task', title: 'Test task' }], extensionOrigin: 'chrome-extension://fixture' };
  const manifest = JSON.parse(await readFile('extension/dist/manifest.json', 'utf8'));
  const context = createContext({ document, setInterval: () => 0,
    MutationObserver: class { observe() {} },
    chrome: { runtime: { getManifest: () => manifest, sendMessage: async (message: { type: string }) => {
      assert.equal(message.type, 'status'); return { ok: true, result: base };
    } } },
  });
  runInContext(await readFile('extension/dist/popup.js', 'utf8'), context);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  assert.equal(document.querySelector('#build-info')!.textContent, manifest.version_name);
  assert.equal(document.querySelector('select'), null);
  assert.equal(document.querySelector('#grant'), null);
  assert.equal((document.querySelector('#ready') as HTMLElement).hidden, false);
  assert.match(document.querySelector('#ready')!.textContent!, /聊天当前选中的会话/);
  assert.equal((document.querySelector('#connect') as HTMLButtonElement).disabled, false);
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
