import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserReadRequest, parseBrowserTarget, parseSnapshotOptions } from '../src/browser-control/contracts.js';
import { BrowserGrantStore } from '../src/browser-control/grants.js';
import { ReadonlyBrowserController, type BrowserSnapshotDriver } from '../src/browser-control/readonly-controller.js';
import { parseCodexBrowserSnapshotCall } from '../src/browser-control/codex-context.js';

const owner = { environmentId: 'ecs-test', threadId: 'task-a', controllerId: 'controller-a' };
const target = { browserDeviceId: 'browser-a', tabId: 7, documentId: 'document-a', origin: 'https://example.com' };
const snapshot = { origin: target.origin, nodes: [{ tag: 'p', text: 'Test page' }], truncated: false };

function fixture(ttlMs = 600_000) {
  let now = 100_000;
  let id = 0;
  const store = new BrowserGrantStore({ now: () => now, createId: () => `grant-${++id}` });
  const grant = store.issue(owner, target, ttlMs);
  const request = {
    version: 1, requestId: 'request-a', grantId: grant.id, sequence: 1,
    deadline: now + Math.min(10_000, ttlMs), method: 'browser.snapshot', params: {},
  };
  return { store, grant, request, advance: (ms: number) => { now += ms; } };
}

test('browser contracts reject unsupported methods, identity overrides and malformed bounds', () => {
  const { request } = fixture();
  assert.deepEqual(parseBrowserReadRequest(request).params, { maxNodes: 100, maxChars: 8_000 });
  for (const override of [{ version: 0 }, { method: 'browser.click' }, { method: 'browser.evaluate' }, { threadId: 'task-b' }, { sequence: 1.2 }, { deadline: '110000' }]) {
    assert.throws(() => parseBrowserReadRequest({ ...request, ...override }));
  }
  for (const options of [{ threadId: 'task-b' }, { maxNodes: 0 }, { maxChars: 16_001 }, { maxNodes: '100' }, []]) {
    assert.throws(() => parseSnapshotOptions(options));
  }
  for (const origin of ['file:///private', 'chrome://settings', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?secret=test']) {
    assert.throws(() => parseBrowserTarget({ ...target, origin }));
  }
});

test('browser grants bind every owner and document coordinate independently', () => {
  for (const changedOwner of [{ ...owner, threadId: 'task-b' }, { ...owner, environmentId: 'pc-test' }, { ...owner, controllerId: 'controller-b' }]) {
    const { store, request } = fixture();
    assert.throws(() => store.authorize(changedOwner, target, request), /not_authorized/);
    store.authorize(owner, target, request); // Unauthorized attempts do not consume the sequence.
  }
  for (const changedTarget of [{ ...target, tabId: 8 }, { ...target, browserDeviceId: 'browser-b' }, { ...target, documentId: 'document-b' }, { ...target, origin: 'https://example.org' }]) {
    const { store, request } = fixture();
    assert.throws(() => store.authorize(owner, changedTarget, request), /not_authorized/);
  }
});

test('browser grants are immutable, exclusive and memory bounded', () => {
  const { store, grant } = fixture();
  assert.ok(Object.isFrozen(grant) && Object.isFrozen(grant.owner) && Object.isFrozen(grant.target));
  assert.throws(() => store.issue({ ...owner, threadId: 'task-b' }, target), /already_granted/);
  let id = 0;
  const small = new BrowserGrantStore({ createId: () => `grant-${++id}`, maxGrants: 1 });
  small.issue(owner, target);
  assert.throws(() => small.issue(owner, { ...target, tabId: 8 }), /grant_limit/);
  small.close();
  small.issue(owner, target);
});

test('browser requests reject replay, gaps, long deadlines and expired grants', () => {
  const { store, request, advance } = fixture();
  assert.throws(() => store.authorize(owner, target, { ...request, sequence: 2 }), /out_of_order/);
  assert.throws(() => store.authorize(owner, target, { ...request, deadline: 120_000 }), /expired/);
  store.authorize(owner, target, request);
  assert.throws(() => store.authorize(owner, target, request), /out_of_order/);
  store.authorize(owner, target, { ...request, sequence: 2, requestId: 'request-b' });
  advance(600_000);
  assert.throws(() => store.authorize(owner, target, { ...request, sequence: 3 }), /not_authorized/);
});

test('revocation aborts outstanding leases and a recreated store cannot restore approval', () => {
  for (const revoke of ['grant', 'owner', 'tab', 'close']) {
    const { store, grant, request } = fixture();
    const lease = store.authorize(owner, target, request);
    if (revoke === 'grant') store.revoke(grant.id);
    if (revoke === 'owner') store.revokeOwner(owner);
    if (revoke === 'tab') store.revokeTab(target.browserDeviceId, target.tabId);
    if (revoke === 'close') store.close();
    assert.equal(lease.signal.aborted, true);
    assert.throws(lease.revalidate, /not_authorized/);
  }
  const { request } = fixture();
  const restored = new BrowserGrantStore({ createId: () => 'other-grant' });
  assert.throws(() => restored.authorize(owner, target, request), /not_authorized/);
});

test('readonly browser execution validates before reading and returns a bounded copy', async () => {
  const { store, request } = fixture();
  let reads = 0;
  const driver: BrowserSnapshotDriver = { currentTarget: async () => target, snapshot: async () => { reads++; return snapshot; } };
  const other = new ReadonlyBrowserController({ ...owner, threadId: 'task-b' }, target, store, driver);
  await assert.rejects(other.execute(request), /not_authorized/);
  assert.equal(reads, 0);
  const result = await new ReadonlyBrowserController(owner, target, store, driver).execute(request);
  assert.deepEqual(result, snapshot);
  assert.notEqual(result.nodes[0], snapshot.nodes[0]);
  assert.equal(reads, 1);
});

test('navigation or revocation during a read prevents returning stale page content', async () => {
  for (const action of ['navigate', 'revoke', 'expire']) {
    const { store, grant, request, advance } = fixture();
    let actual = target;
    const control = new ReadonlyBrowserController(owner, target, store, {
      currentTarget: async () => actual,
      snapshot: async () => {
        if (action === 'navigate') actual = { ...target, documentId: 'new-document' };
        if (action === 'revoke') store.revoke(grant.id);
        if (action === 'expire') advance(10_001);
        return snapshot;
      },
    });
    await assert.rejects(control.execute(request), /changed|not_authorized|expired/);
  }
});

test('document discovery is authorized, cancellable and inside the request deadline', async () => {
  for (const action of ['navigate', 'revoke', 'hang']) {
    const { store, grant, request } = fixture();
    let reads = 0;
    let captured: AbortSignal | undefined;
    const control = new ReadonlyBrowserController(owner, target, store, {
      currentTarget: async (signal) => {
        captured = signal;
        if (action === 'navigate') return { ...target, documentId: 'different-document' };
        if (action === 'revoke') queueMicrotask(() => store.revoke(grant.id));
        return new Promise(() => {});
      },
      snapshot: async () => { reads++; return snapshot; },
    });
    await assert.rejects(control.execute({ ...request, deadline: 100_025 }), /changed|expired|not_authorized/);
    assert.equal(reads, 0);
    assert.equal(captured?.aborted, true);
  }
});

test('hung readonly drivers time out and revocation rejects without waiting for them', async () => {
  for (const revoke of [false, true]) {
    const { store, grant, request } = fixture();
    let captured: AbortSignal | undefined;
    const control = new ReadonlyBrowserController(owner, target, store, {
      currentTarget: async () => target,
      snapshot: async (_target, _options, signal) => {
        captured = signal;
        if (revoke) queueMicrotask(() => store.revoke(grant.id));
        return new Promise(() => {});
      },
    });
    await assert.rejects(control.execute({ ...request, deadline: 100_025 }), /expired|not_authorized/);
    assert.equal(captured?.aborted, true);
  }
});

test('oversized or foreign-origin browser snapshots are rejected', async () => {
  for (const invalid of [
    { ...snapshot, origin: 'https://example.org' },
    { ...snapshot, nodes: Array.from({ length: 101 }, () => ({ tag: 'p', text: 'x' })) },
    { ...snapshot, nodes: [{ tag: 'p', text: 'x'.repeat(8_001) }] },
    { ...snapshot, nodes: [{ tag: '<script>', text: 'x' }] },
  ]) {
    const { store, request } = fixture();
    await assert.rejects(new ReadonlyBrowserController(owner, target, store, {
      currentTarget: async () => target, snapshot: async () => invalid,
    }).execute(request), /invalid_snapshot/);
  }
});

test('two task/browser bindings cannot cross even when tab IDs and request IDs match', async () => {
  const { store, request } = fixture();
  const ownerB = { ...owner, threadId: 'task-b' };
  const targetB = { ...target, browserDeviceId: 'browser-b' };
  const grantB = store.issue(ownerB, targetB);
  const requestB = { ...request, grantId: grantB.id };
  const a = new ReadonlyBrowserController(owner, target, store, { currentTarget: async () => target, snapshot: async () => snapshot });
  const b = new ReadonlyBrowserController(ownerB, targetB, store, { currentTarget: async () => targetB, snapshot: async () => ({ ...snapshot, nodes: [{ tag: 'p', text: 'Page B' }] }) });
  await assert.rejects(a.execute(requestB), /not_authorized/);
  await assert.rejects(b.execute(request), /not_authorized/);
  const results = await Promise.all([a.execute(request), b.execute(requestB)]);
  assert.equal(results[0].nodes[0].text, 'Test page');
  assert.equal(results[1].nodes[0].text, 'Page B');
});

test('Codex browser adapter uses the host envelope, not model-supplied task identity', () => {
  const host = { ...owner, turnId: 'turn-a' };
  const call = { threadId: owner.threadId, turnId: host.turnId, callId: 'call-a', namespace: null, tool: 'anywhere_browser_snapshot', arguments: { maxNodes: 20 } };
  assert.deepEqual(parseCodexBrowserSnapshotCall(call, host).owner, owner);
  for (const changed of [{ threadId: 'task-b' }, { turnId: 'turn-b' }, { threadId: undefined }, { arguments: { threadId: 'task-b' } }, { namespace: 'another_namespace' }]) {
    assert.throws(() => parseCodexBrowserSnapshotCall({ ...call, ...changed }, host));
  }
});
