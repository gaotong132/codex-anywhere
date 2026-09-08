import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedTabLifecycle } from '../src/managed-tab-lifecycle.js';
import type { Binding } from '../src/page-binding.js';

function harness(t: test.TestContext) {
  const original = globalThis.chrome;
  const bindings = new Map<number, Binding>();
  for (let tabId = 1; tabId <= 7; tabId++) bindings.set(tabId, {
    grantId: `grant-${tabId}`, threadId: 'task', environmentId: 'pc', title: 'Fixture', sequence: 0, lastUsedAt: tabId,
    target: { browserDeviceId: 'browser', tabId, documentId: `doc-${tabId}`, origin: 'https://example.com' },
    ...(tabId === 1 ? {} : { rootTabId: 1 }),
  });
  const removed: number[] = [], activated: number[] = [], busy = new Set<Binding>();
  let generation = 0, onInspect = async (_tabId: number) => {}, onGet = async (_tabId: number) => {};
  globalThis.chrome = {
    scripting: { executeScript: async (input: any) => {
      await onInspect(input.target.tabId);
      return [{ documentId: input.target.documentIds[0], result: { canClose: true } }];
    } },
    tabs: {
      get: async (tabId: number) => { await onGet(tabId); return { id: tabId, windowId: 1, url: 'https://example.com/child' }; },
      update: async (tabId: number) => { activated.push(tabId); },
      remove: async (tabId: number) => { removed.push(tabId); },
    },
  } as any;
  const lifecycle = new ManagedTabLifecycle({ bindings, busy, connected: () => true, generation: () => generation,
    persist: async () => {}, revoke: async binding => { if (bindings.get(binding.target.tabId) === binding) bindings.delete(binding.target.tabId); } });
  t.after(() => { globalThis.chrome = original; });
  return { bindings, busy, lifecycle, removed, activated, root: bindings.get(1)!, inspect: (fn: typeof onInspect) => { onInspect = fn; },
    get: (fn: typeof onGet) => { onGet = fn; }, changeSession: () => generation++ };
}

test('cleanup never closes a child used, rebound or disconnected while the final edit check awaits', async t => {
  const h = harness(t);
  for (const change of ['used', 'rebound', 'session'] as const) {
    const old = h.bindings.get(2)!; let checks = 0;
    h.inspect(async id => {
      if (id !== 2 || ++checks !== 2) return;
      if (change === 'used') old.lastUsedAt = 100;
      else if (change === 'rebound') h.bindings.set(2, { ...old });
      else h.changeSession();
    });
    await h.lifecycle.prune();
    assert.deepEqual(h.removed, []);
    assert.equal(h.lifecycle.retiring.size, 0);
    h.bindings.get(2)!.lastUsedAt = 2;
  }
  h.inspect(async () => {});
  await h.lifecycle.prune();
  assert.deepEqual(h.removed, [2], 'later cleanup still works and retains five ordinary children');
});

test('reuse cannot activate a replaced grant and a stalled read cannot block the source operation', async t => {
  const h = harness(t);
  for (const id of [3, 4, 5, 6, 7]) h.bindings.delete(id);
  h.inspect(async id => { const old = h.bindings.get(id)!; h.bindings.set(id, { ...old }); });
  assert.equal(await h.lifecycle.reuse('https://example.com/child', h.root, () => true, Date.now() + 1000), null);
  assert.deepEqual(h.activated, []);
  h.inspect(async () => {});
  h.get(() => new Promise<void>(() => {}));
  await assert.rejects(h.lifecycle.reuse('https://example.com/child', h.root, () => true, Date.now() + 30), /browser_operation_timeout/);
  assert.deepEqual(h.activated, []);
});
