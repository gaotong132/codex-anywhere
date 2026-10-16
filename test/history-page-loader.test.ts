import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHistoryPage } from '../web/src/history-page-loader.js';
import { historyItems, mergeHistorySnapshot, prependHistoryPage } from '../web/src/history-utils.js';
import type { HistoryPage } from '../web/src/app-types.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';

const summary: HistoryPage = {
  nextCursor: 'older', turns: [
    { id: 'latest', status: 'completed', items: [
      { type: 'userMessage', text: 'question' },
      { type: 'agentMessage', phase: 'final_answer', text: 'answer' },
    ] },
    { id: 'previous', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'earlier answer' }] },
  ],
};
const live: HistoryPage = {
  nextCursor: null, activityId: 'latest', turns: [{ id: 'tail:session', status: 'completed', items: [
    { type: 'agentMessage', turnId: 'latest', phase: 'commentary', text: 'checking files' },
    { type: 'agentMessage', turnId: 'latest', phase: 'final_answer', text: 'answer' },
  ] }],
};

test('summary seconds and rollout write times merge once on load, polling and pagination', async () => {
  const saved: HistoryPage = { source: 'appServer', turns: [{
    id: 'native-turn', startedAt: 1_792_114_039, completedAt: 1_792_114_047, items: [
      { type: 'userMessage', text: 'add a slide' },
      { type: 'agentMessage', text: 'waiting for the screenshot' },
    ],
  }] };
  const tail: HistoryPage = { source: 'rolloutTail', turns: [{
    id: 'tail:session', items: [
      { type: 'userMessage', turnId: 'native-turn', text: 'add a slide', completedAt: 1_792_114_040_022 },
      { type: 'agentMessage', turnId: 'native-turn', text: 'waiting for the screenshot', completedAt: 1_792_114_047_004 },
    ],
  }] };
  const request: BridgeRequest = (async (_action, payload) => payload.mode === 'live' ? tail : saved) as BridgeRequest;
  const loaded = await loadHistoryPage(request, 'session', null, 6);
  assert.equal(loaded.items.length, 2);
  assert.deepEqual(loaded.items.map(item => item.id), historyItems(saved.turns).map(item => item.id));
  assert.ok(loaded.items.every(item => item.historySource === 'rollout'));
  let items = loaded.items;
  for (let index = 0; index < 5; index++) {
    items = mergeHistorySnapshot(items, historyItems(tail.turns, tail.source), new Set(['native-turn']), { partial: true });
    assert.deepEqual(items, loaded.items);
  }
  assert.deepEqual(prependHistoryPage(historyItems(saved.turns, saved.source), items), items);
  const paged = historyItems([{ ...tail.turns[0], id: 'rollout:session:older' }], 'rolloutPage');
  assert.deepEqual(prependHistoryPage(paged, items), items);
  assert.deepEqual((await loadHistoryPage(request, 'session', null, 6)).items, loaded.items);
});

test('initial history starts both reads together and publishes only after both complete', async () => {
  for (const first of ['conversation', 'live']) {
    const pending = new Map<string, (page: HistoryPage) => void>();
    const request: BridgeRequest = ((_action, payload) => new Promise((resolve) => {
      pending.set(String(payload.mode), resolve);
    })) as BridgeRequest;
    let displayed = false;
    const result = loadHistoryPage(request, 'session', null, 6).then((value) => { displayed = true; return value; });
    assert.deepEqual([...pending.keys()], ['conversation', 'live']);
    pending.get(first)!(first === 'live' ? live : summary);
    await Promise.resolve();
    assert.equal(displayed, false, 'one response cannot publish a partial timeline');
    const second = first === 'live' ? 'conversation' : 'live';
    pending.get(second)!(second === 'live' ? live : summary);
    const loaded = await result;
    assert.deepEqual(loaded.items.map((item) => item.text), ['earlier answer', 'question', 'checking files', 'answer']);
    assert.equal(loaded.page.nextCursor, 'older');
    assert.equal(loaded.snapshot?.activityId, 'latest');
  }
});

test('live failure falls back to history; older pages never fetch current progress', async () => {
  const calls: unknown[] = [];
  const request: BridgeRequest = (async (_action, payload, options) => {
    calls.push({ mode: payload.mode, options });
    if (payload.mode === 'live') throw new Error('request_timeout');
    return summary;
  }) as BridgeRequest;
  const first = await loadHistoryPage(request, 'session', null, 6);
  assert.equal(first.snapshot, null);
  assert.ok(first.items.some((item) => item.text === 'answer'));
  assert.deepEqual(calls[1], { mode: 'live', options: { timeoutMs: 5000 } });
  calls.length = 0;
  const older = await loadHistoryPage(request, 'session', 'older', 6);
  assert.equal(calls.length, 1);
  assert.equal(older.snapshot, null);
});

test('a live snapshot taken before completion cannot hide the final answer or regress status', async () => {
  const running = { ...live, turns: [{ ...live.turns[0], status: 'inProgress', items: [live.turns[0].items![0]] }] };
  const request: BridgeRequest = (async (_action, payload) => payload.mode === 'live' ? running : summary) as BridgeRequest;
  const loaded = await loadHistoryPage(request, 'session', null, 6);
  assert.deepEqual(loaded.items.map((item) => item.text), ['earlier answer', 'question', 'checking files', 'answer']);
  assert.equal(loaded.snapshot?.turns[0]?.status, 'completed');
});

test('a newer summary turn keeps its running status when the parallel live snapshot is older', async () => {
  const newer = { ...summary, turns: [{ id: 'new-turn', status: 'inProgress', items: [
    { type: 'userMessage', text: 'next question' },
  ] }, ...summary.turns] };
  const request: BridgeRequest = (async (_action, payload) => payload.mode === 'live' ? live : newer) as BridgeRequest;
  const loaded = await loadHistoryPage(request, 'session', null, 6);
  assert.equal(loaded.snapshot?.turns[0]?.id, 'new-turn');
  assert.equal(loaded.snapshot?.turns[0]?.status, 'inProgress');
  assert.equal(loaded.items.at(-1)?.text, 'next question');
});
