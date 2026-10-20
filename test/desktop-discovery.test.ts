import assert from 'node:assert/strict';
import test from 'node:test';
import { internals } from '../src/connector/codex-desktop.js';

test('new Desktop app-tools hosts are discovered without touching browser-only hosts', async () => {
  const calls: string[] = [];
  const client = { close: () => assert.fail('chosen host must stay connected') };
  const result = await internals.discoverDesktopClient([
    'codex-browser-use-older', 'codex-ipc', 'codex-app-tools-current',
  ], async name => { calls.push(name); return client; });
  assert.equal(result, client);
  assert.deepEqual(calls, ['codex-app-tools-current']);
});

test('unsupported or stale app hosts fall back to a capability-checked legacy host', async () => {
  const calls: string[] = [];
  const client = { close() {} };
  const result = await internals.discoverDesktopClient([
    'codex-app-tools-stale', 'codex-browser-use-only-browser', 'codex-browser-use-legacy',
  ], async name => { calls.push(name); return name.endsWith('-legacy') ? client : null; });
  assert.equal(result, client);
  assert.deepEqual(calls, ['codex-app-tools-stale', 'codex-browser-use-only-browser', 'codex-browser-use-legacy']);
});

test('legacy Desktop versions still work when there is no dedicated app host', async () => {
  const client = { close() {} };
  assert.equal(await internals.discoverDesktopClient(['codex-browser-use-legacy'], async () => client), client);
});

test('discovery closes extra successful probes and ignores unrelated pipes', async () => {
  const closed: string[] = [];
  const calls: string[] = [];
  const clients = new Map<string, { close(): void }>();
  const result = await internals.discoverDesktopClient([
    'codex-app-tools-first', 'codex-app-tools-second', 'other-app-tools-host', 'codex-app-tools',
  ], async name => {
    calls.push(name);
    const client = { close: () => { closed.push(name); } };
    clients.set(name, client); return client;
  });
  assert.equal(result, clients.get('codex-app-tools-first'));
  assert.deepEqual(calls, ['codex-app-tools-first', 'codex-app-tools-second']);
  assert.deepEqual(closed, ['codex-app-tools-second']);
  assert.equal(await internals.discoverDesktopClient(['unrelated'], async () => assert.fail()), null);
  assert.equal(await internals.discoverDesktopClient(['codex-app-tools-no-capability'], async () => null), null);
});
