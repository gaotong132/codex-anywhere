import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalPreviewSession } from '../extension/src/preview-session.js';
import type { BrowserTarget } from '../src/browser-control/contracts.js';
import type { BrowserSnapshot } from '../src/browser-control/readonly-controller.js';

const target = { browserDeviceId: 'preview-browser', tabId: 1, documentId: 'document-a', origin: 'https://example.com' };
const snapshot = { origin: target.origin, nodes: [{ tag: 'p', text: 'Local preview' }], truncated: false };
const forTarget = (target: BrowserTarget) => ({ currentTarget: async () => target, snapshot: async () => snapshot });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('local preview requires approval and loses authority on expiry, navigation and restart', async () => {
  let now = 100_000;
  const driver = { resolveActiveTarget: async () => target, forTarget };
  const session = new LocalPreviewSession(driver, () => now);
  await assert.rejects(session.snapshot(), /not_authorized/);
  assert.equal((await session.grant()).origin, target.origin);
  assert.deepEqual(await session.snapshot(), snapshot);
  session.invalidateTab(99);
  assert.equal(session.status().origin, target.origin);
  session.invalidateTab(target.tabId);
  await assert.rejects(session.snapshot(), /not_authorized/);
  await session.grant();
  now += 600_000;
  assert.equal(session.status().origin, null);
  await assert.rejects(session.snapshot(), /not_authorized/);
  await session.grant();
  await assert.rejects(new LocalPreviewSession(driver).snapshot(), /not_authorized/);
  session.stop();
});

test('stop or navigation during tab discovery cannot revive a delayed grant', async () => {
  for (const navigation of [false, true]) {
    const selected = deferred<void>();
    const discovery = deferred<BrowserTarget>();
    let signal: AbortSignal | undefined;
    const session = new LocalPreviewSession({
      resolveActiveTarget: async (value, selectTab) => {
        signal = value;
        selectTab(target.tabId);
        selected.resolve();
        return discovery.promise;
      }, forTarget,
    });
    const rejected = assert.rejects(session.grant(), /not_authorized/);
    await selected.promise;
    if (navigation) session.invalidateTab(target.tabId); else session.stop();
    await rejected;
    discovery.resolve(target);
    await Promise.resolve();
    assert.equal(signal?.aborted, true);
    assert.equal(session.status().origin, null);
  }
});

test('a late grant failure cannot replace or cancel its successor', async () => {
  const first = deferred<BrowserTarget>();
  const started = deferred<void>();
  let count = 0;
  const other = { ...target, tabId: 2, documentId: 'document-b', origin: 'https://example.org' };
  const session = new LocalPreviewSession({
    resolveActiveTarget: async () => {
      if (++count === 1) { started.resolve(); return first.promise; }
      return other;
    }, forTarget,
  });
  const rejected = assert.rejects(session.grant(), /not_authorized/);
  await started.promise;
  await session.grant();
  await rejected;
  first.reject(new Error('late discovery failure'));
  await Promise.resolve();
  assert.equal(session.status().origin, other.origin);
  session.stop();
});

test('replacing a grant rejects the old read without revoking the new grant', async () => {
  const started = deferred<void>();
  const read = deferred<BrowserSnapshot>();
  const session = new LocalPreviewSession({
    resolveActiveTarget: async () => target,
    forTarget: () => ({ currentTarget: async () => target, snapshot: async () => { started.resolve(); return read.promise; } }),
  });
  await session.grant();
  const rejected = assert.rejects(session.snapshot(), /not_authorized/);
  await started.promise;
  await session.grant();
  await rejected;
  read.resolve(snapshot);
  await Promise.resolve();
  assert.equal(session.status().origin, target.origin);
  session.stop();
});
