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
      readModelConfig: async () => ({ model: 'gpt-default' }),
      updateModelConfig: async (_threadId, value) => value,
      startTurn: async () => ({ threadId: 'started-thread' }),
      steerTurn: async ({ threadId }) => ({ threadId, turnId: 'turn-1', steered: true }),
      stopTurn: async () => ({ stopped: true }),
      listApprovals: () => ({ approvals: [] }),
      respondApproval: async () => ({}),
      getControllerThreadId: () => 'controller-thread',
      getDesktopTurnOverrides: () => ({}),
      isLargeSession: async () => false,
      canOwnSession: () => true,
      needsDesktopPermissionRecovery: async () => false,
      ...overrides.codex,
    },
    desktop: {
      listThreads: async () => [],
      readThreadState: async () => ({ status: 'idle', waitingOnApproval: false }),
      sendMessage: async ({ threadId }) => ({ threadId, delivery: 'desktop' }),
      ...overrides.desktop,
    },
    attachments: {
      save: async () => ({}),
      read: async () => ({}),
      ...overrides.attachments,
    },
    visualizations: {
      read: async () => ({}),
      ...overrides.visualizations,
    },
    downloads: {
      open: async () => ({}),
      read: async () => ({}),
      close: async () => ({}),
      ...overrides.downloads,
    },
    deviceId: 'personal-pc',
  };
}

function request(action, payload = {}) {
  return { action, payload, requestId: 'request-1', clientId: 'client-1' };
}

test('file downloads stay authorized to the stable browser identity across relay reconnects', async () => {
  const owners = [];
  const handle = createRequestHandler(createDependencies({
    downloads: {
      open: async (_payload, owner) => { owners.push(owner); return {}; },
      read: async (_payload, owner) => { owners.push(owner); return {}; },
      close: async (_payload, owner) => { owners.push(owner); return {}; },
    },
  }));
  for (const action of ['file.download.open', 'file.download.chunk', 'file.download.close']) {
    await handle({
      action, payload: {}, requestId: action,
      clientId: `relay-${action}`, clientDeviceId: 'approved-browser-device',
    });
  }
  assert.deepEqual(owners, [
    'approved-browser-device', 'approved-browser-device', 'approved-browser-device',
  ]);
});

test('request handler keeps connector routing independent from process startup', async () => {
  const handle = createRequestHandler(createDependencies());
  assert.deepEqual(await handle(request('connector.status')), {
    type: 'response',
    clientId: 'client-1',
    requestId: 'request-1',
    ok: true,
    data: {
      deviceId: 'personal-pc', codexOnline: true, activeTurn: false,
    },
  });
});

test('visualization reads stay on the dedicated bounded connector path', async () => {
  let payload;
  const handle = createRequestHandler(createDependencies({
    visualizations: { read: async (value) => {
      payload = value;
      return { name: 'concept.html', size: 20, content: '<main>concept</main>' };
    } },
  }));
  const response = await handle(request('visualization.read', { path: 'C:\\artifact.html' }));
  assert.deepEqual(payload, { path: 'C:\\artifact.html' });
  assert.equal(response.data.name, 'concept.html');
});

test('session model configuration stays on the connector control path', async () => {
  const calls = [];
  const handle = createRequestHandler(createDependencies({
    codex: {
      readModelConfig: async (threadId) => {
        calls.push({ action: 'read', threadId });
        return { model: 'gpt-5.6-sol', reasoningEffort: 'high', fastMode: false, models: [] };
      },
      updateModelConfig: async (threadId, value) => {
        calls.push({ action: 'update', threadId, value });
        return { ...value, serviceTier: 'fast', models: [] };
      },
    },
  }));
  const read = await handle(request('session.model-config.read', { threadId: 'thread-1' }));
  assert.equal(read.data.model, 'gpt-5.6-sol');
  const updated = await handle(request('session.model-config.update', {
    threadId: 'thread-1', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', fastMode: true,
  }));
  assert.equal(updated.data.serviceTier, 'fast');
  assert.deepEqual(calls.map((call) => call.action), ['read', 'update']);
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

test('idle existing sessions use app-server so Web can receive approval requests', async () => {
  let started;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async (message) => {
      started = message;
      return { threadId: message.threadId };
    } },
  }));
  const response = await handle(request('turn.start', { threadId: 'target-thread', text: 'hello' }));
  assert.deepEqual(started, {
    threadId: 'target-thread', text: 'hello', requestId: 'request-1', clientId: 'client-1',
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.delivery, 'appServer');
});

test('active Desktop sessions receive follow-up messages immediately through Desktop', async () => {
  let delivered;
  let appServerCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => { appServerCalls += 1; return {}; } },
    desktop: { sendMessage: async (message) => {
      delivered = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', {
    threadId: 'target-thread', text: 'adjust this now', preferDesktop: true,
    model: 'stale-model', reasoningEffort: 'low',
  }));
  assert.deepEqual(delivered, {
    threadId: 'target-thread', text: 'adjust this now', requestId: 'request-1',
    callerThreadId: 'controller-thread',
  });
  assert.equal(appServerCalls, 0);
  assert.deepEqual(response.data, { threadId: 'target-thread', delivery: 'desktop' });
});

test('an explicit model choice is applied to the next Desktop-owned turn', async () => {
  let delivered;
  const handle = createRequestHandler(createDependencies({
    codex: {
      getDesktopTurnOverrides: () => ({ model: 'gpt-5.6-sol', thinking: 'xhigh' }),
    },
    desktop: { sendMessage: async (message) => {
      delivered = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', {
    threadId: 'target-thread', text: 'continue', preferDesktop: true,
    model: 'stale-model', reasoningEffort: 'low',
  }));
  assert.deepEqual(delivered, {
    threadId: 'target-thread', text: 'continue', requestId: 'request-1',
    callerThreadId: 'controller-thread', model: 'gpt-5.6-sol', thinking: 'xhigh',
  });
  assert.equal(response.ok, true);
});

test('active Web-owned sessions steer the in-flight app-server turn', async () => {
  let steered;
  const handle = createRequestHandler(createDependencies({
    codex: { steerTurn: async (message) => {
      steered = message;
      return { threadId: message.threadId, turnId: 'turn-1', steered: true };
    } },
  }));
  const response = await handle(request('turn.steer', { threadId: 'target-thread', text: 'focus tests' }));
  assert.deepEqual(steered, {
    threadId: 'target-thread', text: 'focus tests', requestId: 'request-1', clientId: 'client-1',
  });
  assert.deepEqual(response.data, {
    threadId: 'target-thread', turnId: 'turn-1', steered: true, delivery: 'appServer',
  });
});

test('a legacy bridge permission override is handed back to Desktop once', async () => {
  let sent;
  let appServerCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: {
      needsDesktopPermissionRecovery: async () => true,
      startTurn: async () => { appServerCalls += 1; return { threadId: 'target-thread' }; },
    },
    desktop: { sendMessage: async (message) => {
      sent = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', { threadId: 'target-thread', text: 'continue' }));
  assert.deepEqual(sent, {
    threadId: 'target-thread', text: 'continue', requestId: 'request-1', callerThreadId: 'controller-thread',
  });
  assert.equal(response.data.delivery, 'desktop');
  assert.equal(appServerCalls, 0);
});

test('active Desktop sessions preserve the required caller task', async () => {
  let sent;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => { throw new Error('thread_active_writer_conflict'); } },
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

test('Desktop absence never turns a follow-up into a hidden queue', async () => {
  let startCalls = 0;
  const fallback = createRequestHandler(createDependencies({
    codex: { startTurn: async (message) => {
      startCalls += 1;
      throw new Error('thread_active_writer_conflict');
    } },
    desktop: { sendMessage: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  const response = await fallback(request('turn.start', { threadId: 'thread-1', text: 'continue' }));
  assert.equal(response.ok, false);
  assert.equal(response.error, 'thread_active_writer_conflict');
  assert.equal(startCalls, 2);

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
    codex: { startTurn: async () => {
      resumeCalls += 1;
      throw new Error('thread_active_writer_conflict');
    } },
    desktop: { sendMessage: async () => { throw new Error('desktop_delivery_failed:rejected'); } },
  }));
  const response = await handle(request('turn.start', { threadId: 'thread-1', text: 'hello' }));
  assert.equal(response.ok, false);
  assert.equal(response.error, 'desktop_delivery_failed:rejected');
  assert.equal(resumeCalls, 1);
});

test('pending approval requests are scoped to the selected thread and rebind the client', async () => {
  let query;
  const handle = createRequestHandler(createDependencies({
    codex: { listApprovals: (threadId, clientId) => {
      query = { threadId, clientId };
      return { approvals: [{ approvalId: 'approval-1', threadId }] };
    } },
  }));
  const response = await handle(request('approval.pending', { threadId: 'thread-1' }));
  assert.deepEqual(query, { threadId: 'thread-1', clientId: 'client-1' });
  assert.equal(response.data.approvals[0].approvalId, 'approval-1');
});

test('Desktop-owned approval is reported as informational instead of an actionable approval', async () => {
  const handle = createRequestHandler(createDependencies({
    desktop: { readThreadState: async () => ({ status: 'active', waitingOnApproval: true }) },
  }));
  const response = await handle(request('approval.pending', { threadId: 'thread-1' }));
  assert.equal(response.ok, true);
  assert.equal(response.data.approvals.length, 0);
  assert.deepEqual(response.data.externalApproval, {
    approvalId: '',
    threadId: 'thread-1',
    kind: 'desktop',
    summary: 'This approval is owned by Codex Desktop.',
    actionable: false,
  });
});
