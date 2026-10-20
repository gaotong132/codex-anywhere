import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopClient } from '../src/connector/codex-desktop.js';
import { friendlyError } from '../web/src/app-utils.js';

function captureDesktop() {
  const desktop = new CodexDesktopClient();
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  desktop.getClient = async () => ({
    tools: new Set(['send_message_to_thread', 'set_thread_title', 'read_thread', 'set_thread_archived', 'navigate_to_codex_page', 'list_threads']),
    request: async (method, params) => {
      calls.push({ method, params });
      return { success: true, contentItems: [{ text: JSON.stringify({ thread: { status: 'idle' } }) }] };
    },
    close: () => {},
  });
  return { desktop, calls };
}

test('archive reads the selected task status and uses the same native identity without deleting', async () => {
  const { desktop, calls } = captureDesktop();
  assert.deepEqual(await desktop.archiveThread({ threadId: 'archive-target' }), { threadId: 'archive-target', archived: true });
  assert.deepEqual(calls.map(({ params }) => params.tool), ['read_thread', 'set_thread_archived']);
  for (const { params } of calls) {
    assert.equal(params.threadId, 'archive-target');
    assert.equal(params.arguments.threadId, 'archive-target');
  }
  assert.deepEqual(calls[1].params.arguments, { threadId: 'archive-target', archived: true, source: 'codex' });
});

test('archive fails closed for running, approval-waiting and unknown Desktop states', async () => {
  for (const state of [{ status: 'running' }, { status: 'inProgress' }, { status: 'unknown' }, { status: 'idle', waitingOnApproval: true }]) {
    const { desktop, calls } = captureDesktop();
    desktop.readThreadState = async () => ({ waitingOnApproval: false, ...state });
    await assert.rejects(desktop.archiveThread({ threadId: 'target' }), /session_archive_not_idle/);
    assert.equal(calls.length, 0);
  }
});

test('only explicit confirmation allows archiving an actual Desktop approval wait', async () => {
  const { desktop, calls } = captureDesktop();
  desktop.readThreadState = async () => ({ status: 'active', waitingOnApproval: true });
  await assert.rejects(desktop.archiveThread({ threadId: 'target' }), /session_archive_not_idle/);
  assert.equal(calls.length, 0);
  await desktop.archiveThread({ threadId: 'target', cancelPendingApproval: true });
  assert.deepEqual(calls.map(({ params }) => params.tool), ['set_thread_archived']);
  assert.equal(calls[0].params.arguments.archived, true);
  desktop.readThreadState = async () => ({ status: 'active', waitingOnApproval: false });
  await assert.rejects(desktop.archiveThread({ threadId: 'target', cancelPendingApproval: true }), /session_archive_not_idle/);
  assert.equal(calls.length, 1, 'resumed work must not be cancelled using a stale confirmation');
  await desktop.restoreThread({ threadId: 'target' });
  assert.equal(calls[1].params.arguments.archived, false);
  assert.equal(calls[1].params.threadId, 'target');
  assert.equal(calls[1].params.arguments.threadId, 'target');
});

test('user input snapshots only the selected destination and explicit model overrides', async () => {
  const { desktop, calls } = captureDesktop();
  const inputs: any[] = [];
  desktop.userInput.send = async input => { inputs.push(input); };
  const input = { threadId: 'thread-a', text: 'Message A', requestId: 'a', callerThreadId: 'unrelated-thread' };
  await Promise.all([desktop.sendMessage(input), desktop.sendMessage({ threadId: 'thread-b', text: 'Message B', requestId: 'b', model: 'gpt-6-astra', thinking: 'high' })]);
  assert.deepEqual(inputs, [
    { threadId: 'thread-a', text: 'Message A', requestId: 'a', model: undefined, thinking: undefined },
    { threadId: 'thread-b', text: 'Message B', requestId: 'b', model: 'gpt-6-astra', thinking: 'high' },
  ]);
  assert.equal(calls.length, 0, 'user input never invokes an app tool');
});

test('metadata app calls still identify the Codex caller required by Desktop', async () => {
  const { desktop, calls } = captureDesktop();
  await desktop.renameThread({ threadId: 'thread-a', name: 'title' });
  await desktop.readThreadState({ threadId: 'thread-a' });
  await desktop.listThreads({ callerThreadId: 'thread-a' });
  for (const { method, params } of calls) {
    assert.equal(method, 'tools/call'); assert.equal(params.callerSource, 'codex');
    assert.equal(params.namespace, 'codex_app'); assert.equal(params.threadId, 'thread-a');
  }
});

test('rename and approval-status reads also use only the selected task identity', async () => {
  const { desktop, calls } = captureDesktop();
  await desktop.renameThread({ threadId: 'thread-a', name: 'A new title' });
  await desktop.readThreadState({ threadId: 'thread-b' });
  assert.deepEqual(calls.map(({ params }) => [params.tool, params.threadId, params.arguments.threadId]), [
    ['set_thread_title', 'thread-a', 'thread-a'],
    ['read_thread', 'thread-b', 'thread-b'],
  ]);
});

test('native task tools reject cross-task identities before connecting to Desktop', async () => {
  const desktop = new CodexDesktopClient();
  let connections = 0;
  desktop.getClient = async () => { connections += 1; throw new Error('must_not_connect'); };
  for (const tool of ['send_message_to_thread', 'set_thread_title', 'read_thread', 'set_thread_archived']) {
    for (const callerThreadId of ['another-project-thread', '', ' target-thread ']) {
      await assert.rejects(desktop.callTool({
        tool, arguments: { threadId: 'target-thread', prompt: 'hello' },
        callerThreadId, callId: 'isolation-test',
      }), /desktop_thread_identity_mismatch/);
    }
    for (const threadId of [undefined, null, '', {}, 42, 'bad\nid', 'x'.repeat(257)]) {
      await assert.rejects(desktop.callTool({
        tool, arguments: { threadId }, callerThreadId: 'target-thread', callId: 'isolation-test',
      }), /thread_id_required/);
    }
  }
  assert.equal(connections, 0);
});

test('invalid Desktop destinations never fall back to a known or active task', async () => {
  const { desktop, calls } = captureDesktop();
  for (const threadId of [undefined, null, '', '  ', {}, 42, 'bad\0id', 'x'.repeat(257)]) {
    await assert.rejects(desktop.sendMessage({ threadId, text: 'hello', requestId: 'test' }), /thread_id_required/);
    await assert.rejects(desktop.renameThread({ threadId, name: 'title' }), /thread_id_required/);
    await assert.rejects(desktop.readThreadState({ threadId }), /thread_id_required/);
  }
  assert.equal(calls.length, 0);
});

test('a native call snapshots its validated target before waiting for the pipe', async () => {
  const { desktop, calls } = captureDesktop();
  const getClient = desktop.getClient.bind(desktop);
  let releaseConnection;
  const connected = new Promise<void>((resolve) => { releaseConnection = resolve; });
  desktop.getClient = async () => { await connected; return getClient(); };
  const args = { threadId: 'thread-a', prompt: 'Original input' };
  const pending = desktop.callTool({
    tool: 'send_message_to_thread', arguments: args, callerThreadId: 'thread-a', callId: 'test',
  });
  args.threadId = 'unrelated-thread';
  args.prompt = 'Replaced input';
  releaseConnection();
  await pending;
  assert.equal(calls[0].params.threadId, 'thread-a');
  assert.deepEqual(calls[0].params.arguments, { threadId: 'thread-a', prompt: 'Original input' });
});

test('user input failure is preserved without falling back to a delegation tool', async () => {
  const { desktop, calls } = captureDesktop();
  let attempts = 0;
  desktop.userInput.send = async () => { attempts++; throw new Error('desktop_delivery_unknown'); };
  await assert.rejects(desktop.sendMessage({ threadId: 'target', text: 'hello', requestId: 'test' }), /desktop_delivery_unknown/);
  assert.equal(attempts, 1); assert.equal(calls.length, 0);
  assert.match(friendlyError(new Error('desktop_thread_identity_mismatch')), /已阻止操作.*会话身份不一致/);
});

test('opening Desktop permissions navigates only to the selected task, without changing its settings', async () => {
  const { desktop, calls } = captureDesktop();
  assert.deepEqual(await desktop.openThread({ threadId: 'selected-task' }), { threadId: 'selected-task', opened: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.tool, 'navigate_to_codex_page');
  assert.equal(calls[0].params.threadId, 'selected-task');
  assert.deepEqual(calls[0].params.arguments, { threadId: 'selected-task' });
  await assert.rejects(desktop.openThread({ threadId: '' }), /thread_id_required/);
  assert.equal(calls.length, 1);
  desktop.callTool = async () => ({ success: false });
  await assert.rejects(desktop.openThread({ threadId: 'selected-task' }), /desktop_thread_open_failed/);
});
