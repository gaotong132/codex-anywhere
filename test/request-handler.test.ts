import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestHandler } from '../src/connector/request-handler.js';

function createDependencies(overrides = {}) {
  return {
    codex: {
      child: {},
      activeTurn: null,
      listSessions: async () => [],
      readSession: async () => ({}),
      listSessionTurns: async () => ({}),
      startTurn: async () => ({ threadId: 'started-thread' }),
      stopTurn: async () => ({ stopped: true }),
      respondApproval: async () => ({}),
      getControllerThreadId: () => 'controller-thread',
      isLargeSession: async () => false,
      ...overrides.codex,
    },
    desktop: {
      listThreads: async () => [],
      sendMessage: async ({ threadId }) => ({ threadId, delivery: 'desktop' }),
      ...overrides.desktop,
    },
    attachments: {
      save: async () => ({}),
      read: async () => ({}),
      ...overrides.attachments,
    },
    downloads: {
      open: async () => ({}),
      read: async () => ({}),
      close: async () => ({}),
      ...overrides.downloads,
    },
    deviceId: 'personal-pc',
    workspace: 'D:\\project',
  };
}

function request(action, payload = {}) {
  return { action, payload, requestId: 'request-1', clientId: 'client-1' };
}

test('request handler keeps connector routing independent from process startup', async () => {
  const handle = createRequestHandler(createDependencies());
  assert.deepEqual(await handle(request('connector.status')), {
    type: 'response',
    clientId: 'client-1',
    requestId: 'request-1',
    ok: true,
    data: {
      deviceId: 'personal-pc', workspace: 'D:\\project', codexOnline: true, activeTurn: false,
    },
  });
});

test('session listing merges live Desktop status and tolerates Desktop absence', async () => {
  const sessions = [{ id: 'thread-1', status: 'notLoaded' }];
  const available = createRequestHandler(createDependencies({
    codex: { listSessions: async () => sessions },
    desktop: { listThreads: async () => [{ id: 'thread-1', status: 'active' }] },
  }));
  assert.equal((await available(request('sessions.list'))).data.sessions[0].status, 'active');

  const unavailable = createRequestHandler(createDependencies({
    codex: { listSessions: async () => sessions },
    desktop: { listThreads: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  assert.deepEqual((await unavailable(request('sessions.list'))).data.sessions, sessions);
});

test('existing Desktop sessions preserve the required caller task', async () => {
  let sent;
  const handle = createRequestHandler(createDependencies({
    desktop: { sendMessage: async (message) => {
      sent = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', { threadId: 'target-thread', text: 'hello' }));
  assert.deepEqual(sent, {
    threadId: 'target-thread', text: 'hello', requestId: 'request-1', callerThreadId: 'controller-thread',
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.delivery, 'desktop');
});

test('Desktop absence falls back only for sessions safe to resume', async () => {
  let resumed;
  const fallback = createRequestHandler(createDependencies({
    codex: { startTurn: async (message) => {
      resumed = message;
      return { threadId: message.threadId };
    } },
    desktop: { sendMessage: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  const response = await fallback(request('turn.start', { threadId: 'thread-1', text: 'continue' }));
  assert.equal(response.ok, true);
  assert.equal(response.data.delivery, 'appServer');
  assert.deepEqual(resumed, {
    threadId: 'thread-1', text: 'continue', clientId: 'client-1', requestId: 'request-1',
  });

  const large = createRequestHandler(createDependencies({
    codex: { isLargeSession: async () => true },
    desktop: { sendMessage: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  assert.equal((await large(request('turn.start', { threadId: 'large-thread', text: 'continue' }))).error,
    'desktop_required_for_large_session');
});

test('Desktop delivery errors are not converted into a second send attempt', async () => {
  let resumeCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => { resumeCalls += 1; } },
    desktop: { sendMessage: async () => { throw new Error('desktop_delivery_failed:rejected'); } },
  }));
  const response = await handle(request('turn.start', { threadId: 'thread-1', text: 'hello' }));
  assert.equal(response.ok, false);
  assert.equal(response.error, 'desktop_delivery_failed:rejected');
  assert.equal(resumeCalls, 0);
});
