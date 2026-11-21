import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { internals } from '../src/connector/rollout-tail.js';
import { loadHistoryPage } from '../web/src/history-page-loader.js';
import { historyItems, mergeHistorySnapshot, prependHistoryPage } from '../web/src/history-utils.js';
import type { HistoryPage } from '../web/src/app-types.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';

const threadId = 'long-session';
const turnId = 'single-long-turn';
const start = 1_800_000_000_000;
const row = (payload: object, seconds = 0, type = 'event_msg') => JSON.stringify({
  timestamp: new Date(start + seconds * 1000).toISOString(), type, payload,
}) + '\n';
const commentary = (text: string, seconds: number) => row({
  type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }],
}, seconds, 'response_item');

test('a single turn below 64 MiB exposes all process messages across paging, polling and refresh', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-long-turn-'));
  const filePath = join(directory, 'rollout.jsonl');
  t.after(async () => { internals.rolloutCache.delete(filePath); await rm(directory, { recursive: true }); });
  const codex = new CodexAppServer({ runtimeCwd: directory });
  codex.ensureStarted = async () => {};
  let recovered = 0;
  // A new Connector must resolve metadata for the conversation request too,
  // instead of racing the parallel live request and choosing summaries.
  codex.listSessions = async () => {
    recovered++;
    codex.sessionMetadata.set(threadId, { cwd: directory, path: filePath, canAcceptDirectInput: false });
    return [];
  };
  codex.rpcRaw = async () => { throw new Error('summaries must not hide this turn or end its pagination'); };
  const updates = Array.from({ length: 24 }, (_, index) => `Progress ${index}: ${'完整正文。'.repeat(1000)}`);
  const hidden = 'private tool output that is never a chat message '.repeat(6500);
  await writeFile(filePath, row({ type: 'task_started', turn_id: turnId })
    + row({ type: 'user_message', message: 'initial request' }, 1)
    + updates.map((text, index) => commentary(text, index * 2 + 2)
      + row({ type: 'function_call_output', output: hidden }, index * 2 + 3, 'response_item')).join(''));

  const request: BridgeRequest = (async (_action, payload) => codex.listSessionTurns(threadId, payload)) as BridgeRequest;
  const initial = await loadHistoryPage(request, threadId, null, 6);
  assert.equal(initial.page.source, 'rolloutPage');
  assert.ok(initial.page.nextCursor, 'a single native turn must still have an older-history cursor');
  assert.equal(initial.snapshot?.turns[0].status, 'inProgress');
  assert.ok(recovered > 0);
  let items = initial.items;
  let cursor = initial.page.nextCursor;
  const cursors = new Set<string>();
  while (cursor) {
    assert.ok(!cursors.has(cursor), 'pagination must advance');
    cursors.add(cursor);
    const page = await loadHistoryPage(request, threadId, cursor, 6);
    items = prependHistoryPage(page.items, items);
    cursor = page.page.nextCursor;
    assert.ok(cursors.size < 30);
  }
  const expected = updates.join('\n\n');
  assert.equal(items.filter(item => item.kind === 'progress').map(item => item.text).join('\n\n'), expected);
  assert.equal(items.filter(item => item.kind === 'user').length, 1);
  assert.equal(items[0].text, 'initial request');
  assert.ok(!JSON.stringify(items).includes('private tool output'));
  assert.equal(new Set(items.map(item => item.id)).size, items.length);

  await appendFile(filePath, commentary('Newest update', 60));
  const live = await codex.listSessionTurns(threadId, { mode: 'live' });
  const latest = historyItems(live.turns, live.source);
  for (let index = 0; index < 3; index++) {
    items = mergeHistorySnapshot(items, latest, new Set([turnId]), { partial: true });
    assert.equal(items.filter(item => item.kind === 'progress').map(item => item.text).join('\n\n'), `${expected}\n\nNewest update`);
    assert.equal(items.filter(item => item.kind === 'user').length, 1);
  }
  const refreshed = await loadHistoryPage(request, threadId, null, 6);
  assert.ok(refreshed.page.nextCursor, 'reopening must not turn a bounded live tail into complete history');
  const finalText = 'Complete final reply';
  await appendFile(filePath, row({ type: 'task_complete', turn_id: turnId, last_agent_message: finalText }, 61));
  const completed = await codex.listSessionTurns(threadId);
  assert.equal(completed.turns[0].status, 'completed');
  assert.equal(completed.turns[0].items.at(-1)?.text, finalText);
});

test('unreadable local history falls back to native summaries and preserves their cursor', async () => {
  const codex = new CodexAppServer();
  codex.ensureStarted = async () => {};
  codex.sessionMetadata.set(threadId, { cwd: process.cwd(), path: 'missing-rollout.jsonl', canAcceptDirectInput: false });
  const summary: HistoryPage = { threadId, turns: [{ id: turnId, status: 'completed', items: [
    { type: 'userMessage', text: 'request' }, { type: 'agentMessage', phase: 'final_answer', text: 'reply' },
  ] }], nextCursor: 'older-native-turn' };
  const calls: string[] = [];
  codex.rpcRaw = async (method) => { calls.push(method); return { data: summary.turns, nextCursor: summary.nextCursor }; };
  const result = await codex.listSessionTurns(threadId);
  assert.equal(result.source, 'appServer');
  assert.equal(result.nextCursor, summary.nextCursor);
  assert.deepEqual(result.turns[0].items.map((item: { text: string }) => item.text), ['request', 'reply']);
  assert.deepEqual(calls, ['thread/turns/list']);
});
