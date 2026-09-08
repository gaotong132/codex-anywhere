import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireDebugger, releaseDebugger, releaseAllDebuggers, onDebuggerCancellation } from '../src/debugger-session.js';

const target = { tabId: 17, documentId: 'document-a', origin: 'https://example.com', browserDeviceId: 'fixture' };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(t: test.TestContext) {
  const previous = globalThis.chrome;
  const calls: string[] = [];
  let current = true, failAttach = false, attaching = async () => {}, detached = (_source: { tabId?: number }, _reason: string) => {};
  globalThis.chrome = { debugger: {
    attach: async () => { calls.push('attach'); if (failAttach) throw Error('another debugger'); await attaching(); },
    detach: async () => { calls.push('detach'); },
    onDetach: { addListener: (fn: typeof detached) => { detached = fn; } },
  } } as any;
  t.after(async () => { onDebuggerCancellation(() => {}); await releaseAllDebuggers(); globalThis.chrome = previous; });
  return { calls, acquire: (next = target) => acquireDebugger(next, Date.now() + 5000, () => current),
    revoke: () => { current = false; }, fail: () => { failAttach = true; },
    attaching: (fn: () => Promise<void>) => { attaching = fn; }, manualDetach: () => detached({ tabId: 17 }, 'canceled_by_user') };
}

test('same-document operations reuse the debugger and the idle deadline refreshes', async t => {
  const h = harness(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = await h.acquire(); a.release();
  t.mock.timers.tick(59_000); await settle(); assert.deepEqual(h.calls, ['attach']);
  const b = await h.acquire(); b.release();
  t.mock.timers.tick(59_000); await settle(); assert.deepEqual(h.calls, ['attach']);
  t.mock.timers.tick(1000); await settle(); assert.deepEqual(h.calls, ['attach', 'detach']);
  assert.equal(a.current(), false);
});

test('navigation and stale cleanup cannot reuse or detach a newer document debugger', async t => {
  const h = harness(t), a = await h.acquire(); a.release();
  const b = await h.acquire({ ...target, documentId: 'document-b' });
  assert.deepEqual(h.calls, ['attach', 'detach', 'attach']);
  await a.close(); assert.equal(b.current(), true); assert.equal(h.calls.length, 3);
  await b.close(); assert.equal(h.calls.at(-1), 'detach');
});

test('revoke releases a debugger, and an ungranted target never attaches', async t => {
  const h = harness(t), lease = await h.acquire();
  h.revoke(); lease.release(); await settle();
  assert.deepEqual(h.calls, ['attach', 'detach']);
  await assert.rejects(h.acquire(), /document_changed/);
  assert.equal(h.calls.length, 2);
});

test('revocation during attachment closes a late attachment without providing a usable lease', async t => {
  const h = harness(t); let finish!: () => void;
  h.attaching(() => new Promise<void>(resolve => { finish = resolve; }));
  const acquiring = h.acquire(); await settle(); h.revoke();
  const closing = releaseDebugger(17); finish();
  await assert.rejects(acquiring, /document_changed/); await closing;
  assert.deepEqual(h.calls, ['attach', 'detach']);
});

test('user detach invalidates old leases and an attach conflict never detaches its owner', async t => {
  const h = harness(t), cancelledTabs: number[] = [];
  onDebuggerCancellation(tabId => cancelledTabs.push(tabId));
  const lease = await h.acquire(); lease.release(); h.manualDetach();
  assert.deepEqual(cancelledTabs, [17]);
  assert.equal(lease.current(), false);
  h.fail(); await assert.rejects(h.acquire(), /native_click_unavailable/);
  await lease.close(); assert.deepEqual(h.calls, ['attach', 'attach']);
});
