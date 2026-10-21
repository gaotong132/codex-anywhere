import assert from 'node:assert/strict';
import test from 'node:test';
import { historyItems, mergeHistorySnapshot, prependHistoryPage, type TimelineItem } from '../web/src/history-utils.js';

const base = 1_800_000_000_000;
function page(id: string, parts: [string, number][], turnId = 'turn') {
  return historyItems([{ id, items: parts.map(([text, time]) => ({
    type: 'agentMessage', phase: 'commentary', turnId, text, completedAt: base + time,
  })) }], 'rolloutPage');
}

test('overlapping progress pages coalesce once, preserve Markdown and retain the visible DOM identity', () => {
  const code = '检查：\n\n```ts\nconst x = 1;\n\nconsole.log(x);\n```';
  const current = page('latest', [['已完成', 30]]);
  const middle = page('middle', [[code, 20], ['已完成', 30]]);
  const older = page('older', [['开始', 10], [code, 20]]);
  const result = prependHistoryPage(older, prependHistoryPage(middle, current));
  assert.equal(result.length, 1);
  assert.equal(result[0].text, `开始\n\n${code}\n\n已完成`);
  assert.equal(result[0].id, current[0].id);
  assert.equal(current[0].text, '已完成', 'existing state is not mutated');
  assert.equal(result[0].completedAt, base + 30);
  assert.equal(prependHistoryPage(older, result)[0], result[0], 'replayed page reuses the same object');
  const next = page('poll', [[code, 20], ['已完成', 30], ['验证通过', 40]]);
  const polled = mergeHistorySnapshot(result, next, new Set(['turn']), { partial: true });
  assert.equal(polled.length, 1);
  assert.equal(polled[0].text, `${result[0].text}\n\n验证通过`);
  assert.equal(polled[0].progressParts?.length, 4);
  assert.equal(prependHistoryPage(older, polled)[0], polled[0]);
});

test('older pages overlapping a longer live tail stay chronological across turns', () => {
  const answer: TimelineItem = { id: 'answer', kind: 'assistant', text: '第一轮回复', historyTurnId: 'first', completedAt: base + 20 };
  const question: TimelineItem = { id: 'question', kind: 'user', text: '第二轮问题', historyTurnId: 'second', completedAt: base + 30 };
  const current = [...page('tail-first', [['第一轮过程', 10]], 'first'), answer, question,
    ...page('tail-second', [['第二轮开始', 40], ['第二轮结束', 60]], 'second')];
  const incoming = [...page('older-first', [['第一轮过程', 10]], 'first'), { ...answer, id: 'older-answer' },
    { ...question, id: 'older-question' }, ...page('older-second', [['第二轮开始', 40], ['第二轮中间', 50]], 'second')];
  const merged = prependHistoryPage(incoming, current);
  assert.deepEqual(merged.map(item => item.text), ['第一轮过程', '第一轮回复', '第二轮问题', '第二轮开始\n\n第二轮中间\n\n第二轮结束']);
  assert.deepEqual(merged.map(item => item.id), current.map(item => item.id));
});

test('equal progress text at different times survives; separate turns and visible interruptions stay separate', () => {
  const repeated = prependHistoryPage(page('older', [['检查中', 10]]), page('newer', [['检查中', 20]]));
  assert.equal(repeated[0].text, '检查中\n\n检查中');
  for (const barrier of [
    { id: 'user', kind: 'user' as const, text: '补充要求' },
    { id: 'image', kind: 'progress' as const, text: '', attachment: { path: 'C:/image.png', name: 'image' } },
    { id: 'visual', kind: 'progress' as const, text: '', visualization: { path: 'C:/chart.html', name: 'chart', source: 'visualize' as const } },
    { id: 'notice', kind: 'system' as const, text: '上下文已压缩' },
  ]) {
    const result = prependHistoryPage([...page('a', [['之前', 10]]), { ...barrier, historyTurnId: 'turn', completedAt: base + 20 }], page('b', [['之后', 30]]));
    assert.equal(result.length, 3);
  }
  assert.equal(prependHistoryPage(page('a', [['第一轮', 10]], 'first'), page('b', [['第二轮', 20]], 'second')).length, 2);
});
