import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRolloutTail, internals } from '../src/connector/rollout-tail.js';

const row = (text: string) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }],
} }) + '\n';

test('rollout cache follows append, same-size rewrites, replacement and truncate-regrow', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rollout-cache-'));
  const path = join(directory, 'rollout.jsonl');
  t.after(async () => { internals.rolloutCache.delete(path); await rm(directory, { recursive: true, force: true }); });
  const read = () => readRolloutTail({ filePath: path, threadId: 'cache-test' });
  const text = (result: Awaited<ReturnType<typeof read>>) => result.turns.flatMap((turn) => turn.items.map((item) => item.text)).join('\n');
  await writeFile(path, row('first'));
  assert.match(text(await read()), /first/);
  await appendFile(path, row('second'));
  assert.match(text(await read()), /first[\s\S]*second/);
  await writeFile(path, row('other') + row('latest'));
  await utimes(path, new Date(), new Date(Date.now() + 1000));
  assert.doesNotMatch(text(await read()), /first|second/);
  assert.match(text(await read()), /latest/);
  await writeFile(path, row('rewritten with more bytes than the previously cached file'.repeat(6)));
  assert.doesNotMatch(text(await read()), /other|latest/);
  const replacement = join(directory, 'replacement');
  await writeFile(replacement, row('replacement '.repeat(80)));
  await rename(replacement, path);
  assert.match(text(await read()), /replacement/);
  assert.doesNotMatch(text(await read()), /rewritten/);
});
