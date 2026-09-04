import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseAssistantMessage, parseUserMessage, mergeMessageContexts } from '../src/shared/message-content.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { internals as rollout } from '../src/connector/rollout-tail.js';
import { historyItems } from '../web/src/history-utils.js';
import { MessageBubble } from '../web/src/message-bubble.js';

const report = '本轮已安全停止，现网未改动。\n\n当前版本：`20260904-100000`  \nCommit ID：`abc123`\n\n阻断原因：候选接口与 Smoke 契约不一致。\n\n需要更新检查并补充测试。构建、滚动均未启动，失败锁已保留。';
const heartbeat = '<heartbeat>\n  <automation_id>sample-check</automation_id>\n  <decision>NOTIFY</decision>\n  <message>检测到契约冲突，等待修复。</message>\n</heartbeat>';
const context = { kind: 'automation' as const, automationId: 'sample-check', decision: 'NOTIFY', currentTimeIso: undefined };
const escapeHtml = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeMarkdown = (value: string) => value.replaceAll('<', '\\<').replaceAll('_', '\\_');

test('a report with appended raw, HTML-escaped or Markdown-escaped heartbeat keeps only its body', () => {
  for (const encode of [(value: string) => value, escapeHtml, escapeMarkdown]) {
    for (const parse of [parseUserMessage, parseAssistantMessage]) {
      assert.deepEqual(parse(`${report}\n\n${encode(heartbeat)}`), { text: report, contexts: [context] });
    }
  }
});

test('forwarded reports preserve version, reason, and the follow-up request after metadata', () => {
  const input = `${report}\n\n${escapeHtml(heartbeat)}，分析下这个消息展示，进行优化`;
  const forwarded = `<codex_delegation><source_thread_id>source-task</source_thread_id><input>${input}</input></codex_delegation>`;
  const parsed = parseUserMessage(forwarded);
  assert.equal(parsed.text, `${report}\n\n，分析下这个消息展示，进行优化`);
  assert.deepEqual(parsed.contexts, [{ kind: 'delegation', sourceThreadId: 'source-task' }, context]);
  assert.doesNotMatch(parsed.text, /heartbeat|sample-check|NOTIFY|检测到契约冲突/);
});

test('leading metadata no longer discards prose after its closing tag', () => {
  assert.deepEqual(parseAssistantMessage(`${heartbeat}\n\n${report}`), { text: report, contexts: [context] });
  assert.equal(parseAssistantMessage(heartbeat).text, '检测到契约冲突，等待修复。');
});

test('quoted XML, code examples, incomplete blocks and unknown decisions stay unchanged', () => {
  const examples = [
    `下面是示例：\n\n\`\`\`xml\n${heartbeat}\n\`\`\``,
    `~~~xml\n${escapeHtml(heartbeat)}\n~~~`,
    heartbeat.split('\n').map((line) => `> ${line}`).join('\n'),
    `报告\n\n${heartbeat.split('\n').map((line) => `    ${line}`).join('\n')}`,
    `报告中提及 ${heartbeat} 的用法`,
    `报告\n${heartbeat.replace('</heartbeat>', '')}`,
    `报告\n${heartbeat.replace('NOTIFY', 'UNKNOWN')}`,
    `报告\n${heartbeat.replace('</heartbeat>', '<extra>不能丢失的正文</extra></heartbeat>')}`,
    `报告\n${heartbeat.replace('</heartbeat>', '不能丢失的正文</heartbeat>')}`,
    '解释 <heartbeat> 标签的含义',
  ];
  for (const example of examples) assert.equal(parseAssistantMessage(example).text, example.trim());
});

test('repeated heartbeat metadata is deduplicated without repeating its summary', () => {
  assert.deepEqual(parseAssistantMessage(`${report}\n\n${heartbeat}\n\n${heartbeat}`), {
    text: report, contexts: [context],
  });
  assert.deepEqual(mergeMessageContexts([context], [{ decision: 'NOTIFY', automationId: 'sample-check', kind: 'automation' }]), [context]);
});

test('rollout and app-server history project the same clean report and automation context', () => {
  const raw = `${report}\n\n${heartbeat}`;
  const rows = rollout.mapRolloutRows([{ type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: raw }],
  } }]);
  const turns = mapTurns([{ id: 'sample-turn', items: [{ type: 'agentMessage', phase: 'final_answer', text: raw }] }]);
  assert.equal(rows[0].text, report);
  assert.deepEqual(rows[0].contexts, [context]);
  assert.equal(turns[0].items[0].text, report);
  assert.deepEqual(turns[0].items[0].contexts, [context]);
  const timeline = historyItems(turns);
  assert.equal(timeline[0].text, report);
  assert.deepEqual(timeline[0].contexts, [context]);
});

test('browser history merges new heartbeat metadata with an older connector delegation context', () => {
  const delegation = { kind: 'delegation' as const, sourceThreadId: 'source-task' };
  const timeline = historyItems([{ id: 'sample-turn', items: [{
    type: 'userMessage', text: `${report}\n\n${heartbeat}`, contexts: [delegation],
  }] }]);
  assert.equal(timeline[0].text, report);
  assert.deepEqual(timeline[0].contexts, [delegation, context]);
});

test('forwarded automation notifications have a compact label, not a scheduled prompt or internal id', () => {
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    item: { id: 'sample-message', kind: 'user', text: report, contexts: [context] },
    onDownloadFile() {}, onReadVisualization: async () => '',
  }));
  assert.match(markup, /自动任务通知/);
  assert.match(markup, /<code>20260904-100000<\/code>/);
  assert.match(markup, /失败锁已保留/);
  assert.doesNotMatch(markup, /由已安排任务发送|sample-check|NOTIFY|heartbeat/);
});
