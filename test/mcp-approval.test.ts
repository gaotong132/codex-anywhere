import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { approvalResult, isMcpToolApproval } from '../src/connector/app-server-permissions.js';

const method = 'mcpServer/elicitation/request';
const params = { threadId: 'test-task', turnId: 'test-turn', serverName: 'anywhere_browser', mode: 'form',
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
  message: 'Allow scroll?', requestedSchema: { type: 'object', properties: {} } };

test('MCP approval is queued for the exact live task and approves only this call', async () => {
  const codex = new CodexAppServer();
  const writes: any[] = []; codex.writeRpc = (value) => { writes.push(value); };
  codex.activeTurn = { threadId: 'test-task', turnId: 'test-turn', cwd: process.cwd(), state: 'running' };
  codex.handleServerRequest({ id: 7, method, params });
  assert.equal(writes.length, 0);
  assert.equal(codex.listApprovals('test-task').approvals[0].kind, 'mcp-tool');
  assert.match(codex.listApprovals('test-task').approvals[0].summary, /Allow scroll/);
  await assert.rejects(codex.respondApproval('7', true, 'other-task'), /approval_thread_mismatch/);
  await codex.respondApproval('7', true, 'test-task');
  assert.deepEqual(writes.at(-1).result, { action: 'accept', content: {}, _meta: null });
  assert.equal(codex.listApprovals('test-task').approvals.length, 0);
});

test('unknown elicitation forms, stale turns and missing task IDs cannot become generic approvals', () => {
  const codex = new CodexAppServer(); const writes: any[] = []; codex.writeRpc = (v) => { writes.push(v); };
  codex.activeTurn = { threadId: 'test-task', turnId: 'test-turn', cwd: process.cwd(), state: 'running' };
  for (const changed of [{ threadId: '' }, { threadId: 'other' }, { turnId: 'old' }, { mode: 'url' },
    { _meta: {} }, { requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }]) {
    codex.handleServerRequest({ id: 1, method, params: { ...params, ...changed } });
    assert.deepEqual(writes.at(-1).result, { action: 'decline', content: null, _meta: null });
  }
  assert.equal(codex.listApprovals('test-task').approvals.length, 0);
});

test('legacy MCP approval questions only choose one-shot Allow or Cancel', () => {
  const request = { questions: [{ id: 'mcp_tool_call_approval:tool', question: 'Allow?', options: [{ label: 'Allow' }, { label: 'Allow for this session' }, { label: 'Cancel' }] }] };
  assert.equal(isMcpToolApproval('item/tool/requestUserInput', request), true);
  assert.deepEqual(approvalResult('item/tool/requestUserInput', true, request), { answers: { 'mcp_tool_call_approval:tool': { answers: ['Allow'] } } });
  assert.deepEqual(approvalResult('item/tool/requestUserInput', false, request), { answers: { 'mcp_tool_call_approval:tool': { answers: ['Cancel'] } } });
  assert.equal(isMcpToolApproval('item/tool/requestUserInput', { questions: [{ ...request.questions[0], id: 'business-choice' }] }), false);
});
