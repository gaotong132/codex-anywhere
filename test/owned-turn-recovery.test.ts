import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { createRequestHandler } from '../src/connector/request-handler.js';
import { buildQuestionReply } from '../src/shared/async-questions.js';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { canSteerOwnedTurn } from '../web/src/app-utils.js';
import { initialConversationExecution, patchConversationExecution } from '../web/src/conversation-execution.js';
import { restoreOwnedTurn } from '../web/src/owned-turn.js';
import type { OwnedTurn } from '../web/src/app-types.js';

const reply = buildQuestionReply([{ questionItemId: 'question-1', question: 'Which environment?', answer: 'ECS' }]);

function fixture(mode: 'headless' | 'desktop' = 'headless') {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.activeTurns.set('task-a', {
    threadId: 'task-a', turnId: 'turn-a', state: 'running', cwd: process.cwd(), clientId: 'old-browser',
  });
  const calls: Array<{ method: string; params: any }> = [];
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    return { turnId: 'turn-a' };
  };
  const browser = new BrowserSessionBroker('test-node', () => true);
  browser.bind({ clientId: 'new-browser', clientDeviceId: 'device-a' }, 'task-a', {
    browserDeviceId: 'device-a', tabId: 1, documentId: 'doc-a', origin: 'https://example.com',
  });
  const unused = async () => { throw new Error('unexpected call'); };
  const handler = createRequestHandler({
    codex, browser, mode, deviceId: 'test-node',
    desktop: {
      listThreads: async () => [], readThreadState: async () => ({}), renameThread: unused,
      sendMessage: async (params) => { calls.push({ method: 'desktop', params }); return { threadId: params.threadId }; },
    },
    attachments: { save: unused, read: unused }, visualizations: { read: unused },
    downloads: { open: unused, read: unused, readMarkdown: unused, readText: unused, close: unused },
  });
  const request = (action: string, payload: Record<string, unknown> = {}) => handler({
    action, payload, clientId: 'new-browser', clientDeviceId: 'device-a', requestId: 'reply-request',
  });
  return { codex, calls, request };
}

test('a reloaded ECS browser restores ownership without an approval and steers an option answer', async () => {
  const { codex, calls, request } = fixture();
  const result = await request('approval.pending', { threadId: 'task-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.approvals, []);
  const patch = restoreOwnedTurn(result.data.activeTurn, 'task-a', null, 1, 1);
  const state = patchConversationExecution(initialConversationExecution(), patch!);
  assert.equal(canSteerOwnedTurn(state.running, state.state, state.ownedTurnThreadId, 'task-a'), true);
  assert.equal(codex.getActiveTurn()!.clientId, 'new-browser');
  const sent = await request('turn.steer', { threadId: 'task-a', text: reply });
  assert.equal(sent.ok, true);
  assert.deepEqual(calls, [{ method: 'turn/steer', params: {
    threadId: 'task-a', expectedTurnId: 'turn-a', input: [{ type: 'text', text: reply }],
  } }]);
});

test('an answer submitted before ownership refresh steers the same ECS turn without starting another', async () => {
  const { codex, calls, request } = fixture();
  const result = await request('turn.start', { threadId: 'task-a', text: reply });
  assert.equal(result.ok, true);
  assert.equal(result.data.steered, true);
  assert.equal(result.data.delivery, 'appServer');
  assert.equal(codex.getActiveTurn()!.requestId, 'reply-request');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'turn/steer');
  assert.equal(calls[0].params.input[0].text, reply, 'question IDs and answers survive browser context delivery');
});

test('starting and cancelling turns retain the same-session busy guard', async () => {
  for (const scenario of [
    { threadId: 'task-a', state: 'starting' }, { threadId: 'task-a', state: 'cancelling' },
  ]) {
    const { codex, calls, request } = fixture();
    codex.getActiveTurn()!.state = scenario.state;
    const result = await request('turn.start', { threadId: scenario.threadId, text: reply });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'another_turn_is_active');
    assert.deepEqual(calls, []);
  }
});

test('steering failure never retries the answer as a new turn', async () => {
  const { codex, calls, request } = fixture();
  codex.rpcRaw = async (method, params) => { calls.push({ method, params }); throw new Error('RPC timeout: turn/steer'); };
  const result = await request('turn.start', { threadId: 'task-a', text: reply });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'RPC timeout: turn/steer');
  assert.deepEqual(calls.map(call => call.method), ['turn/steer']);
});

test('an idle headless task starts normally while Desktop keeps its existing writer', async () => {
  const idle = fixture();
  idle.codex.activeTurns.clear();
  idle.codex.startTurn = async (params) => { idle.calls.push({ method: 'start', params }); return { threadId: 'task-a' }; };
  assert.equal((await idle.request('turn.start', { threadId: 'task-a', text: reply })).ok, true);
  assert.deepEqual(idle.calls.map(call => call.method), ['start']);
  const desktop = fixture('desktop');
  desktop.codex.getDesktopTurnOverrides = async () => ({});
  assert.equal((await desktop.request('turn.start', { threadId: 'task-a', text: reply })).ok, true);
  assert.deepEqual(desktop.calls.map(call => call.method), ['desktop']);
  assert.equal(desktop.calls[0].params.threadId, 'task-a');
  assert.equal(desktop.calls[0].params.text, reply);
});

test('ownership snapshots are task-scoped and omit process, client and workspace details', async () => {
  const { codex, request } = fixture();
  const other = await request('approval.pending', { threadId: 'task-b' });
  assert.equal(other.data.activeTurn, null);
  assert.equal(codex.getActiveTurn()!.clientId, 'old-browser');
  const selected = await request('approval.pending', { threadId: 'task-a' });
  assert.deepEqual(selected.data.activeTurn, { threadId: 'task-a', turnId: 'turn-a', state: 'running' });
  codex.activeTurns.clear();
  assert.equal((await request('approval.pending', { threadId: 'task-a' })).data.activeTurn, null);
});

test('late snapshots cannot resurrect completed turns or overwrite newer sends and approvals', () => {
  const active: OwnedTurn = { threadId: 'task-a', turnId: 'turn-a', state: 'running' };
  assert.equal(restoreOwnedTurn(active, 'task-a', null, 1, 2), null);
  assert.equal(restoreOwnedTurn(null, 'task-a', 'task-a', 1, 2), null);
  assert.equal(restoreOwnedTurn(active, 'task-b', null, 1, 1), null);
  assert.equal(restoreOwnedTurn(undefined, 'task-a', 'task-a', 1, 1), null);
  assert.equal(restoreOwnedTurn({ ...active, state: 'cancelling' }, 'task-a', 'task-a', 1, 1), null);
  assert.equal(restoreOwnedTurn({ ...active, turnId: '' }, 'task-a', null, 1, 1), null);
  assert.equal(restoreOwnedTurn(null, 'task-b', 'task-a', 1, 1), null);
  assert.deepEqual(restoreOwnedTurn(null, 'task-a', 'task-a', 1, 1), { running: false, ownedTurnThreadId: null });
});

test('Desktop connector first-turn ownership does not probe an unrelated native owner', async () => {
  const { request, calls } = fixture('desktop');
  const result = await request('approval.pending', { threadId: 'task-a' });
  assert.equal(result.ok, true);
  assert.equal(result.data.activeTurn.threadId, 'task-a');
  assert.equal(result.data.desktopState, undefined);
  assert.equal(result.data.desktopStatusUnavailable, undefined);
  assert.deepEqual(calls, []);
});
