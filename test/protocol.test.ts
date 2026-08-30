import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createConnectorAuthProof } from '../src/shared/auth.js';
import {
  createDeviceAuthProof,
  createDeviceIdentity,
  verifyDeviceAuthProof,
} from '../src/shared/device-auth.js';
import { normalizeBridgeUrl, parseFrame, secretMatches } from '../src/shared/protocol.js';
import {
  createProtocolOffer,
  requireCurrentProtocol,
} from '../src/shared/protocol-contract.js';
import {
  browserPairingFragment,
  browserPairingVerifier,
  createBrowserPairingCredential,
  createBrowserPairingProof,
  parseBrowserPairingCredential,
} from '../src/shared/pairing-auth.js';
import {
  displayAssistantMessage,
  displayUserMessage,
  parseAssistantMessage,
  parseUserMessage,
} from '../src/shared/message-content.js';
import {
  extractPlanProgressFromToolInput,
  normalizeTurnProgress,
  summarizePatchChanges,
  summarizeUnifiedDiff,
} from '../src/shared/turn-progress.js';
import { summarizeToolActivity } from '../src/shared/activity-detail.js';
import { CodexAppServer, internals } from '../src/connector/codex-app-server.js';
import {
  CodexDesktopClient,
  internals as desktopInternals,
  mergeDesktopSessionStatuses,
} from '../src/connector/codex-desktop.js';
import {
  internals as rolloutInternals,
  readRolloutModelSettings,
  readRolloutTail,
} from '../src/connector/rollout-tail.js';
import { needsDesktopPermissionRecovery } from '../src/connector/session-permissions.js';
import {
  canSendToActiveDesktopTurn,
  canStopOwnedTurn,
  canSteerOwnedTurn,
  composerPrimaryAction,
  friendlyError,
  initialBootstrapReady,
  isNearScrollBottom,
  isConnectionInterruption,
  markSessionAttentionRead,
  reconcileSessionAttention,
  replayPendingFrames,
  shouldLoadOlderHistory,
  shouldPrefillOlderHistory,
} from '../web/src/app-utils.js';
import {
  attachLatestAssistantFileChanges,
  historyFingerprint,
  historyItems,
  latestTurnProgressItemId,
  mergeHistorySnapshot,
  progressTypewriterKey,
} from '../web/src/history-utils.js';
import { MessageBubble, messagePresentationEqual } from '../web/src/message-bubble.js';
import { ConversationTimeline } from '../web/src/conversation-timeline.js';
import {
  resolveTypewriterUpdate,
  seedTypewriterText,
  TypewriterText,
} from '../web/src/ui-components.js';

test('connector bootstrap proofs are route and challenge bound', () => {
  const token = 'a'.repeat(32);
  const challenge = 'b'.repeat(64);
  const proof = createConnectorAuthProof(token, challenge, 'pc');
  assert.equal(proof.length, 64);
  assert.equal(secretMatches(proof, createConnectorAuthProof(token, challenge, 'pc')), true);
  assert.equal(secretMatches(proof, createConnectorAuthProof(token, 'c'.repeat(64), 'pc')), false);
  assert.equal(
    secretMatches(
      createConnectorAuthProof(token, challenge, 'pc'),
      createConnectorAuthProof(token, challenge, 'other-pc'),
    ),
    false,
  );
  assert.throws(() => createConnectorAuthProof(token, 'not-a-challenge', 'pc'), /invalid_auth_challenge/);
});

test('device signatures are key, token proof, role, route and challenge bound', () => {
  const identity = createDeviceIdentity();
  const params = {
    challenge: 'b'.repeat(64),
    role: 'connector' as const,
    routeDeviceId: 'personal-pc',
    authProof: 'c'.repeat(64),
  };
  const proof = createDeviceAuthProof(identity, params, 'Test connector');
  assert.equal(proof.id.length, 64);
  assert.equal(proof.signature.length, 128);
  assert.equal(verifyDeviceAuthProof(proof, params), true);
  assert.equal(verifyDeviceAuthProof(proof, { ...params, challenge: 'd'.repeat(64) }), false);
  assert.equal(verifyDeviceAuthProof(proof, { ...params, authProof: 'e'.repeat(64) }), false);
  assert.equal(verifyDeviceAuthProof(proof, { ...params, routeDeviceId: 'other-pc' }), false);
  assert.equal(verifyDeviceAuthProof(proof, { ...params, role: 'client' }), false);

  const attacker = createDeviceIdentity();
  assert.equal(verifyDeviceAuthProof({ ...proof, publicKey: attacker.publicKey }, params), false);
  assert.throws(() => createDeviceIdentity('00'), /invalid_device_private_key/);
});

test('frame parser rejects arrays', () => {
  assert.deepEqual(parseFrame('{"type":"ping"}'), { type: 'ping' });
  assert.throws(() => parseFrame('[]'), /invalid_frame/);
});

test('protocol validation requires the current version and every mandatory capability', () => {
  const current = createProtocolOffer();
  assert.deepEqual(requireCurrentProtocol(current), current);
  assert.throws(() => requireCurrentProtocol(undefined), /protocol_offer_required/);
  assert.throws(() => requireCurrentProtocol({ ...current, version: 2 }), /protocol_version_unsupported/);
  assert.throws(() => requireCurrentProtocol({
    ...current,
    capabilities: current.capabilities.filter((capability) => capability !== 'e2ee-channel.v1'),
  }), /protocol_capability_required/);
  assert.equal(current.capabilities.includes('strict-protocol.v1'), true);
  assert.equal(current.capabilities.includes('e2ee-channel.v1'), true);
});

test('browser pairing links are fragment-only and challenge bound', () => {
  const credential = createBrowserPairingCredential();
  const fragment = browserPairingFragment(credential);
  const parsed = parseBrowserPairingCredential(`https://codex.example.com/#${fragment}`);
  assert.deepEqual(parsed, credential);
  const identity = createDeviceIdentity();
  const verifier = browserPairingVerifier(credential.secret);
  const input = {
    verifier,
    challenge: 'a'.repeat(64),
    pairingId: credential.id,
    deviceId: identity.id,
    publicKey: identity.publicKey,
  };
  const proof = createBrowserPairingProof(input);
  assert.equal(proof.length, 64);
  assert.notEqual(proof, createBrowserPairingProof({ ...input, challenge: 'b'.repeat(64) }));
  assert.throws(() => parseBrowserPairingCredential('not-a-pairing'), /browser_pairing_invalid/);
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
    callerThreadId: 'controller-thread', model: 'gpt-5.6-sol', thinking: 'high',
  }), { threadId: 'target-thread', delivery: 'desktop' });
  assert.equal(call.method, 'tools/call');
  assert.equal(call.params.arguments.threadId, 'target-thread');
  assert.equal(call.params.arguments.prompt, '普通用户消息');
  assert.equal(call.params.arguments.model, 'gpt-5.6-sol');
  assert.equal(call.params.arguments.thinking, 'high');
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

test('desktop thread state exposes waiting approval without loading conversation history', async () => {
  const desktop = new CodexDesktopClient();
  let call;
  desktop.callTool = async (request) => {
    call = request;
    return {
      success: true,
      contentItems: [{ text: JSON.stringify({
        thread: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
      }) }],
    };
  };
  assert.deepEqual(await desktop.readThreadState({
    threadId: 'thread-1', callerThreadId: 'controller-thread',
  }), { status: 'active', waitingOnApproval: true });
  assert.equal(call.tool, 'read_thread');
  assert.equal(call.arguments.turnLimit, 1);
  assert.equal(call.arguments.includeOutputs, false);
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

test('stop control is shown only for the selected Web-owned turn', () => {
  assert.equal(canStopOwnedTurn(false, 'thread-1', 'thread-1'), false);
  assert.equal(canStopOwnedTurn(true, null, 'thread-1'), false);
  assert.equal(canStopOwnedTurn(true, 'thread-1', 'thread-2'), false);
  assert.equal(canStopOwnedTurn(true, 'thread-1', 'thread-1'), true);
});

test('the primary composer action stops only when an owned run has no pending input', () => {
  assert.equal(composerPrimaryAction(true, '', false), 'stop');
  assert.equal(composerPrimaryAction(true, '追加指令', false), 'send');
  assert.equal(composerPrimaryAction(true, '', true), 'send');
  assert.equal(composerPrimaryAction(false, '', false), 'send');
});

test('steering is available only while the selected Web-owned turn is actively running', () => {
  assert.equal(canSteerOwnedTurn(true, 'running', 'thread-1', 'thread-1'), true);
  assert.equal(canSteerOwnedTurn(true, 'waiting', 'thread-1', 'thread-1'), false);
  assert.equal(canSteerOwnedTurn(true, 'running', 'thread-1', 'thread-2'), false);
  assert.equal(canSteerOwnedTurn(false, 'running', 'thread-1', 'thread-1'), false);
});

test('Desktop-owned active sessions accept direct delivery', () => {
  assert.equal(canSendToActiveDesktopTurn(false, 'running', null, 'thread-1'), true);
  assert.equal(canSendToActiveDesktopTurn(true, 'running', null, 'thread-1'), false);
  assert.equal(canSendToActiveDesktopTurn(false, 'waiting', null, 'thread-1'), false);
  assert.equal(canSendToActiveDesktopTurn(false, 'running', 'thread-1', 'thread-1'), false);
  assert.equal(canSendToActiveDesktopTurn(false, 'running', null, null), false);
});

test('automatic message following tolerates a small mobile bottom offset', () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 650, clientHeight: 200 }), true);
  assert.equal(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 619, clientHeight: 200 }), false);
});

test('older history loads only near the top with another page available', () => {
  assert.equal(shouldLoadOlderHistory({ scrollTop: 80 }, 'next', true, false), true);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 220 }, 'next', true, false), false);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 80 }, null, true, false), false);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 80 }, 'next', false, false), false);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 80 }, 'next', true, true), false);
});

test('older history prefill runs only when the list cannot leave the top trigger area', () => {
  assert.equal(shouldPrefillOlderHistory(
    { scrollHeight: 1_000, clientHeight: 900 }, 'next', true, false,
  ), true);
  assert.equal(shouldPrefillOlderHistory(
    { scrollHeight: 1_000, clientHeight: 700 }, 'next', true, false,
  ), false);
  assert.equal(shouldPrefillOlderHistory(
    { scrollHeight: 1_000, clientHeight: 900 }, null, true, false,
  ), false);
  assert.equal(shouldPrefillOlderHistory(
    { scrollHeight: 1_000, clientHeight: 900 }, 'next', true, true,
  ), false);
});

test('older history keeps a stable label while a page is loading', async () => {
  const timelineSource = await readFile(resolve('web/src/conversation-timeline.tsx'), 'utf8');
  assert.match(timelineSource, /aria-busy=\{historyLoading\}/);
  assert.doesNotMatch(timelineSource, /historyLoading \? t\('正在加载…'/);
});

test('empty intermediate history pages keep one stable loading surface', () => {
  const markup = renderToStaticMarkup(createElement(ConversationTimeline, {
    messageListRef: { current: null },
    messageContentRef: { current: null },
    threadId: 'large-thread',
    creatingNewSession: false,
    initialHistoryLoaded: true,
    nextCursor: 'rollout:v1:1048576',
    historyLoading: false,
    timeline: [],
    knownAttachments: {},
    attachmentUrls: {},
    executionActive: true,
    progressAnimationReady: false,
    liveProgressItemId: null,
    onScroll: () => undefined,
    onLoadOlder: () => undefined,
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  }));

  assert.match(markup, /class="history-skeleton"/);
  assert.doesNotMatch(markup, /class="empty-conversation"/);
  assert.doesNotMatch(markup, /class="load-older"/);
});

test('initial bootstrap waits for both sessions and the restored conversation', () => {
  assert.equal(initialBootstrapReady(false, false, 0, null, false), false);
  assert.equal(initialBootstrapReady(true, false, 0, null, false), false);
  assert.equal(initialBootstrapReady(true, true, 0, null, false), true);
  assert.equal(initialBootstrapReady(true, true, 3, null, false), false);
  assert.equal(initialBootstrapReady(true, true, 3, 'thread-1', false), false);
  assert.equal(initialBootstrapReady(true, true, 3, 'thread-1', true), true);
});

test('only transient transport failures are treated as reconnectable connection interruptions', () => {
  assert.equal(isConnectionInterruption(new Error('Connection closed')), true);
  assert.equal(isConnectionInterruption(new Error('连接未建立')), true);
  assert.equal(isConnectionInterruption(new Error('turn_start_timeout')), false);
  assert.equal(isConnectionInterruption(new Error('desktop_delivery_failed')), false);
  assert.equal(friendlyError(new Error('request_timeout')).includes('恢复到输入框'), false);
});

test('pending secure requests replay in order and stop when the channel becomes unavailable', () => {
  const sent: Record<string, unknown>[] = [];
  const pending = [
    { frame: { type: 'request', requestId: 'r1' } },
    { frame: { type: 'request', requestId: 'r2' } },
    { frame: { type: 'request', requestId: 'r3' } },
  ];
  assert.equal(replayPendingFrames(pending, (frame) => {
    sent.push(frame);
    return frame.requestId !== 'r2';
  }), 1);
  assert.deepEqual(sent.map((frame) => frame.requestId), ['r1', 'r2']);
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
  const internal = `# AGENTS.md instructions for D:\\project\\SampleProject

<INSTRUCTIONS>internal workspace guidance</INSTRUCTIONS>
<environment_context><cwd>D:\\project\\SampleProject</cwd><shell>powershell</shell></environment_context>`;
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
  const message = '修复 PR https://github.com/example-org/sample-project/pull/834；本次发布未登记备份。';
  assert.equal(
    displayAssistantMessage(message),
    '修复 PR <https://github.com/example-org/sample-project/pull/834>；本次发布未登记备份。',
  );
  assert.equal(
    displayAssistantMessage('[查看 PR](https://github.com/example-org/sample-project/pull/834)；继续'),
    '[查看 PR](https://github.com/example-org/sample-project/pull/834)；继续',
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

test('rollout history keeps complete final replies while bounding progress updates', () => {
  const longText = '完整回复。'.repeat(1_000);
  const items = rolloutInternals.mapRolloutRows([
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: longText } },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: longText } },
  ]);

  assert.equal(items[0].text, `${longText.slice(0, 4_000)}\n…（已截断）`);
  assert.equal(items[1].text, longText);
  assert.equal(items[1].text.includes('已截断'), false);
});

test('history messages keep their real sent and completed times', () => {
  const startedAt = '2026-08-29T01:02:03.000Z';
  const completedAt = '2026-08-29T01:03:04.000Z';
  const turns = internals.mapTurns([{
    id: 'timed-turn', status: 'completed', startedAt, completedAt, items: [
      { type: 'userMessage', text: 'question' },
      { type: 'agentMessage', phase: 'final_answer', text: 'answer' },
    ],
  }]);
  const items = historyItems(turns);
  assert.equal(items[0].completedAt, startedAt);
  assert.equal(items[1].completedAt, completedAt);

  const rolloutItems = rolloutInternals.mapRolloutRows([{
    timestamp: completedAt,
    type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'answer' },
  }]);
  assert.equal(rolloutItems[0].completedAt, Date.parse(completedAt));
});

test('history readers expose generated images as lightweight local references', () => {
  const path = 'C:\\Users\\example\\.codex\\generated_images\\thread-1\\result.png';
  const tailItems = rolloutInternals.mapRolloutRows([{
    type: 'event_msg',
    payload: {
      type: 'image_generation_end', status: 'completed', saved_path: path,
      result: 'data:image/png;base64,' + 'x'.repeat(5_000),
    },
  }]);
  assert.deepEqual(tailItems, [{
    type: 'agentMessage',
    phase: 'final_answer',
    text: '',
    attachment: { path, name: 'result.png', source: 'generated' },
    status: '', name: '', input: '', output: '',
  }]);

  const turns = internals.mapTurns([{ id: 't1', items: [{
    type: 'imageGeneration', status: 'completed', savedPath: path,
  }] }]);
  assert.deepEqual(turns[0].items, [{
    type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '',
    attachment: { path, name: 'result.png', source: 'generated' },
  }]);

  assert.deepEqual(historyItems(turns), [{
    id: 'history:t1:0', kind: 'assistant', text: '', historyTurnId: 't1',
    attachment: { path, name: 'result.png', source: 'generated' }, contexts: [],
  }]);
});

test('assistant Markdown images become safe local preview references', () => {
  const items = historyItems([{
    id: 'turn-local-image',
    items: [{
      type: 'assistant',
      text: '图已生成：\n\n![Architecture](D:/workspace/diagrams/architecture.png)\n\n[SVG](D:/workspace/diagrams/architecture.svg)',
    }],
  }]);

  assert.deepEqual(items[0].attachment, {
    path: 'D:\\workspace\\diagrams\\architecture.png',
    name: 'Architecture',
    source: 'local',
  });
  assert.equal(items[0].text, '图已生成：\n\n[SVG](D:/workspace/diagrams/architecture.svg)');
  assert.doesNotMatch(items[0].text, /!\[Architecture\]/);

  const svgOnly = historyItems([{
    id: 'turn-local-svg',
    items: [{ type: 'assistant', text: '![Diagram](D:/workspace/diagrams/architecture.svg)' }],
  }]);
  assert.equal(svgOnly[0].attachment, undefined);
});

test('visualize HTML markers become isolated artifact references', () => {
  const items = historyItems([{
    id: 'turn-visualization',
    items: [{
      type: 'assistant',
      text: '这里是交互稿。\n\nvisualize {"path":"C:/Users/example/.codex/visualizations/thread/concept.html"}\n\n请查看设计。',
    }],
  }]);

  assert.equal(items[0].text, '这里是交互稿。\n\n请查看设计。');
  assert.deepEqual(items[0].visualization, {
    path: 'C:\\Users\\example\\.codex\\visualizations\\thread\\concept.html',
    name: 'concept.html',
    source: 'visualize',
  });
});

test('historical Codex visualization markers become isolated artifact references', () => {
  const items = historyItems([{
    id: 'turn-historical-visualization',
    items: [{
      type: 'AgentMessage',
      phase: 'final_answer',
      text: '这里是交互稿。\n\n\uE200visualize\uE202{"path":"C:/Users/example/.codex/visualizations/thread/concept.html"}\uE201\n\n请查看设计。',
    }],
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '这里是交互稿。\n\n请查看设计。');
  assert.deepEqual(items[0].visualization, {
    path: 'C:\\Users\\example\\.codex\\visualizations\\thread\\concept.html',
    name: 'concept.html',
    source: 'visualize',
  });
});

test('history merge replaces an optimistic image message without duplicating it', () => {
  const attachment = {
    path: 'C:\\Users\\example\\AppData\\Local\\Temp\\bridge\\photo.jpg',
    name: 'photo.jpg',
  };
  const current = [{
    id: 'optimistic', kind: 'user' as const, text: '这是什么？', transient: true, attachment,
  }];
  const latest = [{
    id: 'history:turn-new:0', kind: 'user' as const, text: '这是什么？', historyTurnId: 'turn-new',
  }];

  assert.deepEqual(mergeHistorySnapshot(current, latest, new Set(['turn-new'])), [{
    ...latest[0], id: 'optimistic', attachment,
  }]);
});

test('history merge preserves an optimistic user message DOM identity', () => {
  const current = [{
    id: 'optimistic-user', kind: 'user' as const, text: '继续处理', transient: true,
  }];
  const latest = [{
    id: 'history:turn-new:0', kind: 'user' as const, text: '继续处理', historyTurnId: 'turn-new',
    contexts: [{ kind: 'delegation' as const, sourceThreadId: 'source-thread' }],
  }];

  const merged = mergeHistorySnapshot(current, latest, new Set(['turn-new']));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'optimistic-user');
  assert.equal(merged[0].historyTurnId, 'turn-new');
});

test('history merge carries unpublished progress into its turn when a later turn appears', () => {
  const current = [
    { id: 'old-user', kind: 'user' as const, text: 'first', historyTurnId: 'turn-old' },
    {
      id: 'live-progress', kind: 'progress' as const, text: 'initial progress',
      historyTurnId: 'turn-old', transient: true,
    },
  ];
  const latest = [
    { id: 'history-old-user', kind: 'user' as const, text: 'first', historyTurnId: 'turn-old' },
    { id: 'history-old-answer', kind: 'assistant' as const, text: 'done', historyTurnId: 'turn-old' },
    { id: 'history-new-user', kind: 'user' as const, text: 'second', historyTurnId: 'turn-new' },
  ];

  const merged = mergeHistorySnapshot(current, latest, new Set(['turn-old', 'turn-new']));
  assert.deepEqual(merged.map((item) => item.id), [
    'history-old-user', 'live-progress', 'history-old-answer', 'history-new-user',
  ]);
  assert.equal(merged[1], current[1]);
});

test('history merge preserves a growing progress block identity for incremental animation', () => {
  const current = [{
    id: 'stable-progress', kind: 'progress' as const, text: '已完成检查。', historyTurnId: 'turn-live',
  }];
  const latest = [{
    id: 'history:turn-live:8', kind: 'progress' as const,
    text: '已完成检查。\n\n正在执行测试。', historyTurnId: 'turn-live',
  }];

  const merged = mergeHistorySnapshot(current, latest, new Set(['turn-live']));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'stable-progress');
  assert.equal(merged[0].text, latest[0].text);
});

test('history merge keeps completed reply file changes when a new turn arrives', () => {
  const current = [{
    id: 'old-reply', kind: 'assistant' as const, text: 'implemented', historyTurnId: 'turn-old',
    fileChanges: { changed: 2, additions: 8, deletions: 3 },
  }];
  const latest = [
    { id: 'persisted-reply', kind: 'assistant' as const, text: 'implemented', historyTurnId: 'turn-old' },
    { id: 'new-message', kind: 'user' as const, text: 'continue', historyTurnId: 'turn-new' },
  ];

  const merged = mergeHistorySnapshot(current, latest, new Set(['turn-old', 'turn-new']));
  assert.deepEqual(merged.find((item) => item.text === 'implemented')?.fileChanges, {
    changed: 2, additions: 8, deletions: 3,
  });
});

test('image previews open in the page instead of navigating to a data URL', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    item: {
      id: 'image-message', kind: 'assistant' as const, text: '更新后的图片',
      attachment: { path: 'D:\\workspace\\diagram.png', name: 'diagram.png', source: 'local' as const },
    },
    imageSource: 'data:image/webp;base64,UklGRg==',
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  }));

  assert.match(markup, /class="message-image-preview"/);
  assert.doesNotMatch(markup, /href="data:image\/webp/);
});

test('only active timeline items receive live motion classes', () => {
  const props = {
    item: { id: 'live-reply', kind: 'assistant' as const, text: '正在生成回复' },
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  };
  const activeMarkup = renderToStaticMarkup(createElement(MessageBubble, { ...props, active: true }));
  const historyMarkup = renderToStaticMarkup(createElement(MessageBubble, props));

  assert.match(activeMarkup, /class="message assistant copyable live"/);
  assert.match(historyMarkup, /class="message assistant copyable"/);
  assert.doesNotMatch(historyMarkup, /class="message assistant copyable live"/);
});

test('only newly completed transient replies receive the final card animation', () => {
  const props = {
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  };
  const finalMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    ...props,
    item: {
      id: 'new-final', kind: 'assistant' as const, text: '最终回复', transient: true, completedAt: Date.now(),
    },
  }));
  const historyMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    ...props,
    item: {
      id: 'history-final', kind: 'assistant' as const, text: '历史回复', completedAt: Date.now(),
    },
  }));

  assert.match(finalMarkup, /class="message assistant copyable final-arriving"/);
  assert.doesNotMatch(historyMarkup, /final-arriving/);
});

test('message time and copy action render outside the message card', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    item: {
      id: 'compact-meta', kind: 'assistant' as const, text: '回复', completedAt: Date.now(),
    },
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  }));

  assert.match(markup, /class="message-block assistant copyable"/);
  assert.match(markup, /<\/div><div class="message-meta">/);
});

test('delegation metadata does not add hidden layout inside user bubbles', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    item: {
      id: 'delegated-user', kind: 'user' as const, text: '继续处理',
      contexts: [{ kind: 'delegation' as const, sourceThreadId: 'source-thread' }],
    },
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  }));

  assert.doesNotMatch(markup, /message-contexts/);
  assert.match(markup, /class="message user copyable"[\s\S]*?<p>继续处理<\/p>/);
});

test('aggregate file changes attach only to the latest completed reply', () => {
  const items = [
    { id: 'old-user', kind: 'user' as const, text: 'first' },
    { id: 'old-answer', kind: 'assistant' as const, text: 'old answer' },
    { id: 'new-user', kind: 'user' as const, text: 'second' },
    { id: 'progress', kind: 'progress' as const, text: 'working' },
    { id: 'new-answer', kind: 'assistant' as const, text: 'new answer' },
  ];
  const attached = attachLatestAssistantFileChanges(items, {
    files: { changed: 3, additions: 12, deletions: 4 },
  });

  assert.equal(attached[1].fileChanges, undefined);
  assert.deepEqual(attached[4].fileChanges, { changed: 3, additions: 12, deletions: 4 });
  assert.equal(attachLatestAssistantFileChanges(items, {}).includes(items[4]), true);
});

test('live history fingerprint changes when aggregate file progress arrives after the reply', () => {
  const turns = [{
    id: 'late-progress', status: 'completed',
    items: [{ type: 'agentMessage', phase: 'final_answer', text: 'done' }],
  }];

  assert.notEqual(
    historyFingerprint(turns),
    historyFingerprint(turns, { files: { changed: 2, additions: 8, deletions: 3 } }),
  );
});

test('assistant file changes share the compact time and copy metadata row', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    item: {
      id: 'reply-with-changes', kind: 'assistant' as const, text: '完成', completedAt: Date.now(),
      fileChanges: { changed: 3, additions: 12, deletions: 4 },
    },
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  }));

  assert.match(markup, /class="message-change-summary"/);
  assert.match(markup, /3 个文件已更改/);
  assert.match(markup, /class="additions">\+12/);
  assert.match(markup, /class="deletions">−4/);
  assert.match(markup, /message-change-summary[\s\S]*message-time[\s\S]*message-copy/);
});

test('message metadata reserves stable space before completion time arrives', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    item: { id: 'streaming-meta', kind: 'assistant' as const, text: '回复生成中' },
    onDownloadFile: () => undefined,
    onReadVisualization: async () => '',
  }));

  assert.match(markup, /class="message-time placeholder"[^>]*>00\/00 00:00<\/span>/);
  assert.match(markup, /class="message-copy idle"/);
});

test('message metadata stays in a fixed sibling row outside the bubble', async () => {
  const stylesSource = await readFile(resolve('web/src/styles.scss'), 'utf8');
  const responsiveSource = await readFile(resolve('web/src/styles/_responsive.scss'), 'utf8');
  assert.match(stylesSource, /\.message-block\s*\{[\s\S]*?width:\s*min\(96%, 920px\);[\s\S]*?display:\s*flex;/);
  assert.doesNotMatch(stylesSource, /\.message-block\s*\{[^}]*width:\s*fit-content;/);
  assert.match(stylesSource, /\.message-meta\s*\{[\s\S]*?height:\s*18px;[\s\S]*?flex:\s*0 0 18px;/);
  assert.doesNotMatch(stylesSource, /\.message-meta\s*\{[^}]*position:\s*absolute;/);
  assert.match(stylesSource, /&\.user::before,\s*&\.assistant::before/);
  assert.match(stylesSource, /&\.user\s*\{[\s\S]*?border-radius:\s*18px 18px 5px 18px;/);
  assert.match(stylesSource, /&\.assistant\s*\{[\s\S]*?border-radius:\s*18px 18px 18px 5px;/);
  assert.match(stylesSource, /--bubble-tail-color:\s*#315fc5;[\s\S]*?var\(--bubble-tail-color\) 82%/);
  assert.match(stylesSource, /--bubble-tail-color:\s*#151c29;[\s\S]*?background:\s*var\(--bubble-tail-color\);/);
  assert.doesNotMatch(stylesSource, /&\.assistant\s*\{[^}]*border:\s*1px/);
  assert.match(stylesSource, /&\.user::before,\s*&\.assistant::before\s*\{[\s\S]*?background:\s*var\(--bubble-tail-color\);/);
  assert.match(responsiveSource, /\.message-block\s*\{\s*width:\s*96%;\s*max-width:\s*96%;\s*\}/);
});

test('mobile header controls suppress transient tap rectangles without hiding keyboard focus', async () => {
  const stylesSource = await readFile(resolve('web/src/styles.scss'), 'utf8');
  assert.match(
    stylesSource,
    /\.topbar\s*>\s*\.icon-button,\s*\n\.model-config-summary\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent;[\s\S]*?touch-action:\s*manipulation;/,
  );
  assert.match(stylesSource, /&:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none;\s*\}/);
  assert.match(stylesSource, /\.icon-button\s*\{[\s\S]*?&:focus-visible\s*\{\s*outline:\s*2px solid #6798ff;/);
});

test('message presentation equality skips unchanged polling snapshots', () => {
  const first = {
    id: 'reply', kind: 'assistant' as const, text: 'done', completedAt: 123,
    fileChanges: { changed: 2, additions: 8, deletions: 3 },
  };
  assert.equal(messagePresentationEqual(first, { ...first, fileChanges: { ...first.fileChanges } }), true);
  assert.equal(messagePresentationEqual(first, { ...first, text: 'updated' }), false);
  assert.equal(messagePresentationEqual(first, {
    ...first, fileChanges: { changed: 3, additions: 8, deletions: 3 },
  }), false);
});

test('conversation loads the Markdown renderer outside the startup bundle', async () => {
  const timelineSource = await readFile(resolve('web/src/conversation-timeline.tsx'), 'utf8');
  assert.match(timelineSource, /lazy\(\(\) => import\('\.\/message-bubble'\)/);
  assert.match(timelineSource, /<Suspense fallback=/);
  assert.doesNotMatch(timelineSource, /import \{ MessageBubble \} from '\.\/message-bubble'/);
});

test('progress animation waits until initial history hydration finishes', async () => {
  const timelineSource = await readFile(resolve('web/src/conversation-timeline.tsx'), 'utf8');
  const bubbleSource = await readFile(resolve('web/src/message-bubble.tsx'), 'utf8');
  const appSource = await readFile(resolve('web/src/App.tsx'), 'utf8');
  assert.match(timelineSource, /progressAnimationReady && item\.id === liveProgressItemId/);
  assert.match(bubbleSource, /continuityKey=\{progressTypewriterKey\(item\)\}/);
  assert.match(appSource, /seedTypewriterText\(progressTypewriterKey\(item\), item\.text\)/);
});

test('hydrated progress starts complete and only a later suffix is animated', () => {
  const item = { id: 'history:turn-hydrated:1', historyTurnId: 'turn-hydrated' };
  const key = progressTypewriterKey(item);
  seedTypewriterText(key, '已有进度');

  const hydrated = renderToStaticMarkup(createElement(TypewriterText, {
    text: '已有进度', active: true, continuityKey: key,
  }));
  assert.match(hydrated, />已有进度</);
  assert.doesNotMatch(hydrated, /typing/);

  const updated = renderToStaticMarkup(createElement(TypewriterText, {
    text: '已有进度\n新增进度', active: true, continuityKey: key,
  }));
  assert.match(updated, />已有进度</);
  assert.doesNotMatch(updated, /新增进度/);
  assert.match(updated, /typing/);
});

test('a non-prefix polling snapshot replaces progress without replaying it', () => {
  assert.deepEqual(resolveTypewriterUpdate('替换后的实时快照', '旧的分页快照'), {
    from: '替换后的实时快照', animate: false,
  });
  const key = 'progress:non-prefix-snapshot';
  seedTypewriterText(key, '旧的分页快照');
  const replaced = renderToStaticMarkup(createElement(TypewriterText, {
    text: '替换后的实时快照', active: true, continuityKey: key,
  }));
  assert.match(replaced, />替换后的实时快照</);
  assert.doesNotMatch(replaced, /typing/);
});

test('the first live snapshot is hydrated before it can animate', async () => {
  const appSource = await readFile(resolve('web/src/App.tsx'), 'utf8');
  assert.match(appSource, /liveHistoryHydratedThreadRef\.current !== threadId/);
  assert.match(appSource, /seedTypewriterText\(progressTypewriterKey\(liveProgress\), liveProgress\.text\)/);
});

test('only progress after the latest user message is treated as the live progress block', () => {
  assert.equal(latestTurnProgressItemId([
    { id: 'old-user', kind: 'user', text: 'first' },
    { id: 'old-progress', kind: 'progress', text: 'old progress' },
    { id: 'new-user', kind: 'user', text: 'second' },
  ]), null);
  assert.equal(latestTurnProgressItemId([
    { id: 'old-progress', kind: 'progress', text: 'old progress' },
    { id: 'new-user', kind: 'user', text: 'second' },
    { id: 'live-progress', kind: 'progress', text: 'new progress from polling' },
  ]), 'live-progress');
});

test('rollout tail recovers a generated image reference from a truncated Base64 event row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-image-'));
  const filePath = join(directory, 'rollout.jsonl');
  const path = 'C:\\Users\\example\\.codex\\generated_images\\thread-1\\result.png';
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({
        type: 'event_msg', payload: {
          type: 'image_generation_end', status: 'completed', result: 'x'.repeat(80 * 1024), saved_path: path,
        },
      }),
      row({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(40 * 1024) } }),
      row({
        type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [
          { type: 'output_text', text: 'image ready' },
        ] },
      }),
    ].join(''));
    const result = await readRolloutTail({ filePath, threadId: 'thread-image', maxBytes: 64 * 1024 });
    assert.equal(result.turns[0].items[0].attachment.path, path);
    assert.equal(result.turns[0].items[1].text, 'image ready');
  } finally {
    rolloutInternals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
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
      row({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', input: `const result = await tools.update_plan({plan:[
          {step:"inspect",status:"completed"},{step:"verify",status:"in_progress"}
        ]});`,
      } }),
      row({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(80 * 1024) } }),
      row({ type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Checking persistent state**' } }),
      row({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [
        { type: 'output_text', text: 'still running' },
      ] } }),
    ].join(''));
    const running = await readRolloutTail({ filePath, threadId: 'thread-large', maxBytes: 64 * 1024 });
    assert.equal(running.turns[0].status, 'inProgress');
    assert.equal(running.turns[0].items.at(-1).text, 'still running');
    assert.equal(running.toolPurpose, 'Checking persistent state');
    assert.equal(running.activityKind, 'planning');
    assert.deepEqual(running.turnProgress.plan, { current: 2, total: 2 });

    await appendFile(filePath, row({
      type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Verifying the final result**' },
    }));
    const refreshed = await readRolloutTail({ filePath, threadId: 'thread-large', maxBytes: 64 * 1024 });
    assert.equal(refreshed.toolPurpose, 'Verifying the final result');
    assert.equal(refreshed.activityKind, 'planning');

    await appendFile(filePath, row({
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-large' },
    }));
    const completed = await readRolloutTail({ filePath, threadId: 'thread-large', maxBytes: 64 * 1024 });
    assert.equal(completed.turns[0].status, 'completed');
    assert.equal(completed.activityId, 'turn-large');
    assert.equal(completed.toolPurpose, '');
    assert.equal(completed.activityKind, '');
    assert.deepEqual(completed.turnProgress.plan, { current: 2, total: 2 });
  } finally {
    rolloutInternals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('large active rollout restores purpose and plan from before the visible tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-sticky-purpose-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-sticky' } }),
      row({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', input: `const result = await tools.update_plan({plan:[
          {step:"inspect",status:"completed"},{step:"verify",status:"in_progress"}
        ]});`,
      } }),
      row({ type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Checking persistent state**' } }),
      row({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', output: 'x'.repeat(96 * 1024),
      } }),
      row({ type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'commentary', content: [
          { type: 'output_text', text: 'still running' },
        ],
      } }),
    ].join(''));

    const result = await readRolloutTail({
      filePath, threadId: 'thread-sticky', maxBytes: 64 * 1024,
    });
    assert.equal(result.toolPurpose, 'Checking persistent state');
    assert.deepEqual(result.turnProgress.plan, { current: 2, total: 2 });
  } finally {
    rolloutInternals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('rollout model settings use the latest persisted thread configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-model-settings-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({ type: 'turn_context', payload: { model: 'gpt-old', effort: 'medium' } }),
      row({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'xhigh', service_tier: 'fast',
      } } }),
      row({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'xhigh' } }),
    ].join(''));
    assert.deepEqual(await readRolloutModelSettings(filePath), {
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', serviceTier: 'fast',
    });
  } finally {
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
    status: 'completed', id: 'turn-1', startedAt: null,
  });
});

test('rollout activity exposes changing categories for actual tool events', () => {
  assert.equal(rolloutInternals.activityKind({
    type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'private command' },
  }), 'command');
  assert.equal(rolloutInternals.activityKind({
    type: 'event_msg', payload: { type: 'patch_apply_end', changes: ['private path'] },
  }), 'editing');
  assert.equal(rolloutInternals.activityKind({
    type: 'event_msg', payload: { type: 'web_search_end', query: 'private query' },
  }), 'searching');
  assert.equal(rolloutInternals.activityKind({
    type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 'private' } },
  }), 'connectedTool');
  assert.equal(rolloutInternals.activityKind({
    type: 'response_item', payload: { type: 'function_call', name: 'wait', arguments: '{}' },
  }), 'waiting');
});

test('rollout activity follows real response-item tool calls and command completion', () => {
  const started = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-tools' } };
  const invoked = { type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec',
    input: 'const r = await tools.exec_command({cmd:"kubectl get pods"});',
  } };
  const completed = { type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CommandExecution', parsed_cmd: [{ type: 'unknown', cmd: 'kubectl get pods' }], exit_code: 0,
  } } };
  const output = { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'private output' } };

  assert.equal(rolloutInternals.updateActivityDetail('', [started, invoked], 'inProgress'), 'exec_command · kubectl get');
  assert.equal(
    rolloutInternals.updateActivityDetail('', [started, invoked, completed, output], 'inProgress'),
    '✓ command · kubectl get · exit 0',
  );
  assert.equal(rolloutInternals.updateToolPurpose('', [started, invoked, completed, output], 'inProgress'), '');
});

test('rollout activity uses only public reasoning summaries from current Codex rows', () => {
  const responseSummary = { type: 'reasoning', summary: [
    { type: 'summary_text', text: '**Checking deployment health**' },
  ], encrypted_content: 'must-not-be-read' };
  const completedSummary = { type: 'item_completed', item: {
    type: 'Reasoning', summary_text: ['**Preparing verification**'], raw_content: ['private'],
  } };

  assert.equal(rolloutInternals.reasoningSummary(responseSummary), 'Checking deployment health');
  assert.equal(rolloutInternals.reasoningSummary(completedSummary), 'Preparing verification');
  assert.equal(
    rolloutInternals.updateToolPurpose('', [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: responseSummary },
    ], 'inProgress'),
    'Checking deployment health',
  );
});

test('turn progress safely summarizes structured plans and diffs', () => {
  assert.deepEqual(extractPlanProgressFromToolInput(`
    const result = await tools.update_plan({ plan: [
      { step: "inspect", status: "completed" },
      { step: "implement", status: "in_progress" },
      { step: "verify", status: "pending" }
    ] });
  `), { current: 2, total: 3 });
  assert.deepEqual(summarizeUnifiedDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+next',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+created',
  ].join('\n')), { changed: 2, additions: 3, deletions: 1 });
  assert.deepEqual(normalizeTurnProgress({
    plan: { current: 2, total: 3 }, files: { changed: 2, additions: 3, deletions: 1 },
  }), {
    plan: { current: 2, total: 3 }, files: { changed: 2, additions: 3, deletions: 1 },
  });
  assert.deepEqual(normalizeTurnProgress({ plan: { current: 0, total: 3 } }), {});
});

test('turn progress extracts only aggregate patch statistics', () => {
  const result = summarizePatchChanges({
    'src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' },
    'src/b.ts': { type: 'add', content: 'created\n' },
  });
  assert.deepEqual(result, {
    changed: 2, additions: 2, deletions: 1, paths: ['src/a.ts', 'src/b.ts'],
  });
});

test('rollout tail exposes active plan and aggregate file progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-progress-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-progress' } }),
      row({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', input: `const result = await tools.update_plan({plan:[
          {step:"inspect",status:"completed"},{step:"implement",status:"in_progress"}
        ]});`,
      } }),
      row({ type: 'response_item', payload: {
        type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "verify" });',
      } }),
      row({ type: 'event_msg', payload: {
        type: 'patch_apply_end', success: true, changes: {
          'src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' },
        },
      } }),
    ].join(''));
    const result = await readRolloutTail({ filePath, threadId: 'thread-progress' });
    assert.deepEqual(result.turnProgress, {
      plan: { current: 2, total: 2 },
      files: { changed: 1, additions: 1, deletions: 1 },
    });
    assert.equal(result.toolPurpose, '');
    assert.equal(result.activityDetail, '✓ apply_patch · a.ts');
  } finally {
    rolloutInternals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed rollout pages restore modern file changes from before the visible window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-persisted-progress-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-files' } }),
      row({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'FileChange', changes: {
          'src/first.ts': { type: 'update', unified_diff: '@@ -1 +1,2 @@\n-old\n+new\n+line' },
          'src/second.ts': { type: 'add', content: 'created\n' },
        },
      } } }),
      row({ type: 'response_item', payload: {
        type: 'custom_tool_call_output', output: 'x'.repeat(600 * 1024),
      } }),
      row({ type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', content: [
          { type: 'output_text', text: 'finished' },
        ],
      } }),
      row({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-files' } }),
    ].join(''));

    const result = await readRolloutTail({
      filePath, threadId: 'thread-files', paged: true,
    });
    assert.equal(result.turns[0].items.at(-1).text, 'finished');
    assert.deepEqual(result.turnProgress.files, {
      changed: 2, additions: 3, deletions: 1,
    });
    assert.deepEqual(result.turns[0].items.at(-1).fileChanges, {
      changed: 2, additions: 3, deletions: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('starting a new turn does not remove file changes from the previous live reply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-next-turn-file-progress-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  try {
    await writeFile(filePath, [
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-first' } }),
      row({ type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'FileChange', changes: {
          'src/kept.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' },
        },
      } } }),
      row({ type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', content: [
          { type: 'output_text', text: 'first finished' },
        ],
      } }),
      row({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-first' } }),
    ].join(''));
    const initial = await readRolloutTail({ filePath, threadId: 'thread-next-turn' });
    assert.deepEqual(initial.turns[0].items.find((item) => item.text === 'first finished')?.fileChanges, {
      changed: 1, additions: 1, deletions: 1,
    });

    await appendFile(filePath, [
      row({ type: 'event_msg', payload: { type: 'user_message', message: 'continue' } }),
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-second' } }),
    ].join(''));
    const nextTurn = await readRolloutTail({ filePath, threadId: 'thread-next-turn' });
    assert.deepEqual(nextTurn.turns[0].items.find((item) => item.text === 'first finished')?.fileChanges, {
      changed: 1, additions: 1, deletions: 1,
    });
  } finally {
    rolloutInternals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('older rollout pages retain file changes on their own final replies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-previous-file-progress-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  const turnRows = (id, file, message) => [
    row({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }),
    row({ type: 'event_msg', payload: { type: 'item_completed', item: {
      type: 'FileChange', changes: {
        [file]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' },
      },
    } } }),
    row({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', output: 'x'.repeat(600 * 1024),
    } }),
    row({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', content: [
        { type: 'output_text', text: message },
      ],
    } }),
    row({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }),
  ];
  try {
    await writeFile(filePath, [
      ...turnRows('turn-older', 'src/older.ts', 'older finished'),
      ...turnRows('turn-newer', 'src/newer.ts', 'newer finished'),
    ].join(''));

    const latest = await readRolloutTail({ filePath, threadId: 'thread-pages', paged: true });
    let cursor = latest.nextCursor;
    let olderFinal;
    for (let pageNumber = 0; pageNumber < 4 && cursor && !olderFinal; pageNumber += 1) {
      const page = await readRolloutTail({
        filePath, threadId: 'thread-pages', paged: true, cursor,
      });
      olderFinal = page.turns[0]?.items.find((item) => item.text === 'older finished');
      cursor = page.nextCursor;
    }
    assert.deepEqual(olderFinal?.fileChanges, {
      changed: 1, additions: 1, deletions: 1,
    });
    const timeline = historyItems([{
      id: 'older-turn', status: 'completed', items: olderFinal ? [olderFinal] : [],
    }]);
    assert.deepEqual(timeline[0]?.fileChanges, {
      changed: 1, additions: 1, deletions: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('large rollout pages walk backward to the oldest visible messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-rollout-pages-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value) => `${JSON.stringify(value)}\n`;
  const expected = Array.from({ length: 14 }, (_, index) => `message-${index}`);
  try {
    await writeFile(filePath, expected.map((message) => [
      row({ type: 'event_msg', payload: { type: 'user_message', message } }),
      row({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(70 * 1024) } }),
    ].join('')).join(''));

    let cursor: string | null = null;
    const pages: Awaited<ReturnType<typeof readRolloutTail>>[] = [];
    do {
      const page = await readRolloutTail({
        filePath, threadId: 'thread-pages', paged: true, cursor,
      });
      pages.unshift(page);
      assert.notEqual(page.nextCursor, cursor);
      cursor = page.nextCursor;
    } while (cursor && pages.length < 10);

    assert.equal(cursor, null);
    assert.equal(new Set(pages.flatMap((page) => page.turns.map((turn) => turn.id))).size, pages.length);
    assert.deepEqual(
      pages.flatMap((page) => page.turns.flatMap((turn) => turn.items.map((item) => item.text))),
      expected,
    );
    await assert.rejects(() => readRolloutTail({
      filePath, threadId: 'thread-pages', paged: true, cursor: 'rollout:v1:not-a-number',
    }), /invalid_rollout_cursor/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test('delegated mobile messages survive rollout refresh without duplicates', () => {
  const envelope = '<codex_delegation><source_thread_id>source-thread</source_thread_id><input>请修复。</input></codex_delegation>';
  const items = rolloutInternals.mapRolloutRows([
    {
      timestamp: '2026-08-30T10:01:12.726Z',
      type: 'response_item',
      payload: { type: 'function_call_output', name: 'send_message_to_thread', output: envelope },
    },
    {
      timestamp: '2026-08-30T10:01:12.726Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'FunctionCallOutput', name: 'send_message_to_thread', output: envelope },
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', name: 'exec_command', output: envelope },
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'userMessage');
  assert.equal(items[0].text, '请修复。');
  assert.deepEqual(items[0].contexts, [{ kind: 'delegation', sourceThreadId: 'source-thread' }]);
  assert.equal(items[0].completedAt, Date.parse('2026-08-30T10:01:12.726Z'));
});

test('approval results stay inside workspace and keep network disabled', () => {
  const approvalRoot = resolve('approval-root');
  const approvalOutput = join(approvalRoot, 'output');
  const outsideRoot = resolve('approval-private');
  const result = internals.approvalResult(
    'item/permissions/requestApproval',
    true,
    {
      permissions: {
        fileSystem: {
          read: [approvalRoot, outsideRoot],
          write: [approvalOutput],
          entries: [
            { path: { type: 'path', path: approvalRoot }, access: 'read' },
            { path: { type: 'path', path: outsideRoot }, access: 'write' },
          ],
        },
        network: { enabled: true },
      },
    },
    [approvalRoot],
    false,
  );
  assert.deepEqual(result.permissions.fileSystem.read, [approvalRoot]);
  assert.deepEqual(result.permissions.fileSystem.write, [approvalOutput]);
  assert.equal(result.permissions.fileSystem.entries.length, 1);
  assert.equal(result.permissions.network, undefined);
  assert.equal(result.scope, 'turn');
  assert.deepEqual(
    internals.approvalResult('item/commandExecution/requestApproval', false),
    { decision: 'decline' },
  );
});

test('app-server approval requests survive reconnect and use protocol decisions', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  const writes = [];
  codex.writeRpc = (message) => writes.push(message);
  codex.activeTurn = {
    clientId: 'old-client', requestId: 'old-request', threadId: 'thread-1',
    cwd: process.cwd(), state: 'running',
  };
  const eventPromise = once(codex, 'turn-event');
  codex.handleServerRequest({
    jsonrpc: '2.0', id: 41, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', command: 'npm test' },
  });
  const [event] = await eventPromise;
  assert.equal(event.event, 'approval.requested');
  assert.equal(event.payload.threadId, 'thread-1');
  assert.match(event.payload.summary, /npm test/);

  const pending = codex.listApprovals('thread-1', 'new-client');
  assert.equal(pending.approvals.length, 1);
  assert.equal(codex.activeTurn.clientId, 'new-client');
  await codex.respondApproval('41', true, 'thread-1');
  assert.deepEqual(writes.at(-1).result, { decision: 'accept' });
  assert.equal(codex.listApprovals('thread-1').approvals.length, 0);

  codex.handleServerRequest({
    jsonrpc: '2.0', id: 42, method: 'item/tool/call',
    params: { threadId: 'thread-1', tool: 'unsupported' },
  });
  assert.equal(writes.at(-1).error.code, -32601);
  assert.equal(codex.listApprovals('thread-1').approvals.length, 0);
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

test('live tool activity forwards a bounded useful summary without raw arguments or output', () => {
  assert.deepEqual(internals.summarizeItem({
    id: 'private-id', type: 'commandExecution', name: 'exec', command: 'private command',
    path: 'C:\\private', aggregatedOutput: 'private output', status: 'completed',
  }), { type: 'commandExecution', status: 'completed', detail: 'command' });
  const summary = summarizeToolActivity({
    type: 'custom_tool_call', name: 'exec', input: String.raw`const r = await tools.exec_command({ cmd: "git status; npm run check; echo secret-token" });`,
  });
  assert.equal(summary, 'exec_command · git status + npm run check');
  assert.equal(summary.includes('secret-token'), false);
  assert.equal(summarizeToolActivity({
    type: 'custom_tool_call', name: 'exec',
    input: 'const patch = `*** Begin Patch\n*** Update File: D:\\project\\src\\app.ts\n*** End Patch`; await tools.apply_patch(patch);',
  }), 'apply_patch · app.ts');
});

test('app-server forwards only aggregate plan and diff progress', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.activeTurn = {
    clientId: 'client', requestId: 'request', threadId: 'thread-1',
    turnId: 'turn-1', cwd: process.cwd(), state: 'running',
  };
  const planEvent = once(codex, 'turn-event');
  codex.handleNotification('turn/plan/updated', {
    threadId: 'thread-1', turnId: 'turn-1', plan: [
      { step: 'private first step', status: 'completed' },
      { step: 'private current step', status: 'inProgress' },
    ],
  });
  const [plan] = await planEvent;
  assert.equal(plan.event, 'turn.progress');
  assert.deepEqual(plan.payload, { plan: { current: 2, total: 2 } });

  const diffEvent = once(codex, 'turn-event');
  codex.handleNotification('turn/diff/updated', {
    threadId: 'thread-1', turnId: 'turn-1',
    diff: 'diff --git a/private.ts b/private.ts\n--- a/private.ts\n+++ b/private.ts\n@@ -1 +1 @@\n-old\n+new',
  });
  const [diff] = await diffEvent;
  assert.equal(diff.event, 'turn.progress');
  assert.deepEqual(diff.payload, { files: { changed: 1, additions: 1, deletions: 1 } });
  assert.equal(JSON.stringify(diff.payload).includes('private.ts'), false);
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

test('large conversation history keeps rollout cursors on the bounded file reader', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  codex.sessionMetadata.set('thread-large', { path: 'large-rollout.jsonl' });
  codex.isLargeSession = async () => true;
  const calls: unknown[] = [];
  codex.readSessionTail = async (threadId, filePath, options) => {
    calls.push({ threadId, filePath, options });
    return { threadId, turns: [], nextCursor: options.cursor || 'rollout:v1:512' };
  };
  codex.rpcRaw = async () => { throw new Error('app server should not read a large rollout'); };

  const first = await codex.listSessionTurns('thread-large', { mode: 'conversation' });
  const older = await codex.listSessionTurns('thread-large', {
    mode: 'conversation', cursor: first.nextCursor,
  });

  assert.equal(older.nextCursor, 'rollout:v1:512');
  assert.deepEqual(calls, [
    {
      threadId: 'thread-large', filePath: 'large-rollout.jsonl',
      options: { paged: true },
    },
    {
      threadId: 'thread-large', filePath: 'large-rollout.jsonl',
      options: { paged: true, cursor: 'rollout:v1:512' },
    },
  ]);
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

test('session model settings are catalog-backed and update subsequent turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-model-config-'));
  const filePath = join(directory, 'rollout.jsonl');
  try {
    await writeFile(filePath, `${JSON.stringify({
      type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'high', service_tier: 'default',
      } },
    })}\n`);
    const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
    codex.ensureStarted = async () => {};
    codex.sessionMetadata.set('thread-1', {
      path: filePath, cwd: process.cwd(), canAcceptDirectInput: true,
    });
    const calls = [];
    let settingsUpdates = 0;
    codex.rpcRaw = async (method, params) => {
      calls.push({ method, params });
      if (method === 'model/list') return { data: [{
        id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier',
        supportedReasoningEfforts: [
          { reasoningEffort: 'high', description: 'High' },
          { reasoningEffort: 'xhigh', description: 'Extra high' },
        ],
        defaultReasoningEffort: 'high',
        serviceTiers: [
          { id: 'default', name: 'Standard', description: 'Standard' },
          { id: 'fast', name: 'Fast', description: 'Low latency' },
        ],
        defaultServiceTier: 'default', isDefault: true,
      }] };
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/settings/update') {
        settingsUpdates += 1;
        if (settingsUpdates === 1) throw new Error('thread not found: thread-1');
        return {};
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      throw new Error(`unexpected method ${method}`);
    };

    const current = await codex.readModelConfig('thread-1');
    assert.equal(current.model, 'gpt-5.6-sol');
    assert.equal(current.reasoningEffort, 'high');
    assert.equal(current.fastMode, false);
    const updated = await codex.updateModelConfig('thread-1', {
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', fastMode: true,
    });
    assert.equal(updated.fastMode, true);
    assert.deepEqual(calls.filter((call) => call.method === 'thread/settings/update').at(-1), {
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-1', model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'fast',
      },
    });
    assert.deepEqual(calls.slice(-3).map((call) => call.method), [
      'thread/resume', 'thread/settings/update', 'thread/unsubscribe',
    ]);
    await assert.rejects(() => codex.updateModelConfig('thread-1', {
      model: 'gpt-5.6-sol', reasoningEffort: 'ultra', fastMode: false,
    }), /reasoning_effort_not_available/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('active Desktop writers return a conflict immediately without forking', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  const calls = [];
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'original', cwd: process.cwd() } };
    throw new Error('thread original already has an active writer');
  };
  await assert.rejects(() => codex.startTurn({
    text: 'continue', threadId: 'original', cwd: join(process.cwd(), 'wrong-directory'),
    clientId: 'client', requestId: 'request',
  }), /thread_active_writer_conflict/);
  assert.equal(calls[0].method, 'thread/read');
  assert.equal(calls[1].method, 'thread/resume');
  assert.equal(calls[1].params.cwd, process.cwd());
  assert.equal('approvalPolicy' in calls[1].params, false);
  assert.equal('sandbox' in calls[1].params, false);
  assert.equal('config' in calls[1].params, false);
  assert.equal(calls.some((call) => call.method === 'thread/fork'), false);
});

test('legacy bridge restrictions are detected only after a prior full-access context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-permission-'));
  const filePath = join(directory, 'rollout.jsonl');
  const fullAccess = {
    type: 'turn_context',
    payload: {
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      permission_profile: { type: 'disabled' },
    },
  };
  const legacyOverride = {
    type: 'turn_context',
    payload: {
      approval_policy: 'untrusted',
      sandbox_policy: {
        type: 'workspace-write', network_access: false,
        exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
      },
      permission_profile: {
        type: 'managed', file_system: { type: 'restricted' }, network: 'restricted',
      },
    },
  };
  try {
    await writeFile(filePath, `${JSON.stringify(fullAccess)}\n${JSON.stringify(legacyOverride)}\n`);
    assert.equal(await needsDesktopPermissionRecovery(filePath), true);
    await writeFile(filePath, `${JSON.stringify(legacyOverride)}\n`);
    assert.equal(await needsDesktopPermissionRecovery(filePath), false);
    await writeFile(filePath, `${JSON.stringify(legacyOverride)}\n${JSON.stringify(fullAccess)}\n`);
    assert.equal(await needsDesktopPermissionRecovery(filePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new Web sessions retain the restricted approval and sandbox defaults', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  const calls = [];
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return { thread: { id: 'new-thread' } };
  };
  await codex.startTurn({ text: 'hello', cwd: process.cwd() });
  assert.equal(calls[0].method, 'thread/start');
  assert.equal(calls[0].params.approvalPolicy, 'untrusted');
  assert.equal(calls[0].params.sandbox, 'workspace-write');
  assert.equal(calls[0].params.config.sandbox_mode, 'workspace-write');
  assert.equal(calls[1].method, 'turn/start');
  assert.equal(calls[1].params.approvalPolicy, 'untrusted');
});

test('active app-server turns accept steering only for the matching turn', async () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  const calls = [];
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', cwd: process.cwd() } };
    if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'turn/steer') return { turnId: 'turn-1' };
    return {};
  };
  await codex.startTurn({ text: 'start', threadId: 'thread-1', clientId: 'client-1' });
  const result = await codex.steerTurn({
    text: 'focus tests', threadId: 'thread-1', clientId: 'client-2', requestId: 'request-2',
  });
  assert.deepEqual(result, { threadId: 'thread-1', turnId: 'turn-1', steered: true });
  assert.deepEqual(calls.at(-1), {
    method: 'turn/steer',
    params: {
      threadId: 'thread-1', input: [{ type: 'text', text: 'focus tests' }], expectedTurnId: 'turn-1',
    },
  });
  await assert.rejects(
    () => codex.steerTurn({ text: 'wrong', threadId: 'thread-2' }),
    /turn_not_active/,
  );
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
