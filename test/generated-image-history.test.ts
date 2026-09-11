import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractGeneratedImageAttachment } from '../src/connector/generated-images.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { internals, readRolloutGeneratedImages, readRolloutTail } from '../src/connector/rollout-tail.js';
import { historyItems } from '../web/src/history-utils.js';

const savedPath = 'C:\\Users\\example\\.codex\\generated_images\\thread-image\\result.png';
const image = {
  type: 'Extension', kind: 'image_gen.generation', id: 'image-1',
  status: 'completed', failure: null, result: 'base64-result', savedPath,
};
const attachment = { path: savedPath, name: 'result.png', source: 'generated' };
const completedAt = 1789110787771;

test('Extension image generations reach API and rollout history without binary tool output', () => {
  const api = mapTurns([{ id: 'turn-image', completedAt, items: [image] }]);
  const rows = internals.mapRolloutRows([{
    timestamp: new Date(completedAt).toISOString(), type: 'event_msg',
    payload: { type: 'item_completed', turn_id: 'turn-image', item: image },
  }]);
  for (const turns of [api, [{ id: 'tail', items: rows }]]) {
    const timeline = historyItems(turns);
    assert.equal(timeline.length, 1);
    assert.deepEqual(timeline[0].attachment, attachment);
    assert.equal(timeline[0].historyTurnId, 'turn-image');
    assert.equal(turns[0].items[0].completedAt, completedAt);
    assert.ok(!JSON.stringify(turns).includes('base64-result'));
  }
});

test('unrelated, unfinished and failed extension items do not become generated images', () => {
  for (const item of [
    { ...image, kind: 'other.extension' }, { ...image, type: 'ImageView' },
    { ...image, status: 'inProgress' }, { ...image, status: 'failed' },
    { ...image, failure: { message: 'failed' } }, { ...image, savedPath: '' },
  ]) {
    assert.equal(extractGeneratedImageAttachment(item), undefined);
    assert.deepEqual(mapTurns([{ id: 'turn-image', items: [item] }])[0].items, []);
  }
});

test('bounded tail and older pages recover Extension images across large Base64 rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-extension-images-'));
  const filePath = join(directory, 'rollout.jsonl');
  const row = (value: unknown) => JSON.stringify(value) + '\n';
  const turn = (id: string, path: string, time: number) => [
    row({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }),
    row({ timestamp: new Date(time).toISOString(), type: 'event_msg', payload: {
      type: 'item_completed', turn_id: id,
      item: { ...image, result: 'x'.repeat(800 * 1024), savedPath: path },
      started_at_ms: time - 1000, completed_at_ms: time,
    } }),
    row({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', output: [{ type: 'input_image', image_url: 'x'.repeat(800 * 1024) }],
    } }),
    row({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: 'image ready' } }),
  ].join('');
  try {
    await writeFile(filePath, turn('first', savedPath, completedAt)
      + turn('second', savedPath.replace('result.png', 'edited.png'), completedAt + 1000));
    // The tail starts inside the latest generation's binary result.
    const tail = await readRolloutTail({ filePath, threadId: 'thread-image', maxBytes: 1200 * 1024 });
    const latest = tail.turns.flatMap((t) => t.items).filter((item) => item.attachment);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].attachment?.name, 'edited.png');
    assert.equal(latest[0].completedAt, completedAt + 1000);
    assert.equal(latest[0].turnId, 'second');

    let cursor: string | null = null;
    const images: typeof latest = [];
    for (let page = 0; page < 20; page++) {
      const result = await readRolloutTail({ filePath, threadId: 'thread-image', paged: true, cursor });
      assert.ok(JSON.stringify(result).length < 10_000, 'history never transfers Base64 rows');
      images.push(...result.turns.flatMap((t) => t.items).filter((item) => item.attachment));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.deepEqual(images.map((item) => [item.attachment?.name, item.turnId, item.completedAt]), [
      ['edited.png', 'second', completedAt + 1000], ['result.png', 'first', completedAt],
    ]);
    const references = await readRolloutGeneratedImages(filePath);
    assert.deepEqual(references.map((item) => item.attachment?.name), ['result.png', 'edited.png']);
    assert.equal(await readRolloutGeneratedImages(filePath), references, 'unchanged file reuses only metadata');
    await appendFile(filePath, turn('third', savedPath.replace('result.png', 'third.png'), completedAt + 2000));
    assert.equal((await readRolloutGeneratedImages(filePath)).length, 3, 'appends refresh the cached references');
  } finally {
    internals.rolloutCache.delete(filePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation summaries receive only their own missing images without fetching full turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-summary-images-'));
  const filePath = join(directory, 'rollout.jsonl');
  const codex = new CodexAppServer({ runtimeCwd: directory });
  codex.ensureStarted = async () => {};
  codex.sessionMetadata.set('thread-image', { cwd: directory, path: filePath, canAcceptDirectInput: false });
  const summaryItems = [{ type: 'userMessage', text: 'make an image' },
    { type: 'agentMessage', phase: 'final_answer', text: 'image ready' }];
  const calls: string[] = [];
  codex.rpcRaw = async (method, params) => {
    calls.push(method);
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'summary');
    return { data: [
      { id: 'turn-image', items: summaryItems },
      { id: 'already-present', items: [image, ...summaryItems] },
      { id: 'unrelated', items: summaryItems },
    ], nextCursor: 'older-api-page' } as any;
  };
  try {
    await writeFile(filePath, ['turn-image', 'already-present', 'not-on-page'].map((id) => JSON.stringify({
      timestamp: new Date(completedAt).toISOString(), type: 'event_msg',
      payload: { type: 'item_completed', turn_id: id, item: image },
    }) + '\n').join(''));
    const result = await codex.listSessionTurns('thread-image');
    assert.equal(result.source, 'appServer');
    assert.equal(result.nextCursor, 'older-api-page');
    assert.deepEqual(result.turns.map((t) => t.items.filter((i: any) => i.attachment).length), [1, 1, 0]);
    assert.deepEqual(result.turns[0].items.map((i: any) => i.attachment?.name || i.text), [
      'make an image', 'result.png', 'image ready',
    ]);
    assert.deepEqual(calls, ['thread/turns/list']);
    assert.ok(!JSON.stringify(result).includes('base64-result'));
    await rm(filePath);
    assert.equal((await codex.listSessionTurns('thread-image')).turns[0].items.length, 2, 'missing rollout preserves ordinary history');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
