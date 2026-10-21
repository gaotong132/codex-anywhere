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

test('native pushes apply approvals immediately and reduce polling while preserving periodic verification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const applied: PendingApprovals[] = [];
  const poller = createApprovalPoller({
    read: async () => { reads++; return { approvals: [], desktopState: { status: 'active', waitingOnApproval: false } }; },
    apply: value => applied.push(value), onError: () => assert.fail('unexpected failure'),
  });
  try {
    poller.push({ approvals: [{ approvalId: 'native-request', threadId: 'fixture', kind: 'command' }],
      desktopState: { status: 'active', waitingOnApproval: true } });
    assert.equal(applied[0].approvals[0].approvalId, 'native-request');
    await poller.refresh();
    t.mock.timers.tick(4000);
    assert.equal(reads, 1);
    t.mock.timers.tick(11000);
    await poller.refresh();
    assert.equal(reads, 2, 'push does not eliminate recovery checks');
  } finally { poller.stop(); }
});
