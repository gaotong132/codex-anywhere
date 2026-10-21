import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { mergeDesktopSessionStatuses } from '../src/connector/codex-desktop.js';
import { canSteerOwnedTurn, canStopOwnedTurn } from '../web/src/app-utils.js';
import { initialConversationExecution, patchConversationExecution, resetConversationExecutionPresentation } from '../web/src/conversation-execution.js';
import { restoreOwnedTurn } from '../web/src/owned-turn.js';

function fixture(desktop = false) {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd(), releaseRuntimeAfterTurn: desktop });
  codex.ensureStarted = async () => {};
  const calls: Array<{ method: string; params: any }> = [];
  const events: any[] = [];
  const writes: any[] = [];
  let sequence = 0;
  codex.on('turn-event', event => events.push(event));
  codex.writeRpc = message => writes.push(message);
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: process.cwd() } } as any;
    if (method === 'thread/resume') return { thread: { id: params.threadId } } as any;
    if (method === 'thread/start') return { thread: { id: `new-${++sequence}` } } as any;
    if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}-${++sequence}` } } as any;
    if (method === 'turn/steer') return { turnId: params.expectedTurnId } as any;
    return {} as any;
  };
  const start = (threadId: string) => codex.startTurn({ threadId, text: 'Run task', clientId: `client-${threadId}`, requestId: `request-${threadId}` });
  const notification = (threadId: string, method: string, params: any = {}) => codex.handleNotification(method, {
    threadId, turnId: codex.getActiveTurn(threadId)?.turnId, ...params,
  });
  const approve = (threadId: string, id: number) => codex.handleServerRequest({ id,
    method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId: codex.getActiveTurn(threadId)?.turnId, command: `echo ${threadId}` },
  });
  return { codex, calls, events, writes, start, notification, approve };
}

test('different existing and new sessions start concurrently; a duplicate session remains reserved', async () => {
  const { codex, start } = fixture();
  const first = start('a');
  await assert.rejects(start('a'), /another_turn_is_active/);
  await Promise.all([first, start('b')]);
  const created = await Promise.all([1, 2].map(() => codex.startTurn({ cwd: process.cwd(), text: 'New task' })));
  assert.notEqual(created[0].threadId, created[1].threadId);
  assert.equal(codex.activeTurns.size, 4);
  for (const id of ['a', 'b', ...created.map(result => result.threadId)]) {
    assert.equal(codex.getActiveTurn(id)?.state, 'running');
  }
  assert.equal(codex.getActiveTurn(), null, 'an unspecified target must be ambiguous');
});

test('interleaved native events and answers retain each thread, turn and browser destination', async () => {
  const { codex, start, notification, events, calls } = fixture();
  await Promise.all([start('a'), start('b')]);
  events.length = 0;
  notification('a', 'item/agentMessage/delta', { delta: 'A output' });
  notification('b', 'item/agentMessage/delta', { delta: 'B output' });
  notification('a', 'turn/plan/updated', { plan: [{ step: 'Plan A', status: 'inProgress' }] });
  notification('b', 'item/started', { item: { type: 'commandExecution', command: 'echo B' } });
  notification('a', 'item/started', { item: { type: 'contextCompaction', id: 'compact-a' } });
  notification('b', 'item/completed', { item: { type: 'agentMessage', id: 'question-b', delivery: 'async', questions: [{ title: 'Choose B?', options: ['yes', 'no'] }] } });
  assert.deepEqual(events.map(event => event.payload.threadId), ['a', 'b', 'a', 'b', 'a', 'b']);
  for (const event of events) {
    assert.equal(event.clientId, `client-${event.payload.threadId}`);
    assert.equal(event.payload.turnId, codex.getActiveTurn(event.payload.threadId)?.turnId);
  }
  assert.ok(codex.getActiveTurn('a')?.compaction);
  assert.equal(codex.getActiveTurn('b')?.compaction, undefined);
  const before = events.length;
  codex.handleNotification('item/agentMessage/delta', { delta: 'Unscoped' });
  codex.handleNotification('item/agentMessage/delta', { threadId: 'a', turnId: 'old-a', delta: 'Stale' });
  codex.handleNotification('turn/completed', { threadId: 'unknown', turn: { id: 'unknown' } });
  assert.equal(events.length, before);
  await codex.steerTurn({ threadId: 'b', text: 'Answer B', clientId: 'new-b', requestId: 'reply-b' });
  assert.equal(calls.at(-1)?.params.threadId, 'b');
  assert.equal(codex.getActiveTurn('a')?.clientId, 'client-a');
  notification('b', 'item/agentMessage/delta', { delta: 'B after answer' });
  assert.equal(events.at(-1).clientId, 'new-b');
});

test('stopping one task interrupts only that turn; its completion cannot stop another', async () => {
  const { codex, calls, events, start, notification } = fixture();
  await Promise.all([start('a'), start('b')]);
  await assert.rejects(codex.stopTurn(), /thread_id_required/);
  await assert.rejects(codex.stopTurn('other'), /turn_stop_mismatch/);
  const turnA = codex.getActiveTurn('a')!.turnId;
  await codex.stopTurn('a');
  assert.deepEqual(calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'a', turnId: turnA } });
  assert.equal(codex.getActiveTurn('a')?.state, 'cancelling');
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  notification('a', 'turn/completed', { turn: { id: turnA, status: 'interrupted' } });
  await codex.prepareDesktopTurn();
  assert.equal(codex.getActiveTurn('a'), null);
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  notification('b', 'item/agentMessage/delta', { delta: 'Still working' });
  assert.equal(events.at(-1).payload.threadId, 'b');
  assert.deepEqual(calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['a']);
});

test('approvals and reconnect ownership stay scoped while both tasks await decisions', async () => {
  const { codex, events, writes, start, notification, approve } = fixture();
  await Promise.all([start('a'), start('b')]);
  approve('a', 101); approve('b', 102);
  assert.equal(codex.listApprovals('a', 'reconnected-a').approvals[0].approvalId, '101');
  assert.equal(codex.listApprovals('b').approvals[0].approvalId, '102');
  assert.equal(codex.getActiveTurn('b')?.clientId, 'client-b');
  await assert.rejects(codex.respondApproval('102', true, 'a'), /approval_thread_mismatch/);
  assert.equal(writes.length, 0);
  await codex.respondApproval('101', true, 'a');
  assert.equal(writes.at(-1).id, 101);
  assert.equal(events.at(-1).clientId, 'reconnected-a');
  assert.equal(events.at(-1).payload.threadId, 'a');
  approve('a', 103);
  notification('a', 'turn/completed', { status: 'failed', error: { message: 'A failed' } });
  assert.equal(codex.approvals.has('103'), false);
  assert.equal(codex.approvals.has('102'), true);
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  codex.handleServerRequest({ id: 104, method: 'item/commandExecution/requestApproval', params: { threadId: 'b', turnId: 'stale-b', command: 'echo stale' } });
  assert.equal(codex.approvals.has('104'), false);
  assert.equal(writes.at(-1).result.decision, 'decline');
});

test('a failed start and a slow unsubscribe in A do not block B', async () => {
  const { codex, start, calls, notification } = fixture();
  const rpc = codex.rpcRaw.bind(codex);
  codex.rpcRaw = async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'failed') throw new Error('start failed');
    return rpc(method, params);
  };
  await start('b');
  await assert.rejects(start('failed'), /start failed/);
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  assert.equal(codex.getActiveTurn('failed'), null);
  await start('a');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  codex.rpcRaw = async (method, params) => {
    if (method === 'thread/unsubscribe' && params.threadId === 'a') await pending;
    return rpc(method, params);
  };
  notification('a', 'turn/completed');
  const restarting = start('a');
  await start('c');
  assert.equal(codex.getActiveTurn('c')?.state, 'running');
  assert.equal(codex.getActiveTurn('a')?.state, 'starting');
  assert.equal(calls.filter(call => call.method === 'turn/start' && call.params.threadId === 'a').length, 1);
  release(); await restarting;
  assert.equal(codex.activeTurns.size, 3);
});

for (const replayCompletion of [false, true]) test(`resuming a session ignores replayed usage (completion: ${replayCompletion})`, async () => {
  const { codex, start, events } = fixture();
  await start('b');
  const rpc = codex.rpcRaw.bind(codex);
  codex.rpcRaw = async (method, params) => {
    if (method === 'thread/resume' && params.threadId === 'a') {
      codex.handleNotification('thread/tokenUsage/updated', { threadId: 'a', turnId: 'previous-a' });
      if (replayCompletion) codex.handleNotification('turn/completed', { threadId: 'a', turn: { id: 'previous-a', status: 'completed' } });
    }
    return rpc(method, params);
  };
  await start('a');
  assert.equal(codex.getActiveTurn('a')?.state, 'running');
  assert.notEqual(codex.getActiveTurn('a')?.turnId, 'previous-a');
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  assert.deepEqual(events.filter(event => event.payload.threadId === 'a').map(event => event.event), ['turn.started']);
});

test('an early completion before the start response does not resurrect a turn or affect a sibling', async () => {
  const { codex, start, events } = fixture();
  await start('b');
  const rpc = codex.rpcRaw.bind(codex);
  codex.rpcRaw = async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'a') {
      codex.handleNotification('turn/completed', { threadId: 'a', turn: { id: 'early-a', status: 'completed' } });
      return { turn: { id: 'early-a' } } as any;
    }
    return rpc(method, params);
  };
  await start('a');
  assert.equal(codex.getActiveTurn('a'), null);
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  assert.deepEqual(events.filter(event => event.payload.threadId === 'a').map(event => event.event), ['turn.started', 'turn.ended']);
});

test('start response selects buffered events and approvals by turn ID, discarding stale events', async () => {
  const { codex, start, events, writes } = fixture();
  await start('b');
  const rpc = codex.rpcRaw.bind(codex);
  codex.rpcRaw = async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'a') {
      for (const turnId of ['old-a', 'current-a']) {
        codex.handleNotification('thread/tokenUsage/updated', { threadId: 'a', turnId });
        codex.handleNotification('item/agentMessage/delta', { threadId: 'a', turnId, delta: turnId });
        codex.handleServerRequest({ id: turnId, method: 'item/commandExecution/requestApproval',
          params: { threadId: 'a', turnId, command: 'echo OK' } });
      }
      codex.handleNotification('turn/completed', { threadId: 'a', turn: { id: 'old-a', status: 'completed' } });
      assert.equal(codex.getActiveTurn('a')?.turnId, '');
      assert.equal(codex.approvals.size, 0);
      return { turn: { id: 'current-a' } } as any;
    }
    return rpc(method, params);
  };
  await start('a');
  assert.equal(codex.getActiveTurn('a')?.turnId, 'current-a');
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  assert.deepEqual(events.filter(event => event.payload.threadId === 'a').map(event => event.event),
    ['turn.started', 'turn.delta', 'approval.requested']);
  assert.equal(events.find(event => event.event === 'turn.delta').payload.delta, 'current-a');
  assert.deepEqual([...codex.approvals.keys()], ['current-a']);
  assert.deepEqual(writes.map(message => [message.id, message.result.decision]), [['old-a', 'decline']]);
});

for (const cancel of [false, true]) test(`unsuccessful start cleans buffered approvals (cancel: ${cancel})`, async () => {
  const { codex, start, events, writes, calls } = fixture();
  await start('b');
  const rpc = codex.rpcRaw.bind(codex);
  codex.rpcRaw = async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'a') {
      codex.handleServerRequest({ id: 99, method: 'item/commandExecution/requestApproval',
        params: { threadId: 'a', turnId: 'new-a', command: 'echo OK' } });
      if (!cancel) throw new Error('start failed');
      await codex.stopTurn('a');
      return { turn: { id: 'new-a' } } as any;
    }
    return rpc(method, params);
  };
  await assert.rejects(start('a'), cancel ? /turn_cancelled/ : /start failed/);
  assert.equal(codex.getActiveTurn('a'), null);
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
  assert.deepEqual(events.filter(event => event.payload.threadId === 'a'), []);
  assert.equal(codex.approvals.size, 0);
  assert.deepEqual(writes.map(message => [message.id, message.result.decision]), [[99, 'decline']]);
  if (cancel) assert.deepEqual(calls.find(call => call.method === 'turn/interrupt')?.params,
    { threadId: 'a', turnId: 'new-a' });
});

test('a shared runtime exit reports each affected task separately', async () => {
  const { codex, start, events, approve } = fixture();
  await Promise.all([start('a'), start('b')]);
  approve('a', 1); approve('b', 2);
  codex.child = {} as any;
  codex.handleExit(new Error('runtime exit'));
  assert.equal(codex.activeTurns.size, 0);
  assert.equal(codex.approvals.size, 0);
  assert.deepEqual(events.filter(event => event.event === 'turn.error').map(event => [event.payload.threadId, event.clientId]), [['a', 'client-a'], ['b', 'client-b']]);
});

test('one JSON-RPC connection multiplexes out-of-order starts and events for two sessions', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  const starts: any[] = [];
  const events: any[] = [];
  codex.on('turn-event', event => events.push(event));
  codex.writeRpc = message => {
    const respond = (request: any, result: any) => codex.handleLine(JSON.stringify({ id: request.id, result }));
    if (message.method === 'turn/start') {
      starts.push(message);
      if (starts.length === 2) queueMicrotask(() => {
        for (const request of [...starts].reverse()) respond(request, { turn: { id: `turn-${request.params.threadId}` } });
      });
    } else queueMicrotask(() => respond(message, { thread: { id: message.params.threadId, cwd: process.cwd() } }));
  };
  await Promise.all(['a', 'b'].map(threadId => codex.startTurn({ threadId, clientId: `browser-${threadId}`, text: threadId })));
  assert.notEqual(starts[0].id, starts[1].id);
  for (const threadId of ['a', 'b', 'a']) codex.handleLine(JSON.stringify({ method: 'item/agentMessage/delta',
    params: { threadId, turnId: `turn-${threadId}`, delta: threadId } }));
  assert.deepEqual(events.filter(event => event.event === 'turn.delta').map(event => event.clientId), ['browser-a', 'browser-b', 'browser-a']);
  assert.equal(codex.pending.size, 0);
});

test('an active task does not block another task permission settings', async () => {
  const { codex, start, calls } = fixture();
  await start('a');
  codex.sessionMetadata.set('b', { cwd: process.cwd(), path: '', canAcceptDirectInput: true });
  await codex.updatePermissionMode('b', 'auto');
  assert.equal(calls.at(-1)?.method, 'thread/settings/update');
  assert.equal(calls.at(-1)?.params.threadId, 'b');
  assert.equal(codex.getActiveTurn('a')?.state, 'running');
  await assert.rejects(codex.updatePermissionMode('a', 'auto'), /permission_mode_turn_active/);
});

test('session status and selected controls represent concurrent tasks independently', () => {
  assert.deepEqual(mergeDesktopSessionStatuses([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [], ['a', 'b']), [
    { id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'c' },
  ]);
  const current = patchConversationExecution(initialConversationExecution(), { running: true, state: 'running', ownedTurnThreadId: 'a' });
  const selected = resetConversationExecutionPresentation(current);
  assert.equal(selected.running, false, 'an idle B can send while A runs');
  assert.equal(canStopOwnedTurn(selected.running, selected.ownedTurnThreadId, 'b'), false);
  const restored = patchConversationExecution(selected, restoreOwnedTurn({ threadId: 'b', turnId: 'turn-b', state: 'running' }, 'b', null, 2, 2)!);
  assert.equal(canSteerOwnedTurn(restored.running, restored.state, restored.ownedTurnThreadId, 'b'), true);
  assert.equal(canStopOwnedTurn(restored.running, restored.ownedTurnThreadId, 'a'), false);
  assert.equal(current.ownedTurnThreadId, 'a');
});

test('Desktop first turns remain serialized and release their writer before the next start', async () => {
  const { codex, start, notification } = fixture(true);
  const first = start('a');
  await assert.rejects(start('b'), /desktop_first_turn_busy/);
  await first;
  await assert.rejects(start('b'), /desktop_first_turn_busy/);
  notification('a', 'turn/completed');
  await start('b');
  assert.equal(codex.activeTurns.size, 1);
  assert.equal(codex.getActiveTurn('b')?.state, 'running');
});

test('a stalled start bounds early notifications and declines approvals on overflow', async () => {
  const { codex, start, calls, writes } = fixture();
  const rpc = codex.rpcRaw;
  codex.rpcRaw = async (method, params) => {
    if (method === 'turn/start') {
      for (let i = 0; i < 600; i++) codex.handleNotification('item/agentMessage/delta', {
        threadId: 'a', turnId: 'current', delta: 'early',
      });
      codex.handleServerRequest({ id: 'overflow', method: 'item/commandExecution/requestApproval',
        params: { threadId: 'a', turnId: 'current', command: 'echo test' } });
      assert.equal(codex.getActiveTurn('a')?.startMessages?.length, 512);
      return { turn: { id: 'current' } } as any;
    }
    return rpc(method, params);
  };
  await assert.rejects(start('a'), /turn_cancelled/);
  assert.equal(codex.activeTurns.size, 0);
  assert.equal(calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'current'), true);
  assert.equal(writes.find(w => w.id === 'overflow')?.result.decision, 'decline');
});
