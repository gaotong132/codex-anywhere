import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeRequestManager } from '../web/src/bridge-request-manager.js';

test('bridge request manager owns request acknowledgement, replay, and cleanup', async () => {
  const sent: Record<string, unknown>[] = [];
  const manager = new BridgeRequestManager({
    isConnected: () => true,
    send: (frame) => { sent.push(frame); return true; },
    createId: () => 'request-1',
  });
  const response = manager.request<{ sessions: unknown[] }>('sessions.list', {}, { timeoutMs: null });
  assert.equal(manager.size, 1);
  assert.equal(manager.handle({ type: 'ack', requestId: 'request-1' }), true);
  assert.equal(manager.replay(), 1);
  assert.equal(sent.length, 2);
  assert.equal(manager.handle({
    type: 'response', requestId: 'request-1', ok: true, data: { sessions: [] },
  }), true);
  assert.deepEqual(await response, { sessions: [] });
  assert.equal(manager.size, 0);
});

test('bridge request manager rejects failed, aborted, and disconnected requests without leaks', async () => {
  let connected = true;
  let sequence = 0;
  const manager = new BridgeRequestManager({
    isConnected: () => connected,
    send: () => true,
    createId: () => `request-${++sequence}`,
  });

  const failed = manager.request('session.rename', {}, { timeoutMs: null });
  manager.handle({ type: 'response', requestId: 'request-1', ok: false, error: 'rename_failed' });
  await assert.rejects(failed, /rename_failed/);

  const controller = new AbortController();
  const aborted = manager.request('file.download.chunk', {}, {
    timeoutMs: null, signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, /download_cancelled/);

  const pending = manager.request('sessions.list', {}, { timeoutMs: null });
  manager.rejectAll('environment_changed');
  await assert.rejects(pending, /environment_changed/);

  connected = false;
  await assert.rejects(
    manager.request('sessions.list', {}, { timeoutMs: null }),
    /连接未建立|Connection is not established/,
  );
  assert.equal(manager.size, 0);
});
