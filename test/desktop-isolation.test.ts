import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopClient } from '../src/connector/codex-desktop.js';
import { friendlyError } from '../web/src/app-utils.js';

function captureDesktop() {
  const desktop = new CodexDesktopClient();
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  desktop.getClient = async () => ({
    request: async (method, params) => {
      calls.push({ method, params });
      return { success: true, contentItems: [{ text: JSON.stringify({ thread: { status: 'idle' } }) }] };
    },
    close: () => {},
  });
  return { desktop, calls };
}

test('mobile input cannot select a different source task, even with a legacy caller field', async () => {
  const { desktop, calls } = captureDesktop();
  const input = {
    threadId: 'project-a-thread', text: 'Continue here', requestId: 'request-a',
    callerThreadId: 'production-thread',
  };
  await desktop.sendMessage(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.threadId, input.threadId);
  assert.equal(calls[0].params.arguments.threadId, input.threadId);
  assert.equal(calls[0].params.arguments.prompt, input.text);
  assert.doesNotMatch(JSON.stringify(calls), /production-thread/);
});

test('concurrent sends keep each task source, destination, text and request id together', async () => {
  const { desktop, calls } = captureDesktop();
  await Promise.all(['thread-a', 'thread-b'].map((threadId) => desktop.sendMessage({
    threadId, text: `Message for ${threadId}`, requestId: `request-${threadId}`,
  })));
  assert.equal(calls.length, 2);
  for (const { params } of calls) {
    assert.equal(params.arguments.threadId, params.threadId);
    assert.equal(params.arguments.prompt, `Message for ${params.threadId}`);
    assert.equal(params.callId, `bridge-request-${params.threadId}`);
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
  for (const tool of ['send_message_to_thread', 'set_thread_title', 'read_thread']) {
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

test('a Desktop rejection makes exactly one attempt and never substitutes another caller', async () => {
  const { desktop, calls } = captureDesktop();
  const getClient = desktop.getClient.bind(desktop);
  desktop.getClient = async () => {
    const client = await getClient();
    return {
      ...client,
      request: async (method, params) => {
        await client.request(method, params);
        return { success: false, contentItems: [{ text: 'self delivery unsupported' }] };
      },
    };
  };
  await assert.rejects(desktop.sendMessage({
    threadId: 'target-thread', text: 'hello', requestId: 'test',
  }), /desktop_delivery_failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.threadId, 'target-thread');
});

test('task isolation failures are preserved and explained without claiming delivery', async () => {
  const desktop = new CodexDesktopClient();
  desktop.callTool = async () => { throw new Error('desktop_thread_identity_mismatch'); };
  await assert.rejects(desktop.sendMessage({
    threadId: 'target-thread', text: 'hello', requestId: 'test',
  }), /desktop_thread_identity_mismatch/);
  assert.match(friendlyError(new Error('desktop_thread_identity_mismatch')), /已阻止操作.*会话身份不一致/);
});
