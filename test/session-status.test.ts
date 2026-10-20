import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStatusOverlay } from '../src/shared/session-status.js';

test('pushed status wins over a delayed list and clears on completion without touching other rows', () => {
  const overlay = new SessionStatusOverlay();
  const rows = [{ id: 'a', status: 'notLoaded' }, { id: 'b', status: 'idle' }];
  overlay.accept({ revision: 2, threads: [{ id: 'a', status: 'active' }] }, 0);
  assert.equal(overlay.accept({ revision: 1, threads: [{ id: 'a', status: 'idle' }] }, 1), false);
  const running = overlay.apply(rows, '', 1);
  assert.equal(running[0].status, 'active');
  assert.equal(running[1], rows[1]);
  assert.equal(overlay.apply(running, '', 1), running, 'no render needed for identical statuses');
  overlay.accept({ revision: 3, threads: [{ id: 'a', status: 'idle' }] }, 2);
  assert.equal(overlay.apply(running, '', 3)[0].status, 'idle');
  assert.equal(overlay.apply(running, 'a', 3)[0].status, 'active', 'owned turn remains authoritative');
});

test('repeated cached responses cannot keep stale statuses alive; channels have independent revisions', () => {
  const overlay = new SessionStatusOverlay();
  const snapshot = { revision: 8, threads: [{ id: 'a', status: 'active' }] };
  const rows = [{ id: 'a', status: 'notLoaded' }];
  overlay.accept(snapshot, 0);
  overlay.accept(snapshot, 14_000);
  assert.equal(overlay.apply(rows, '', 15_001), rows);
  const reconnected = new SessionStatusOverlay();
  assert.equal(reconnected.accept({ revision: 1, threads: [{ id: 'a', status: 'idle' }] }), true);
  assert.equal(reconnected.apply(rows)[0].status, 'idle');
});
