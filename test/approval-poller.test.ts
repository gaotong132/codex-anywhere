import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalPoller, resolvedDesktopExecution } from '../web/src/approval-poller.js';
import type { PendingApprovals } from '../web/src/app-types.js';

test('approval polling retries a failed read and manual refresh shares an in-flight request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let errors = 0;
  const applied: PendingApprovals[] = [];
  const poller = createApprovalPoller({
    read: async () => { if (++reads === 1) throw new Error('transient'); return { approvals: [] }; },
    apply: (result) => applied.push(result), onError: () => { errors++; },
  });
  try {
    const first = poller.refresh();
    assert.equal(poller.refresh(), first);
    await first;
    assert.equal(errors, 1);
    t.mock.timers.tick(4_000);
    await poller.refresh();
    assert.equal(reads, 2);
    assert.deepEqual(applied, [{ approvals: [] }]);
  } finally { poller.stop(); }
});

test('changing sessions discards late approval results and stops old polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (value: PendingApprovals) => void;
  let reads = 0;
  const poller = createApprovalPoller({
    read: () => { reads++; return new Promise(resolve => { complete = resolve; }); },
    apply: () => assert.fail('obsolete session result'), onError: () => assert.fail('obsolete error'),
  });
  const pending = poller.refresh();
  await Promise.resolve();
  poller.stop();
  complete({ approvals: [] });
  await pending;
  t.mock.timers.tick(30_000);
  await poller.refresh();
  assert.equal(reads, 1);
});

test('resolved Desktop approval follows actual execution status without inventing a running turn', () => {
  for (const status of ['idle', 'completed', 'notLoaded']) {
    assert.equal(resolvedDesktopExecution({ approvals: [], desktopState: { status, waitingOnApproval: false } }), 'completed');
  }
  assert.equal(resolvedDesktopExecution({ approvals: [], desktopState: { status: 'active', waitingOnApproval: false } }), 'running');
  assert.equal(resolvedDesktopExecution({ approvals: [], desktopState: { status: 'error', waitingOnApproval: false } }), 'failed');
  assert.equal(resolvedDesktopExecution({ approvals: [], desktopStatusUnavailable: true }), null);
  assert.equal(resolvedDesktopExecution({ approvals: [], desktopState: { status: 'unknown', waitingOnApproval: false } }), null);
});
