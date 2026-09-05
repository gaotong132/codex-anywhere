import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { safeSend } from '../src/shared/protocol.js';

test('inbound requests cannot settle outbound RPCs with the same numeric ID', async () => {
  const codex = new CodexAppServer();
  const writes: Record<string, unknown>[] = [];
  codex.writeRpc = (message) => { writes.push(message); };
  const requests: Record<string, unknown>[] = [];
  codex.handleServerRequest = (message) => { requests.push(message); };
  const response = codex.rpcRaw('thread/read', {}, 1000);
  const id = writes[0].id;
  codex.handleLine(JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { command: 'echo test' } }));
  assert.equal(requests.length, 1);
  assert.equal(codex.pending.size, 1);
  for (const line of ['null', '[]', '1', '"text"', '{', JSON.stringify({ id })]) {
    assert.doesNotThrow(() => codex.handleLine(line));
  }
  assert.equal(codex.pending.size, 1);
  codex.handleLine(JSON.stringify({ id, result: { thread: { id: 'correct-task' } } }));
  assert.deepEqual(await response, { thread: { id: 'correct-task' } });
  assert.equal(codex.pending.size, 0);
});

test('a socket that closes during send does not throw from relay routing or heartbeat', () => {
  const socket = { OPEN: 1, readyState: 1, send() { throw new Error('socket_closed'); } };
  assert.equal(safeSend(socket, { type: 'presence' }), false);
  assert.equal(safeSend(undefined, { type: 'presence' }), false);
});
