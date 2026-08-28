import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { normalizeBridgeUrl, parseFrame, tokenMatches } from '../src/shared/protocol.js';
import {
  displayAssistantMessage,
  displayUserMessage,
  parseAssistantMessage,
  parseUserMessage,
} from '../src/shared/message-content.js';
import { CodexAppServer, internals } from '../src/connector/codex-app-server.js';
import {
  CodexDesktopClient,
  internals as desktopInternals,
  mergeDesktopSessionStatuses,
} from '../src/connector/codex-desktop.js';
import { internals as rolloutInternals, readRolloutTail } from '../src/connector/rollout-tail.js';
import {
  isConnectionInterruption,
  markSessionAttentionRead,
  reconcileSessionAttention,
} from '../web/src/app-utils.js';

test('token comparison requires an exact non-empty match', () => {
  assert.equal(tokenMatches('a'.repeat(32), 'a'.repeat(32)), true);
  assert.equal(tokenMatches('a'.repeat(32), 'b'.repeat(32)), false);
  assert.equal(tokenMatches('', ''), false);
});

test('frame parser rejects arrays', () => {
  assert.deepEqual(parseFrame('{"type":"ping"}'), { type: 'ping' });
  assert.throws(() => parseFrame('[]'), /invalid_frame/);
});

test('connector supports ws and wss without allowing credentials in the URL', () => {
  assert.equal(normalizeBridgeUrl('ws://127.0.0.1:3300/ws'), 'ws://127.0.0.1:3300/ws');
  assert.equal(normalizeBridgeUrl('ws://203.0.113.10:3300/ws'), 'ws://203.0.113.10:3300/ws');
  assert.equal(normalizeBridgeUrl('wss://codex.example.com/ws'), 'wss://codex.example.com/ws');
  assert.throws(() => normalizeBridgeUrl('wss://user:secret@codex.example.com/ws'), /bridge_url_invalid/);
  assert.throws(() => normalizeBridgeUrl('wss://codex.example.com/ws?token=secret'), /bridge_url_invalid/);
});

test('desktop native pipe frames use a little-endian length prefix', () => {
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const frame = desktopInternals.encodeNativeFrame(message);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), message);
});

test('desktop follow-up includes the caller required by the native app protocol', async () => {
  const desktop = new CodexDesktopClient();
  let call;
  desktop.getClient = async () => ({
    request: async (method, params) => {
      call = { method, params };
      return { success: true };
    },
    close: () => {},
  });
  assert.deepEqual(await desktop.sendMessage({
    threadId: 'target-thread', text: '普通用户消息', requestId: 'request-1',
    callerThreadId: 'controller-thread',
  }), { threadId: 'target-thread', delivery: 'desktop' });
  assert.equal(call.method, 'tools/call');
  assert.equal(call.params.arguments.threadId, 'target-thread');
  assert.equal(call.params.arguments.prompt, '普通用户消息');
  assert.equal(call.params.threadId, 'controller-thread');
});

test('desktop task list status overrides stale app-server session status', () => {
  const payload = desktopInternals.parseToolPayload({
    success: true,
    contentItems: [{
      type: 'text',
      text: JSON.stringify({
        pinnedThreads: [{ id: 'thread-pinned', kind: 'codex', status: 'active' }],
        threads: [{ id: 'thread-running', kind: 'codex', status: 'active' }],
      }),
    }],
  });
  const desktopThreads = [...payload.pinnedThreads, ...payload.threads];
  assert.deepEqual(mergeDesktopSessionStatuses([
    { id: 'thread-running', status: 'notLoaded' },
    { id: 'thread-idle', status: 'notLoaded' },
  ], desktopThreads), [
    { id: 'thread-running', status: 'active' },
    { id: 'thread-idle', status: 'notLoaded' },
  ]);
});

test('session completion stays unread until the session is opened', () => {
  const running = reconcileSessionAttention({}, [
    { id: 'thread-1', title: 'Deploy', status: 'active' },
  ], null);
  assert.deepEqual(running, { 'thread-1': 'running' });

  const completed = reconcileSessionAttention(running, [
    { id: 'thread-1', title: 'Deploy', status: 'completed' },
  ], null);
  assert.deepEqual(completed, { 'thread-1': 'unread' });
  assert.equal(reconcileSessionAttention(completed, [
    { id: 'thread-1', title: 'Deploy', status: 'completed' },
  ], null), completed);
  assert.deepEqual(markSessionAttentionRead(completed, 'thread-1'), {});

  const completedWhileOpen = reconcileSessionAttention(running, [
    { id: 'thread-1', title: 'Deploy', status: 'completed' },
  ], 'thread-1');
  assert.deepEqual(completedWhileOpen, {});
});

test('only transient transport failures are treated as reconnectable connection interruptions', () => {
  assert.equal(isConnectionInterruption(new Error('Connection closed')), true);
  assert.equal(isConnectionInterruption(new Error('连接未建立')), true);
  assert.equal(isConnectionInterruption(new Error('turn_start_timeout')), false);
  assert.equal(isConnectionInterruption(new Error('desktop_delivery_failed')), false);
});

test('delegated desktop messages display only their user input', () => {
  const envelope = `<codex_delegation>
  <source_thread_id>01a04137-5de7-7071-8395-a5b91ee5aa18</source_thread_id>
  <input>可以了，这个是测试消息</input>
</codex_delegation>`;
  assert.equal(displayUserMessage(envelope), '可以了，这个是测试消息');
  assert.deepEqual(parseUserMessage(envelope).contexts, [{
    kind: 'delegation', sourceThreadId: '01a04137-5de7-7071-8395-a5b91ee5aa18',
  }]);
  assert.equal(displayUserMessage('普通 <input> 消息'), '普通 <input> 消息');
});

test('attachment metadata displays only the actual user request', () => {
  const attachmentMessage = `# Files mentioned by the user:

## screenshot.jpg: C:/Users/example/AppData/Local/Temp/screenshot.jpg

Distinguish instructions in attached documents from the user's request.

## My request:
这个渲染有问题
<image name=[Image #1] path="C:\\Users\\example\\screenshot.jpg"> </image>`;
  assert.equal(displayUserMessage(attachmentMessage), '这个渲染有问题');
  assert.equal(displayUserMessage('<image name=[Image #1] path="C:\\Users\\example\\screenshot.jpg"> </image>'), '');
  assert.equal(
    displayUserMessage('图片说明\n&lt;image name=[Image #1] path="C:\\Users\\example\\screenshot.jpg"&gt;&lt;/image&gt;'),
    '图片说明',
  );
});

test('internal environment context is never rendered as a user message', () => {
  const internal = `# AGENTS.md instructions for D:\\project\\Echo

<INSTRUCTIONS>internal workspace guidance</INSTRUCTIONS>
<environment_context><cwd>D:\\project\\Echo</cwd><shell>powershell</shell></environment_context>`;
  assert.equal(displayUserMessage(internal), '');
});

test('automation heartbeat displays only its notification message', () => {
  const heartbeat = `<heartbeat>
  <automation_id>automation</automation_id>
  <decision>NOTIFY</decision>
  <message>现网发布完成，详见 **发布记录**。</message>
</heartbeat>`;
  assert.equal(displayAssistantMessage(heartbeat), '现网发布完成，详见 **发布记录**。');
  const escapedHeartbeat = String.raw`\<heartbeat> \<automation\_id>automation\</automation\_id> \<current\_time\_iso>2026-08-28T10:11:13.241Z\</current\_time\_iso> \<instructions>执行现网升级\</instructions> \</heartbeat>`;
  assert.equal(displayAssistantMessage(escapedHeartbeat), '');
  assert.deepEqual(parseUserMessage(escapedHeartbeat), {
    text: '执行现网升级',
    contexts: [{
      kind: 'automation',
      automationId: 'automation',
      currentTimeIso: '2026-08-28T10:11:13.241Z',
      decision: undefined,
    }],
  });
  const escapedNotification = String.raw`\<heartbeat>\<decision>NOTIFY\</decision>\<message>发布完成\</message>\</heartbeat>`;
  assert.equal(displayAssistantMessage(escapedNotification), '发布完成');
  assert.equal(displayAssistantMessage('&lt;heartbeat&gt;&lt;message&gt;检查完成&lt;/message&gt;&lt;/heartbeat&gt;'), '检查完成');
  assert.deepEqual(parseAssistantMessage(heartbeat).contexts, [{
    kind: 'automation', automationId: 'automation', currentTimeIso: undefined, decision: 'NOTIFY',
  }]);
  assert.equal(displayAssistantMessage('解释 <heartbeat> 标签的含义'), '解释 <heartbeat> 标签的含义');
});

test('nested control envelopes keep presentation metadata without showing XML', () => {
  const nested = String.raw`<codex_delegation><source_thread_id>01a04137-5de7-7071-8395-a5b91ee5aa18</source_thread_id><input>\<heartbeat>\<automation\_id>daily-release\</automation\_id>\<instructions>升级现网\</instructions>\</heartbeat></input></codex_delegation>`;
  assert.deepEqual(parseUserMessage(nested), {
    text: '升级现网',
    contexts: [
      { kind: 'delegation', sourceThreadId: '01a04137-5de7-7071-8395-a5b91ee5aa18' },
      {
        kind: 'automation', automationId: 'daily-release', currentTimeIso: undefined, decision: undefined,
      },
    ],
  });
});

test('bare links stop before adjacent Chinese punctuation', () => {
  const message = '修复 PR https://github.com/tech-innovation-group/EchoAgent/pull/834；本次发布未登记备份。';
  assert.equal(
    displayAssistantMessage(message),
    '修复 PR <https://github.com/tech-innovation-group/EchoAgent/pull/834>；本次发布未登记备份。',
  );
  assert.equal(
    displayAssistantMessage('[查看 PR](https://github.com/tech-innovation-group/EchoAgent/pull/834)；继续'),
    '[查看 PR](https://github.com/tech-innovation-group/EchoAgent/pull/834)；继续',
  );
});

test('rollout tail mapping keeps only user-visible conversation updates', () => {
  const oversized = 'x'.repeat(5_000);
  const items = rolloutInternals.mapRolloutRows([
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'visible update' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'working' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: oversized } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [
      { type: 'output_text', text: 'done' },
    ] } },
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].type, 'userMessage');
  assert.equal(items[0].text, 'hello');
  assert.equal(items[1].phase, 'commentary');
  assert.equal(items[1].text, 'visible update');
  assert.equal(items[2].phase, 'final_answer');
  assert.equal(items[2].text, 'done');
});

test('rollout tail unwraps and deduplicates heartbeat event formats', () => {
  const heartbeat = '<heartbeat><decision>NOTIFY</decision><message>部署完成</message></heartbeat>';
  const items = rolloutInternals.mapRolloutRows([
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: heartbeat } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [
      { type: 'output_text', text: heartbeat },
    ] } },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '部署完成');
});

test('large rollout keeps activity across an incremental tail read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-large' } }),
      row({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(80 * 1024) } }),
      row({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [
        { type: 'output_text', text: 'still running' },
      ] } }),
    ].join(''));
    const running = await readRolloutTail({ filePath, threadId: 'thread-large', maxBytes: 64 * 1024 });
    assert.equal(running.turns[0].status, 'inProgress');
    assert.equal(running.turns[0].items.at(-1).text, 'still running');

    await appendFile(filePath, row({
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-large' },
    }));
    const completed = await readRolloutTail({ filePath, threadId: 'thread-large', maxBytes: 64 * 1024 });
    assert.equal(completed.turns[0].status, 'completed');
    assert.equal(completed.activityId, 'turn-large');
  } finally {
    rolloutInternals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('rollout activity requires an explicit task completion marker', () => {
  const started = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } };
  const completed = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } };
  assert.equal(rolloutInternals.inferRolloutStatus([]), 'unknown');
  assert.equal(rolloutInternals.inferRolloutStatus([started]), 'inProgress');
  assert.equal(rolloutInternals.inferRolloutStatus([started, completed]), 'completed');
  assert.equal(rolloutInternals.inferRolloutStatus([started, completed, started]), 'inProgress');
  assert.deepEqual(rolloutInternals.inferRolloutActivity([started, completed]), {
    status: 'completed', id: 'turn-1',
  });
});

test('both history readers hide the desktop delegation envelope', () => {
  const envelope = '<codex_delegation><source_thread_id>01a04137-5de7-7071-8395-a5b91ee5aa18</source_thread_id><input>plain prompt</input></codex_delegation>';
  const tailItems = rolloutInternals.mapRolloutRows([
    { type: 'event_msg', payload: { type: 'user_message', message: envelope } },
  ]);
  const turns = internals.mapTurns([{ id: 't1', items: [
    { type: 'userMessage', content: [{ type: 'text', text: envelope }] },
  ] }]);
  assert.equal(tailItems[0].text, 'plain prompt');
  assert.equal(tailItems[0].contexts[0].kind, 'delegation');
  assert.equal(turns[0].items[0].text, 'plain prompt');
  assert.equal(turns[0].items[0].contexts[0].kind, 'delegation');
});

test('approval results stay inside workspace and keep network disabled', () => {
  const result = internals.approvalResult('item/permissions/requestApproval', true, 'D:\\project\\demo');
  assert.deepEqual(result.permissions.fileSystem.read, ['D:\\project\\demo']);
  assert.deepEqual(result.permissions.fileSystem.write, ['D:\\project\\demo']);
  assert.equal(result.permissions.network.enabled, false);
});

test('history mapping keeps user-visible messages and hides internal work', () => {
  const turns = internals.mapTurns([{ id: 't1', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
    { type: 'agentMessage', phase: 'commentary', text: 'visible update' },
    { type: 'reasoning', summary: ['checking files'] },
    { type: 'commandExecution', command: 'npm test', aggregatedOutput: 'passed', status: 'completed' },
    { type: 'agentMessage', phase: 'final_answer', text: 'world' },
  ] }]);
  assert.equal(turns[0].items.length, 3);
  assert.equal(turns[0].items[0].text, 'hello');
  assert.equal(turns[0].items[1].text, 'visible update');
  assert.equal(turns[0].items[2].text, 'world');
});

test('conversation history uses a lightweight bounded descending cursor page', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  codex.rpcRaw = async (method, params) => {
    assert.equal(method, 'thread/turns/list');
    assert.deepEqual(params, {
      threadId: 'thread-1', limit: 10, sortDirection: 'desc', itemsView: 'summary', cursor: 'next-page',
    });
    return { data: [{ id: 'turn-1', status: 'completed', items: [] }], nextCursor: 'more' };
  };
  const result = await codex.listSessionTurns('thread-1', { cursor: 'next-page', limit: 999 });
  assert.equal(result.turns.length, 1);
  assert.equal(result.nextCursor, 'more');
});

test('live history keeps visible updates but never requests more than two turns', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  codex.listSessions = async () => [];
  codex.rpcRaw = async (method, params) => {
    assert.equal(method, 'thread/turns/list');
    assert.deepEqual(params, {
      threadId: 'thread-1', limit: 2, sortDirection: 'desc', itemsView: 'full',
    });
    return { data: [{ id: 'turn-1', status: 'inProgress', items: [
      { type: 'reasoning', summary: ['internal thought'] },
      { type: 'agentMessage', phase: 'commentary', text: 'still working' },
    ] }] };
  };
  const result = await codex.listSessionTurns('thread-1', { limit: 999, mode: 'live' });
  assert.equal(result.turns[0].items.length, 1);
  assert.equal(result.turns[0].items[0].text, 'still working');
});

test('live history follows the rollout instead of a stale app-server snapshot', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  codex.sessionMetadata.set('thread-1', { path: 'rollout.jsonl' });
  codex.rpcRaw = async () => { throw new Error('app server should not be queried'); };
  codex.readSessionTail = async (threadId, filePath) => ({
    threadId, filePath, turns: [{ id: 'tail', status: 'inProgress', items: [] }],
  });
  const result = await codex.listSessionTurns('thread-1', { mode: 'live' });
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.filePath, 'rollout.jsonl');
  assert.equal(result.turns[0].status, 'inProgress');
});

test('live history restores rollout metadata after a connector restart', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  codex.listSessions = async () => {
    codex.sessionMetadata.set('thread-1', { path: 'restored-rollout.jsonl' });
    return [];
  };
  codex.readSessionTail = async (threadId, filePath) => ({ threadId, filePath, turns: [] });
  const result = await codex.listSessionTurns('thread-1', { mode: 'live' });
  assert.equal(result.filePath, 'restored-rollout.jsonl');
});

test('active desktop writer waits and resumes the original thread without forking', async () => {
  const codex = new CodexAppServer({
    runtimeCwd: process.cwd(), activeWriterWaitMs: 100, activeWriterRetryMs: 1,
  });
  codex.ensureStarted = async () => {};
  const calls = [];
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'original', cwd: process.cwd() } };
    if (method === 'thread/resume' && calls.filter((call) => call.method === 'thread/resume').length === 1) {
      throw new Error('thread original already has an active writer');
    }
    return { thread: { id: 'original' } };
  };
  codex.sendRpcNotification = (method, params) => calls.push({ method, params });
  const result = await codex.startTurn({
    text: 'continue', threadId: 'original', cwd: join(process.cwd(), 'wrong-directory'),
    clientId: 'client', requestId: 'request',
  });
  assert.deepEqual(result, { threadId: 'original' });
  assert.equal(calls[0].method, 'thread/read');
  assert.equal(calls[1].method, 'thread/resume');
  assert.equal(calls[2].method, 'thread/resume');
  assert.equal(calls[3].method, 'turn/start');
  assert.equal(calls[3].params.threadId, 'original');
  assert.equal(calls[3].params.cwd, process.cwd());
  assert.equal(calls[1].params.cwd, process.cwd());
  assert.equal(calls.some((call) => call.method === 'thread/fork'), false);
});

test('active desktop writer wait has a bounded timeout', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd(), activeWriterWaitMs: 0 });
  codex.ensureStarted = async () => {};
  codex.rpcRaw = async (method) => {
    if (method === 'thread/read') return { thread: { id: 'original', cwd: process.cwd() } };
    throw new Error('thread original already has an active writer');
  };
  await assert.rejects(() => codex.startTurn({
    text: 'continue', threadId: 'original', cwd: process.cwd(), clientId: 'client', requestId: 'request',
  }), /thread_active_writer_timeout/);
});

test('non-writer resume errors are returned unchanged', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  codex.rpcRaw = async (method) => {
    if (method === 'thread/read') return { thread: { id: 'missing', cwd: process.cwd() } };
    throw new Error('thread_not_found');
  };
  codex.sendRpcNotification = () => {};
  await assert.rejects(() => codex.startTurn({
    text: 'continue', threadId: 'missing', cwd: process.cwd(), clientId: 'client', requestId: 'request',
  }), /thread_not_found/);
});

test('workspace selection cannot escape the configured root', () => {
  const root = resolve('allowed-root');
  const child = join(root, 'demo');
  const secondRoot = resolve('second-root');
  assert.equal(
    internals.resolveAllowedWorkspace([root, secondRoot], child),
    child,
  );
  assert.equal(internals.resolveAllowedWorkspace([root, secondRoot], secondRoot), secondRoot);
  assert.equal(internals.isAllowedWorkspace([root, secondRoot], child), true);
  assert.equal(internals.isAllowedWorkspace([root, secondRoot], resolve('outside-root')), false);
  assert.throws(
    () => internals.resolveAllowedWorkspace([root, secondRoot], resolve('outside-root')),
    /workspace_outside_allowed_root/,
  );
});

test('new sessions require an explicit project directory', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  await assert.rejects(
    () => codex.startTurn({ text: 'hello' }),
    /project_directory_required/,
  );
  assert.equal(codex.activeTurn, null);
});
