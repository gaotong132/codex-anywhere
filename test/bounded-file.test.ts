import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodePreviewText, readBoundedFile } from '../src/connector/bounded-file.js';

for (const change of ['grow', 'shrink', 'rewrite'] as const) {
  test(`bounded preview rejects a file that changes during reading: ${change}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bounded-read-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'data');
    await writeFile(path, 'original');
    const handle = await open(path, 'r');
    t.after(() => handle.close());
    const stats = await handle.stat();
    if (change === 'grow') await appendFile(path, Buffer.alloc(100_000));
    if (change === 'shrink') await truncate(path, 2);
    if (change === 'rewrite') await writeFile(path, 'modified');
    let requestedBytes = 0;
    const read = handle.read.bind(handle);
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      requestedBytes += length;
      return read(buffer, offset, length, position);
    }) as typeof handle.read;
    await assert.rejects(readBoundedFile(handle, 16, 'preview', stats), /preview_file_changed/);
    assert.ok(requestedBytes <= stats.size * 2, 'growth never increases allocation or follows the file to EOF');
  });
}

test('bounded preview handles short reads, empty files, size limits and strict UTF-8', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bounded-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'data');
  const bytes = Buffer.from('\uFEFF中文🙂');
  await writeFile(path, bytes);
  const handle = await open(path, 'r');
  t.after(() => handle.close());
  const read = handle.read.bind(handle);
  handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => (
    read(buffer, offset, Math.min(length, 2), position)
  )) as typeof handle.read;
  assert.deepEqual(await readBoundedFile(handle, bytes.length, 'preview'), bytes);
  await assert.rejects(readBoundedFile(handle, bytes.length - 1, 'preview'), /preview_too_large/);
  assert.equal(decodePreviewText(bytes, 'preview'), '\uFEFF中文🙂');
  assert.throws(() => decodePreviewText(Buffer.from([0xff]), 'preview'), /preview_encoding_invalid/);
  assert.throws(() => decodePreviewText(Buffer.from([0]), 'preview'), /preview_content_invalid/);
  await truncate(path, 0);
  assert.equal((await readBoundedFile(handle, 16, 'preview')).length, 0);
});
