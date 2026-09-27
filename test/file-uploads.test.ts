import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { FileUploadManager } from '../src/connector/file-uploads.js';
import { DownloadManager } from '../src/connector/file-downloads.js';
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, safeUploadName } from '../src/shared/file-upload.js';
import { buildFileMessage, prepareAttachment, uploadFile } from '../web/src/file-upload.js';
import { parseUserMessage } from '../src/shared/message-content.js';
import { localFilePathFromHref } from '../web/src/file-utils.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new FileUploadManager({ directory, now });
}

test('Web chunks preserve arbitrary binary bytes beyond a secure frame and produce a downloadable file', async (t) => {
  const manager = await fixture(t);
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const file = new File([bytes], '测试 report.zip', { type: 'application/zip' });
  const prepared = await prepareAttachment(file);
  assert.equal(prepared.kind, 'file');
  assert.equal(prepared.file, file);
  assert.equal(prepared.previewUrl, '');
  const progress: number[] = [];
  let chunks = 0;
  const result = await uploadFile(file, async <T>(action: string, payload: Record<string, unknown>): Promise<T> => {
    if (action === 'connector.status') return { capabilities: { fileUpload: true } } as T;
    const method = action.split('.').at(-1) as 'begin' | 'chunk' | 'complete' | 'cancel';
    if (method === 'chunk') {
      chunks++;
      assert.ok(JSON.stringify(payload).length < 400_000);
    }
    return await manager[method](payload, 'approved-device') as T;
  }, (state) => progress.push(state.percent), () => true);
  assert.ok(chunks > 20);
  assert.equal(dirname(result.path), manager.directory);
  assert.equal(result.name, file.name);
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(result.path), bytes);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
  const downloads = new DownloadManager({ allowedRoots: [manager.directory], auditPath: null });
  const opened = await downloads.open({ path: result.path, confirmed: true }, 'approved-device');
  assert.equal(opened.size, bytes.length);
  await downloads.close(opened, 'approved-device');
});

test('uploads enforce ownership, exact offsets, bounds, complete size, and strict binary encoding', async (t) => {
  const manager = await fixture(t);
  const opened = await manager.begin({ name: '../../escape.bin', size: 2 }, 'a');
  const payload = { uploadId: opened.uploadId, offset: 0, data: 'AP8=' };
  await assert.rejects(manager.chunk(payload, 'b'), /not_found/);
  await assert.rejects(manager.complete(opened, 'b'), /not_found/);
  await assert.rejects(manager.cancel(opened, 'b'), /not_found/);
  await assert.rejects(manager.chunk({ ...payload, offset: 1 }, 'a'), /offset_mismatch/);
  await assert.rejects(manager.chunk({ ...payload, data: 'AP9=' }, 'a'), /size_mismatch/);
  await assert.rejects(manager.chunk({ ...payload, data: '!!!!' }, 'a'), /invalid_base64/);
  await assert.rejects(manager.chunk({ ...payload, data: Buffer.alloc(UPLOAD_CHUNK_BYTES + 1).toString('base64') }, 'a'), /invalid_base64|size_mismatch/);
  await assert.rejects(manager.complete(opened, 'a'), /size_mismatch/);
  await manager.chunk(payload, 'a');
  await assert.rejects(manager.chunk(payload, 'a'), /offset_mismatch/);
  const result = await manager.complete(opened, 'a');
  assert.equal(dirname(result.path), manager.directory);
  assert.ok(!result.name.includes('/'));
  assert.deepEqual(await readFile(result.path), Buffer.from([0, 255]));
  await assert.rejects(manager.complete(opened, 'a'), /not_found/);
  await assert.rejects(manager.begin({ name: 'big.bin', size: MAX_UPLOAD_BYTES + 1 }, 'a'), /too_large/);
  await assert.rejects(manager.begin({ name: 'invalid.bin', size: -1 }, 'a'), /too_large/);
  await assert.rejects(manager.begin({ name: 'owner.bin', size: 0 }), /owner_required/);
});

test('incomplete uploads are bounded, cancellable, expire and recover slots without publishing partial files', async (t) => {
  let now = Date.now();
  const manager = await fixture(t, () => now);
  const a = await manager.begin({ size: 10 }, 'a');
  await manager.begin({ size: 10 }, 'a');
  await assert.rejects(manager.begin({ size: 10 }, 'a'), /limit/);
  await manager.begin({ size: 10 }, 'b');
  await manager.begin({ size: 10 }, 'c');
  await assert.rejects(manager.begin({ size: 10 }, 'd'), /limit/);
  assert.ok((await readdir(manager.directory)).every((name) => name.endsWith('.part')));
  await manager.cancel(a, 'a');
  assert.equal((await readdir(manager.directory)).length, 3);
  now += 31 * 60_000;
  const empty = await manager.begin({ name: 'empty.bin', size: 0 }, 'a');
  assert.equal((await readdir(manager.directory)).length, 1);
  const result = await manager.complete(empty, 'a');
  assert.equal((await readFile(result.path)).length, 0);
  assert.equal(result.sha256, createHash('sha256').digest('hex'));
});

test('changing the selected session cancels file upload before sending another chunk', async (t) => {
  const manager = await fixture(t);
  let current = true;
  const file = new File([Buffer.alloc(UPLOAD_CHUNK_BYTES + 1)], 'cancel.bin');
  await assert.rejects(uploadFile(file, async <T>(action: string, payload: Record<string, unknown>): Promise<T> => {
    if (action === 'connector.status') return { capabilities: { fileUpload: true } } as T;
    const method = action.split('.').at(-1) as 'begin' | 'chunk' | 'complete' | 'cancel';
    const result = await manager[method](payload, 'a');
    if (method === 'chunk') current = false;
    return result as T;
  }, () => {}, () => current), /cancelled/);
  assert.deepEqual(await readdir(manager.directory), []);
});

test('old connectors reject generic uploads clearly without attempting a transfer', async () => {
  const actions: string[] = [];
  await assert.rejects(uploadFile(new File(['x'], 'file.bin'), async <T>(action: string): Promise<T> => {
    actions.push(action);
    return { capabilities: {} } as T;
  }, () => {}, () => true), /unsupported/);
  assert.deepEqual(actions, ['connector.status']);
});

test('file links persist in history with escaped filenames and arbitrary extensions', () => {
  const file = { path: 'C:\\Temp\\files\\uuid-测试 [a] #50%.exe', name: '测试 [a] #50%.exe', size: 2, sha256: 'a'.repeat(64) };
  const message = buildFileMessage('分析这个文件', file);
  assert.equal(parseUserMessage(message.turnText).text, message.visibleText);
  const href = /\]\(<([^>]+)>\)/.exec(message.visibleText)?.[1];
  assert.ok(href);
  assert.equal(localFilePathFromHref(href), file.path);
  assert.ok(new TextEncoder().encode(safeUploadName('测'.repeat(200))).length <= 160);
  assert.equal(safeUploadName(''), 'attachment.bin');
});

