import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeRequestManager } from '../web/src/bridge-request-manager.js';
import { friendlyError } from '../web/src/app-utils.js';
import type { FrameSendOptions } from '../web/src/websocket-send.js';

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

test('slow responses complete within the extended ordinary and image budgets without resending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [action, delay] of [
    ['sessions.list', 45_000], ['attachment.upload', 119_000], ['attachment.read', 119_000], ['turn.start', 120_000],
  ] as const) {
    const sent: unknown[] = [];
    const manager = new BridgeRequestManager({ isConnected: () => true,
      send: (frame) => { sent.push(frame); return true; }, createId: () => action });
    const response = manager.request(action, {});
    manager.handle({ type: 'ack', requestId: action });
    t.mock.timers.tick(delay);
    assert.equal(manager.size, 1, `${action} still awaits its response`);
    manager.handle({ type: 'response', requestId: action, ok: true, data: { complete: true } });
    assert.deepEqual(await response, { complete: true });
    t.mock.timers.tick(11 * 60_000);
    assert.equal(manager.size, 0);
    assert.equal(sent.length, 1);
  }
});

test('expired requests report their actual limit, clean up and ignore late responses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [action, timeoutMs] of [['sessions.list', 60_000], ['attachment.upload', 120_000], ['attachment.read', 120_000]] as const) {
    let sends = 0;
    const manager = new BridgeRequestManager({ isConnected: () => true,
      send: () => { sends++; return true; }, createId: () => action });
    const rejected = assert.rejects(manager.request(action, {}), (error: Error) => {
      assert.equal(error.message, 'request_timeout');
      assert.match(friendlyError(error), new RegExp(`${timeoutMs / 1000} (?:秒|seconds)`));
      return true;
    });
    manager.handle({ type: 'ack', requestId: action });
    t.mock.timers.tick(timeoutMs - 1);
    assert.equal(manager.size, 1);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(manager.size, 0);
    manager.handle({ type: 'response', requestId: action, ok: true, data: {} });
    assert.equal(manager.size, 0);
    assert.equal(sends, 1);
  }
});

test('explicit request limits and unlimited waits still override defaults', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sequence = 0;
  const manager = new BridgeRequestManager({ isConnected: () => true, send: () => true,
    createId: () => `custom-${++sequence}` });
  const rejected = assert.rejects(manager.request('attachment.upload', {}, { timeoutMs: 1500 }), (error: Error) => {
    assert.match(friendlyError(error), /2 (?:秒|seconds)/);
    return true;
  });
  t.mock.timers.tick(1500);
  await rejected;
  const unlimited = manager.request('attachment.read', {}, { timeoutMs: null });
  t.mock.timers.tick(12 * 60_000);
  assert.equal(manager.size, 1);
  manager.handle({ type: 'response', requestId: 'custom-2', ok: true, data: 'complete' });
  assert.equal(await unlimited, 'complete');
  assert.doesNotMatch(friendlyError(new Error('request_timeout')), /30/);
});

test('upload progress survives replay and stops after timeout or completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts: FrameSendOptions[] = [];
  const percentages: number[] = [];
  let sequence = 0;
  const manager = new BridgeRequestManager({ isConnected: () => true,
    send: (_frame, options) => { attempts.push(options!); return true; }, createId: () => `upload-${++sequence}` });
  const response = manager.request('attachment.upload', {}, { onUploadProgress: (p) => percentages.push(p.sentBytes) });
  attempts[0].onProgress({ sentBytes: 20, totalBytes: 100 });
  assert.equal(manager.replay(), 1);
  assert.equal(attempts[0].signal.aborted, true);
  attempts[0].onProgress({ sentBytes: 90, totalBytes: 100 });
  attempts[1].onProgress({ sentBytes: 30, totalBytes: 100 });
  assert.deepEqual(percentages, [20, 30]);
  manager.handle({ type: 'response', requestId: 'upload-1', ok: true, data: {} });
  await response;
  assert.equal(attempts[1].signal.aborted, true);
  attempts[1].onProgress({ sentBytes: 100, totalBytes: 100 });
  assert.deepEqual(percentages, [20, 30]);
  const rejected = assert.rejects(manager.request('attachment.upload', {}, { onUploadProgress: () => {} }), /request_timeout/);
  t.mock.timers.tick(120_000);
  await rejected;
  assert.equal(attempts[2].signal.aborted, true);
});
