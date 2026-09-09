import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CompactionProgressReader } from '../src/connector/compaction-progress.js';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { initialConversationExecution, patchConversationExecution, resetConversationExecutionPresentation } from '../web/src/conversation-execution.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-compaction-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const filePath = join(directory, 'logs.sqlite');
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE logs(id INTEGER PRIMARY KEY, thread_id TEXT, ts INTEGER, ts_nanos INTEGER, target TEXT, feedback_log_body TEXT);
    CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);`);
  db.close();
  return { directory, filePath };
}
function log(path: string, threadId: string, turnId: string, at: number, compacting = true, span?: string) {
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO logs(thread_id,ts,ts_nanos,target,feedback_log_body) VALUES(?,?,?,?,?)').run(
    threadId, Math.floor(at / 1000), (at % 1000) * 1_000_000, 'codex_http_client::custom_ca',
    `session_loop{thread_id=${threadId}}:turn{turn.id=${turnId} model=example}:run_turn:${span || (compacting ? 'run_auto_compact{reason=ContextLimit phase=MidTurn}:' : '')}model_client.stream_responses_api: using system root certificates`,
  );
  db.close();
}

test('Desktop compaction reads exact task/turn spans, not high usage, preflight or old compactions', async (t) => {
  const { filePath } = await fixture(t);
  const now = Date.now() - 10000;
  log(filePath, 'task-a', 'turn-a', now + 1000);
  log(filePath, 'task-b', 'turn-b', now + 2000);
  const reader = new CompactionProgressReader(filePath);
  const request = { threadId: 'task-a', turnId: 'turn-a', turnStartedAt: now, after: now };
  const before = await readFile(filePath);
  const result = await reader.read(request);
  assert.deepEqual(result, { turnId: 'turn-a', startedAt: now + 1000 });
  assert.deepEqual(await Promise.all([reader.read(request), reader.read(request)]), [result, result]);
  assert.deepEqual(await readFile(filePath), before, 'database remains unchanged');
  assert.equal(await reader.read({ ...request, turnId: 'new-turn' }), null);
  assert.equal(await reader.read({ ...request, after: now + 1500 }), null, 'completed boundary wins');
  log(filePath, 'task-a', 'turn-a', now + 3000, false);
  assert.equal(await new CompactionProgressReader(filePath).read(request), null, 'a normal request means compaction is over');
  log(filePath, 'task-a', 'turn-a', now + 4000, false, 'run_pre_sampling_compact:');
  assert.equal(await new CompactionProgressReader(filePath).read(request), null, 'a preflight check does not prove compaction');
  log(filePath, 'task-a', 'turn-a', now + 5000);
  assert.deepEqual(await reader.read({ ...request, after: now + 4500 }), { turnId: 'turn-a', startedAt: now + 5000 });
});

test('missing or incompatible logs degrade without creating files; scans and caches stay bounded', async (t) => {
  const { directory, filePath } = await fixture(t);
  const request = { threadId: 'task', turnId: 'turn', turnStartedAt: Date.now() - 1000, after: 0 };
  const missing = join(directory, 'missing.sqlite');
  assert.equal(await new CompactionProgressReader(missing).read(request), null);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  log(filePath, 'task', 'turn', Date.now() - 500);
  const db = new DatabaseSync(filePath);
  const insert = db.prepare('INSERT INTO logs(thread_id,ts,ts_nanos,target,feedback_log_body) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 256; i++) insert.run('task', Math.floor(Date.now() / 1000), 999_999_999, 'unrelated', 'private output');
  db.close();
  assert.equal(await new CompactionProgressReader(filePath).read(request), null, 'does not scan past the 256-record window');
  const reader = new CompactionProgressReader(filePath);
  for (let i = 0; i < 30; i++) await reader.read({ ...request, threadId: `task-${i}` });
  assert.ok((reader as any).cache.size <= 12);
  const changed = new DatabaseSync(filePath); changed.exec('DROP TABLE logs'); changed.close();
  assert.equal(await new CompactionProgressReader(filePath).read(request), null);
});

test('history polling exposes an in-flight compaction and clears it at the persisted completion boundary', async (t) => {
  const { directory, filePath } = await fixture(t);
  const rollout = join(directory, 'rollout.jsonl');
  const now = Date.now() - 20000;
  const event = (time: number, type: string, payload: object) => JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n';
  await writeFile(rollout, event(now, 'event_msg', { type: 'task_started', turn_id: 'turn' })
    + event(now + 500, 'event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 100 }, model_context_window: 1000 } }));
  log(filePath, 'task', 'turn', now + 1000);
  const codex = new CodexAppServer({ runtimeCwd: directory });
  (codex as any).compactionProgress = new CompactionProgressReader(filePath);
  const first = await codex.readSessionTail('task', rollout);
  assert.equal(first.compactionStartedAt, now + 1000);
  assert.equal(first.activityStartedAt, now, 'run elapsed time keeps its original start');
  assert.equal(first.turns[0].status, 'inProgress');
  assert.equal((await codex.readSessionTail('other', rollout)).compactionStartedAt, null);
  await appendFile(rollout, event(now + 5000, 'compacted', { window_number: 2 }));
  assert.equal((await codex.readSessionTail('task', rollout)).compactionStartedAt, null);
  assert.equal((await codex.readSessionTail('task', rollout)).turns[0].status, 'inProgress');
  log(filePath, 'task', 'turn', now + 6000);
  assert.equal((await codex.readSessionTail('task', rollout)).compactionStartedAt, null, 'brief cached result stays stable');
  (codex as any).compactionProgress = new CompactionProgressReader(filePath);
  assert.equal((await codex.readSessionTail('task', rollout)).compactionStartedAt, now + 6000);
  await appendFile(rollout, event(now + 8000, 'event_msg', { type: 'task_complete', turn_id: 'turn' }));
  assert.equal((await codex.readSessionTail('task', rollout)).compactionStartedAt, null);
});

test('native compaction lifecycle is isolated, stable on duplicate starts and cleared on completion', () => {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.activeTurn = { threadId: 'task', turnId: 'turn', cwd: process.cwd(), state: 'running' };
  const events: any[] = []; codex.on('turn-event', event => events.push(event));
  const payload = { threadId: 'task', turnId: 'turn', item: { type: 'contextCompaction', id: 'compact-a' } };
  codex.handleNotification('item/started', { ...payload, threadId: 'other' });
  codex.handleNotification('item/started', { ...payload, turnId: 'old' });
  assert.equal(events.length, 0);
  codex.handleNotification('item/started', payload);
  const startedAt = codex.activeTurn.compaction?.startedAt;
  assert.ok(startedAt);
  codex.handleNotification('item/started', payload);
  assert.equal(codex.activeTurn.compaction?.startedAt, startedAt);
  codex.handleNotification('item/completed', { ...payload, item: { ...payload.item, id: 'older-compaction' } });
  assert.equal(events.length, 2);
  codex.handleNotification('item/completed', payload);
  assert.equal(codex.activeTurn.compaction, undefined);
  assert.equal(events.at(-1).event, 'turn.compaction');
  assert.equal(events.at(-1).payload.startedAt, null);
});

test('task switches clear the compaction presentation while retaining the background writer', () => {
  const current = patchConversationExecution(initialConversationExecution(), {
    running: true, ownedTurnThreadId: 'task', state: 'running', compactionStartedAt: Date.now(),
  });
  const next = resetConversationExecutionPresentation(current);
  assert.equal(next.compactionStartedAt, null);
  assert.equal(next.ownedTurnThreadId, 'task');
  assert.equal(next.running, true);
});
