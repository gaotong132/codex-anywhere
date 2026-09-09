import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  asyncQuestionsFromCall, asyncQuestionsFromItem, buildQuestionReply, normalizeAsyncQuestions,
  parseQuestionReplies, questionReplyText,
} from '../src/shared/async-questions.js';
import { parseUserMessage } from '../src/shared/message-content.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { internals as rollout } from '../src/connector/rollout-tail.js';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { historyFingerprint, historyItems, mergeHistorySnapshot } from '../web/src/history-utils.js';
import { AsyncQuestionCard } from '../web/src/async-question-card.js';
import { MessageBubble } from '../web/src/message-bubble.js';
import { parseHTML } from 'linkedom';

const source = { type: 'agentMessage', id: 'call_example', delivery: 'async', text: '', questions: [
  { title: 'Which environment?', options: ['Test (Recommended)', 'Production'] },
  { title: 'Describe the change', options: null },
] };
const questions = asyncQuestionsFromItem(source)!;
const replies = questions.map((q, index) => ({ questionItemId: q.id, question: q.title, answer: index ? 'Only update the test environment.' : 'Test (Recommended)' }));

test('rollout function calls and native async messages preserve the Desktop question IDs and options', () => {
  const call = { type: 'function_call', name: 'request_user_input_async', call_id: source.id, arguments: JSON.stringify({ questions: source.questions }) };
  assert.deepEqual(asyncQuestionsFromCall(call), questions);
  assert.equal(questions[0].id, '["request_user_input_async","call_example",0]');
  const items = rollout.mapRolloutRows([
    { type: 'response_item', payload: call },
    { type: 'response_item', payload: { ...call, call_id: 'second_call' } },
  ]);
  assert.equal(items.length, 2, 'distinct empty-text question calls must not collapse');
  const native = mapTurns([{ id: 'turn-a', items: [source] }]);
  assert.deepEqual(items[0].questions, native[0].items[0].questions);
  assert.equal(historyItems(native)[0].questions?.length, 2, 'empty-text questions remain visible');
  assert.equal(historyItems(mapTurns([{ id: 'turn-a', items: [{ ...source, text: 'A host summary' }] }]))[0].text,
    historyItems(native)[0].text, 'native summaries must not change question identity during live hydration');
  assert.equal(historyItems([{ id: 'turn-a', items }]).length, 2);
  assert.deepEqual(asyncQuestionsFromItem({ ...source, questions: null, text: 'Legacy question' }), [
    { id: source.id, title: 'Legacy question', options: [] },
  ]);
});

test('answers retain their correlation through Desktop envelopes, connector mapping, Web history and hydration', () => {
  const envelope = buildQuestionReply(replies);
  assert.deepEqual(parseQuestionReplies(envelope), replies);
  const parsed = parseUserMessage(envelope);
  assert.deepEqual(parsed.questionReplies, replies);
  assert.equal(parsed.text, questionReplyText(replies));
  assert.ok(!parsed.text.includes('send_user_message_question_reply'));
  const turns = mapTurns([{ id: 'turn-a', items: [source, { type: 'userMessage', content: [{ text: envelope }] }] }]);
  const latest = historyItems(turns);
  assert.deepEqual(latest[1].questionReplies, replies);
  const rowItems = rollout.mapRolloutRows([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope }] } }]);
  assert.deepEqual(historyItems([{ id: 'turn-a', items: rowItems }])[0].questionReplies, replies);
  const merged = mergeHistorySnapshot([{ id: 'optimistic', kind: 'user', text: parsed.text, questionReplies: replies, transient: true }], latest, new Set(['turn-a']));
  assert.equal(merged.filter((item) => item.kind === 'user').length, 1);
  assert.deepEqual(merged.find((item) => item.kind === 'user')?.questionReplies, replies);
  assert.notEqual(historyFingerprint(turns), historyFingerprint(mapTurns([{ id: 'turn-a', items: [{ ...source, questions: [{ title: 'A changed question', options: null }] }] }])));
});

test('question normalization rejects malformed, excessive and non-async data without hiding ordinary text', () => {
  assert.equal(asyncQuestionsFromCall({ type: 'function_call', name: 'other_tool', arguments: JSON.stringify({ questions: source.questions }) }), undefined);
  assert.equal(asyncQuestionsFromItem({ ...source, delivery: undefined }), undefined);
  assert.equal(asyncQuestionsFromItem({ ...source, questions: [{ title: 'Invalid options', options: [42] }] }), undefined);
  assert.equal(normalizeAsyncQuestions([questions[0], questions[0]]), undefined);
  assert.equal(normalizeAsyncQuestions(Array.from({ length: 13 }, (_, i) => ({ ...questions[0], id: String(i) }))), undefined);
  assert.equal(parseQuestionReplies('Example:\n' + buildQuestionReply(replies)), undefined);
  assert.equal(parseQuestionReplies('```\n' + buildQuestionReply(replies) + '\n```'), undefined);
  assert.throws(() => buildQuestionReply([{ ...replies[0], answer: '' }]), /question_reply_invalid/);
  const malformed = '<send_user_message_question_reply>not JSON</send_user_message_question_reply>';
  assert.equal(parseUserMessage(malformed).text, malformed);
});

test('an authorized browser keeps async answers as exact Desktop envelopes', async () => {
  const broker = new BrowserSessionBroker('personal-pc', () => true);
  const client = { clientId: 'extension', clientDeviceId: 'browser-a' };
  broker.bind(client, 'task-a', { browserDeviceId: 'browser-a', tabId: 1, documentId: 'doc-a', origin: 'https://example.com' });
  const envelope = buildQuestionReply(replies);
  assert.equal(await broker.withContext('task-a', envelope, async (text) => text), envelope);
  assert.match(String(await broker.withContext('task-a', 'Continue reading the page', async (text) => text)), /Anywhere browser:/);
});

test('live async question events stay bound to their original task and turn', () => {
  const codex = new CodexAppServer({ cwd: process.cwd(), allowedRoots: [process.cwd()] });
  codex.activeTurn = { threadId: 'task-a', turnId: 'turn-a', clientId: 'browser-a', requestId: 'request-a' };
  const events: any[] = [];
  codex.on('turn-event', (event) => events.push(event));
  codex.handleNotification('item/completed', { threadId: 'task-b', turnId: 'turn-a', item: source });
  codex.handleNotification('item/completed', { threadId: 'task-a', turnId: 'old-turn', item: source });
  assert.equal(events.length, 0);
  codex.handleNotification('item/completed', { threadId: 'task-a', turnId: 'turn-a', item: source });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'turn.questions');
  assert.deepEqual(events[0].payload.questions, questions);
  assert.equal(events[0].payload.threadId, 'task-a');
  assert.equal(events[0].payload.turnId, 'turn-a');
});

test('the question card renders choices and free text, and shows persisted answers as answered', () => {
  const html = renderToStaticMarkup(createElement(AsyncQuestionCard, { questions, answers: new Map(), disabled: false }));
  assert.match(html, /type="radio"/);
  assert.equal((html.match(/<textarea/g) || []).length, 2);
  assert.doesNotMatch(html, /checked=""/);
  const answered = renderToStaticMarkup(createElement(AsyncQuestionCard, { questions, answers: new Map(replies.map((r) => [r.questionItemId, r.answer])), disabled: false }));
  assert.match(answered, /已回答/);
  assert.doesNotMatch(answered, /<textarea|type="submit"/);
  const { document } = parseHTML(answered);
  assert.ok(document.querySelector('details.answered:not([open])'));
  assert.equal(document.querySelectorAll('.async-question-history section').length, replies.length);
});

test('reply bubbles pair each answer with a collapsed question and preserve ordinary message rendering', () => {
  const item = { id: 'reply', kind: 'user' as const, text: questionReplyText(replies), questionReplies: replies };
  const props = { item, onDownloadFile() {}, onReadVisualization: async () => '' };
  const { document } = parseHTML(renderToStaticMarkup(createElement(MessageBubble, props)));
  const pairs = [...document.querySelectorAll('.question-reply')];
  assert.equal(pairs.length, replies.length);
  pairs.forEach((pair, index) => {
    assert.ok(pair.querySelector('details:not([open]) > summary'));
    assert.equal(pair.querySelector('.question-reply-full')?.textContent, replies[index].question);
    assert.equal(pair.querySelector('.question-reply-answer')?.textContent, replies[index].answer);
  });
  const ordinary = renderToStaticMarkup(createElement(MessageBubble, { ...props, item: { ...item, questionReplies: undefined } }));
  assert.doesNotMatch(ordinary, /question-reply-context/);
  assert.ok(ordinary.includes(replies[0].question));
});
