import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRolloutTail, internals } from '../src/connector/rollout-tail.js';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { historyItems, mergeHistorySnapshot, type TimelineItem } from '../web/src/history-utils.js';
import { appendTimelineNotice } from '../web/src/timeline-notice-events.js';

const detail = 'Selected model is at capacity. Please try a different model.';
const event = (payload: object) => ({ type: 'event_msg', timestamp: '2026-09-09T15:08:04.081Z', payload });
const failed = event({ type: 'task_complete', turn_id: 'failed-turn',
  error: { message: detail, codex_error_info: 'server_overloaded' }, completed_at: 1788966484 });
const encode = (row: object) => JSON.stringify(row) + '\n';
const notices = (page: Awaited<ReturnType<typeof readRolloutTail>>) => historyItems(page.turns).filter(i => i.notice?.kind === 'turnStatus');

test('task_complete errors appear in live, cached and paged history, and do not fail the next turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-turn-errors-'));
  const filePath = join(directory, 'rollout.jsonl');
  t.after(async () => { internals.rolloutCache.delete(filePath); await rm(directory, { recursive: true, force: true }); });
  const read = () => readRolloutTail({ filePath, threadId: 'task' });
  await writeFile(filePath, encode(event({ type: 'task_started', turn_id: 'failed-turn' })));
  assert.equal((await read()).turns[0].status, 'inProgress');
  await appendFile(filePath, encode(failed));
  const live = await read();
  assert.equal(live.turns[0].status, 'failed');
  assert.equal(live.activityKind, '');
  assert.equal(notices(live).length, 1);
  assert.deepEqual(notices(live)[0].notice, { kind: 'turnStatus', status: 'failed', detail });
  assert.equal(notices(live)[0].historyTurnId, 'failed-turn');
  assert.deepEqual(await read(), live);
  internals.rolloutCache.delete(filePath);
  assert.deepEqual(await read(), live, 'cold and incremental readers agree');
  assert.equal(notices(await readRolloutTail({ filePath, threadId: 'task', paged: true })).length, 1);
  await appendFile(filePath, encode(event({ type: 'task_started', turn_id: 'new-turn' })));
  assert.equal((await read()).turns[0].status, 'inProgress');
  assert.equal(notices(await read())[0].historyTurnId, 'failed-turn');
  await appendFile(filePath, encode(event({ type: 'task_complete', turn_id: 'new-turn', error: null })));
  assert.equal((await read()).turns[0].status, 'completed');
  assert.equal(notices(await read()).length, 1);
});

test('error-only history is visible beyond internal records and older cursors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-error-pages-'));
  const filePath = join(directory, 'rollout.jsonl');
  t.after(async () => { internals.rolloutCache.delete(filePath); await rm(directory, { recursive: true, force: true }); });
  const internal = encode({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(800_000) } });
  await writeFile(filePath, encode(failed) + internal);
  const latest = await readRolloutTail({ filePath, threadId: 'task', paged: true });
  assert.equal(latest.turns[0].status, 'failed');
  assert.equal(notices(latest).length, 1);
  await appendFile(filePath, encode(event({ type: 'task_started', turn_id: 'next' }))
    + encode(event({ type: 'agent_message', phase: 'commentary', message: 'Continuing' })));
  const next = await readRolloutTail({ filePath, threadId: 'task', paged: true });
  assert.ok(next.nextCursor);
  const older = await readRolloutTail({ filePath, threadId: 'task', paged: true, cursor: next.nextCursor });
  assert.equal(notices(older)[0].notice?.kind, 'turnStatus');
  assert.equal(notices(older)[0].historyTurnId, 'failed-turn');
});

test('rollout terminal details are bounded and redacted while successful completions stay quiet', () => {
  for (const error of [{ message: 'password=private' }, 'x'.repeat(900), { codex_error_info: 'server_overloaded' }]) {
    const items = internals.mapRolloutRows([event({ type: 'task_complete', error })]);
    assert.equal(items.length, 1);
    assert.equal(items[0].notice?.kind, 'turnStatus');
    const notice = items[0].notice;
    if (notice?.kind === 'turnStatus') {
      assert.ok((notice.detail || '').length <= 500);
      assert.doesNotMatch(notice.detail || '', /private/);
    }
  }
  assert.deepEqual(internals.mapRolloutRows([event({ type: 'task_complete', error: null })]), []);
});

test('live terminal failures carry the reason and cannot end another task or newer turn', () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.activeTurn = { threadId: 'task', turnId: 'failed-turn', clientId: 'client', requestId: 'request' };
  codex.rpcRaw = async () => ({});
  const events: any[] = [];
  codex.on('turn-event', event => events.push(event));
  for (const [threadId, id] of [['other', 'failed-turn'], ['task', 'old-turn']]) {
    codex.handleNotification('turn/completed', { threadId, turn: { id, status: 'failed', error: { message: detail } } });
  }
  assert.equal(events.length, 0);
  assert.ok(codex.activeTurn);
  codex.handleNotification('turn/completed', { threadId: 'task', turn: { id: 'failed-turn', status: 'failed', error: { message: detail } } });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'turn.ended');
  assert.equal(events[0].payload.reason, 'failed');
  assert.equal(events[0].payload.error, detail);
  assert.equal(events[0].payload.turnId, 'failed-turn');
  assert.equal(codex.activeTurn, null);
});

test('duplicate terminal events collapse per turn and converge with persisted history', () => {
  const make = (id: string, turnId: string, text?: string): TimelineItem => ({
    id, kind: 'system', text: '', historyTurnId: turnId, transient: true,
    notice: { kind: 'turnStatus', status: 'failed', detail: text },
  });
  let items = appendTimelineNotice([], make('error', 'failed-turn', detail));
  items = appendTimelineNotice(items, make('ended', 'failed-turn'));
  assert.equal(items.length, 1);
  assert.equal(items[0].notice?.kind === 'turnStatus' && items[0].notice.detail, detail);
  const persisted = historyItems([{ id: 'tail:task', items: internals.mapRolloutRows([failed]) }]);
  assert.equal(mergeHistorySnapshot(items, persisted, new Set(['failed-turn'])).length, 1);
  assert.equal(appendTimelineNotice(items, make('next', 'next-turn', detail)).length, 2);
});
