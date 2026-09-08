import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRolloutTail, internals } from '../src/connector/rollout-tail.js';

const row = (type: string, payload: object) => JSON.stringify({ type, payload }) + '\n';
const message = (text: string) => row('response_item', { type: 'message', role: 'assistant',
  phase: 'commentary', content: [{ type: 'output_text', text }] });
const text = (page: Awaited<ReturnType<typeof readRolloutTail>>) => page.turns.flatMap(t => t.items.map(i => i.text)).join('\n');
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-empty-history-'));
  const filePath = join(directory, 'rollout.jsonl');
  t.after(async () => { internals.rolloutCache.delete(filePath); await rm(directory, { recursive: true, force: true }); });
  return filePath;
}

test('history and live polling cross a multi-megabyte compaction followed only by tools', async (t) => {
  const filePath = await fixture(t);
  const prefix = message('older '.repeat(100000)) + message('Most recent visible reply');
  const compacted = row('compacted', { replacement_history: ['x'.repeat(7 * 1024 * 1024)] });
  await writeFile(filePath, prefix + compacted
    + row('event_msg', { type: 'task_started', turn_id: 'current-task' })
    + row('response_item', { type: 'custom_tool_call_output', output: 'tool data'.repeat(70000) })
    + row('event_msg', { type: 'token_count', info: {} }));
  const page = await readRolloutTail({ filePath, threadId: 'large', paged: true });
  assert.match(text(page), /Most recent visible reply/);
  assert.ok(page.nextCursor);
  assert.equal(page.turns[0].status, 'inProgress');
  const live = await readRolloutTail({ filePath, threadId: 'large' });
  assert.match(text(live), /Most recent visible reply/);
  await appendFile(filePath, message('New response after compaction'));
  const updated = await readRolloutTail({ filePath, threadId: 'large' });
  assert.match(text(updated), /Most recent visible reply[\s\S]*New response after compaction/);
});

test('empty-range scans stop at a byte budget and their cursor continues backwards', async (t) => {
  const filePath = await fixture(t);
  await writeFile(filePath, message('Before a very large internal record')
    + row('compacted', { replacement_history: ['x'.repeat(19 * 1024 * 1024)] })
    + row('event_msg', { type: 'token_count', info: {} }));
  const page = await readRolloutTail({ filePath, threadId: 'bounded', paged: true });
  assert.equal(text(page), '');
  assert.ok(page.nextCursor);
  const next = await readRolloutTail({ filePath, threadId: 'bounded', paged: true, cursor: page.nextCursor });
  assert.match(text(next), /Before a very large internal record/);
  assert.equal(next.nextCursor, null);
});
