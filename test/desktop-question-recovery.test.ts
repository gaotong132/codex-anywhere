import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { readRolloutQuestionReplies } from '../src/connector/rollout-tail.js';
import { asyncQuestionsFromItem, buildQuestionReply } from '../src/shared/async-questions.js';
import { historyItems } from '../web/src/history-utils.js';
import { ConversationTimeline } from '../web/src/conversation-timeline.js';

const source = { type: 'agentMessage', id: 'call-choice', delivery: 'async', text: '',
  questions: [{ title: 'Which API convention?', options: ['Document convention', 'Repository convention'] }] };
const question = asyncQuestionsFromItem(source)![0];
const reply = { questionItemId: question.id, question: question.title, answer: 'Repository convention' };
const row = (payload: unknown, type = 'response_item') => JSON.stringify({ type, payload, timestamp: '2026-10-12T12:55:46.161Z' }) + '\n';
const answerRow = () => row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: buildQuestionReply([reply]) }] });

test('requested answers survive beyond 64 MiB, large tool rows, append and replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-large-question-index-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    const handle = await open(path, 'w');
    try {
      await handle.write(answerRow());
      await handle.write('{"type":"response_item","payload":{"type":"function_call_output","output":"');
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      for (let i = 0; i < 66; i++) await handle.write(chunk);
      await handle.write('"}}\n');
    } finally { await handle.close(); }
    const wanted = new Set([question.id]);
    assert.deepEqual(await readRolloutQuestionReplies(path, wanted), [reply]);
    assert.deepEqual(await readRolloutQuestionReplies(path, new Set(['unrelated'])), []);
    const updated = { ...reply, answer: 'Updated choice' };
    const update = row({ type: 'user_message', message: buildQuestionReply([updated]) }, 'event_msg');
    await appendFile(path, update.slice(0, -1));
    assert.deepEqual(await readRolloutQuestionReplies(path, wanted), [reply]);
    await appendFile(path, '\n');
    assert.deepEqual(await readRolloutQuestionReplies(path, wanted), [updated]);
    await writeFile(path, row({ type: 'user_message', message: 'New history' }, 'event_msg'));
    assert.deepEqual(await readRolloutQuestionReplies(path, wanted), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Desktop answers omitted from summaries and evicted from the live tail still resolve visible questions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-question-recovery-'));
  const path = join(directory, 'rollout.jsonl');
  const codex = new CodexAppServer({ runtimeCwd: directory });
  codex.ensureStarted = async () => {};
  codex.sessionMetadata.set('thread', { path, cwd: directory, canAcceptDirectInput: false });
  codex.rpcRaw = async (method) => {
    assert.equal(method, 'thread/turns/list');
    return { data: [{ id: 'turn', items: [{ type: 'userMessage', text: 'implement' }, source] }] } as any;
  };
  try {
    await writeFile(path, row({ type: 'task_started', turn_id: 'turn' }, 'event_msg')
      + answerRow() + row({ type: 'function_call_output', output: 'x'.repeat(5 * 1024 * 1024) })
      + row({ type: 'agent_message', message: 'Work continues', phase: 'commentary' }, 'event_msg'));
    const summary = await codex.listSessionTurns('thread');
    assert.equal(summary.turns[0].items.some((item: any) => item.questionReplies), false);
    assert.deepEqual(summary.questionReplies, [reply]);
    const live = await codex.listSessionTurns('thread', { mode: 'live', questionIds: [question.id] });
    assert.equal(live.turns.flatMap((turn) => turn.items).some((item: any) => item.questionReplies || item.questions), false);
    assert.deepEqual(live.questionReplies, [reply]);
    assert.ok(JSON.stringify(live).length < 10_000, 'tool output is not transferred to recover one answer');
    assert.deepEqual((await codex.listSessionTurns('thread', { mode: 'live', questionIds: ['another-question'] })).questionReplies, []);

    const props = {
      messageListRef: { current: null }, messageContentRef: { current: null }, threadId: 'thread', environmentId: 'personal-pc',
      creatingNewSession: false, initialHistoryLoaded: true, nextCursor: null, historyLoading: false,
      olderHistoryError: false, olderHistoryAutoLoadEnabled: false, timeline: historyItems(summary.turns).filter((item) => item.questions),
      knownAttachments: {}, attachmentUrls: {}, executionActive: false, progressAnimationReady: true,
      liveProgressItemId: null, onScroll() {}, onLoadOlder() {}, onDownloadFile() {},
      onReadTextFile: async () => { throw Error('unused'); }, onReadTurnDiff: async () => { throw Error('unused'); },
      onReadVisualization: async () => '', onReadPreviewImage: async () => '',
    };
    const pending = renderToStaticMarkup(createElement(ConversationTimeline, props));
    assert.match(pending, /<textarea/);
    const answered = renderToStaticMarkup(createElement(ConversationTimeline, { ...props,
      resolvedQuestionAnswers: Object.fromEntries(summary.questionReplies.map((answer) => [answer.questionItemId, answer.answer])),
    }));
    assert.match(answered, /async-question-card answered/);
    assert.match(answered, /Repository convention/);
    assert.doesNotMatch(answered, /<textarea|type="submit"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the reply index refreshes for new Desktop answers, partial writes and file replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-question-index-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    await writeFile(path, row({ type: 'task_started', turn_id: 'turn' }, 'event_msg'));
    assert.deepEqual(await readRolloutQuestionReplies(path), []);
    const answer = answerRow();
    await appendFile(path, answer.slice(0, -1));
    assert.deepEqual(await readRolloutQuestionReplies(path), []);
    await appendFile(path, '\n');
    assert.deepEqual(await readRolloutQuestionReplies(path), [reply]);
    await appendFile(path, answer); // Event and response representations can duplicate an answer.
    assert.deepEqual(await readRolloutQuestionReplies(path), [reply]);
    await writeFile(path, row({ type: 'task_started', turn_id: 'replacement' }, 'event_msg'));
    assert.deepEqual(await readRolloutQuestionReplies(path), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
