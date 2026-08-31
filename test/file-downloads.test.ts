import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DOWNLOAD_CHUNK_BYTES,
  DownloadManager,
} from '../src/connector/file-downloads.js';

test('arbitrary local files download through a client-bound capability without an extension allowlist', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'document.anything');
  const contents = Buffer.alloc(DOWNLOAD_CHUNK_BYTES + 17, 0x5a);
  await writeFile(path, contents);
  const downloads = new DownloadManager({ auditPath: null, allowAnyFileDownload: true });
  t.after(() => downloads.closeAll());

  const opened = await downloads.open({ path, confirmed: true }, 'client-a');
  assert.equal(opened.name, 'document.anything');
  assert.equal(opened.size, contents.length);
  assert.equal(Object.hasOwn(opened, 'path'), false);

  const concurrent = await Promise.allSettled([
    downloads.read({ ...opened, offset: 0 }, 'client-a'),
    downloads.read({ ...opened, offset: 0 }, 'client-a'),
  ]);
  const completedRead = concurrent.find((result) => result.status === 'fulfilled');
  const rejectedRead = concurrent.find((result) => result.status === 'rejected');
  assert.ok(completedRead && completedRead.status === 'fulfilled');
  assert.ok(rejectedRead && rejectedRead.status === 'rejected');
  assert.match(String(rejectedRead.reason), /download_in_progress/);
  const first = completedRead.value;
  const second = await downloads.read({ ...opened, offset: first.nextOffset }, 'client-a');
  assert.equal(first.done, false);
  assert.equal(second.done, true);
  assert.deepEqual(Buffer.concat([
    Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64'),
  ]), contents);
  assert.deepEqual(
    await downloads.read({ ...opened, offset: first.nextOffset }, 'client-a'),
    second,
  );
  await assert.rejects(
    () => downloads.read({ ...opened, offset: second.nextOffset }, 'client-a'),
    /download_offset_invalid/,
  );
  await downloads.close(opened, 'client-a');
});

test('download requires confirmation and only replays the latest chunk to its authorized client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private.bin');
  await writeFile(path, Buffer.alloc(DOWNLOAD_CHUNK_BYTES + 1, 0x31));
  const downloads = new DownloadManager({ auditPath: null, allowAnyFileDownload: true });
  t.after(() => downloads.closeAll());

  await assert.rejects(() => downloads.open({ path }, 'client-a'), /download_confirmation_required/);
  const opened = await downloads.open({ path, confirmed: true }, 'client-a');
  await assert.rejects(() => downloads.read({ ...opened, offset: 0 }, 'client-b'), /download_capability_invalid/);
  await assert.rejects(() => downloads.read({ ...opened, downloadToken: 'guessed', offset: 0 }, 'client-a'), /download_capability_invalid/);
  await assert.rejects(() => downloads.read({ ...opened, offset: 1 }, 'client-a'), /download_offset_invalid/);
  const first = await downloads.read({ ...opened, offset: 0 }, 'client-a');
  assert.deepEqual(await downloads.read({ ...opened, offset: 0 }, 'client-a'), first);
  await downloads.close(opened, 'client-a');
  assert.equal(first.nextOffset, DOWNLOAD_CHUNK_BYTES);
});

test('download rejects directories, relative paths, and files changed during transfer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'mutable');
  await writeFile(path, 'before');
  const downloads = new DownloadManager({ auditPath: null, allowAnyFileDownload: true });
  t.after(() => downloads.closeAll());

  await assert.rejects(
    () => downloads.open({ path: 'relative.txt', confirmed: true }, 'relative-client'),
    /download_path_must_be_absolute/,
  );
  await assert.rejects(
    () => downloads.open({ path: directory, confirmed: true }, 'directory-client'),
    /download_not_a_file/,
  );
  const opened = await downloads.open({ path, confirmed: true }, 'client-a');
  await writeFile(path, 'after-change');
  await assert.rejects(() => downloads.read({ ...opened, offset: 0 }, 'client-a'), /download_file_changed/);
});

test('download capabilities expire and chunk requests are rate limited', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'large.bin');
  await writeFile(path, Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 2 + 1, 0x22));
  let now = 1_000;
  const downloads = new DownloadManager({
    auditPath: null,
    clock: () => now,
    ttlMs: 100,
    rateWindowMs: 1_000,
    maxChunksPerWindow: 1,
    allowAnyFileDownload: true,
  });
  t.after(() => downloads.closeAll());

  const rateLimited = await downloads.open({ path, confirmed: true }, 'client-a');
  const first = await downloads.read({ ...rateLimited, offset: 0 }, 'client-a');
  await assert.rejects(
    () => downloads.read({ ...rateLimited, offset: first.nextOffset }, 'client-a'),
    /download_rate_limited/,
  );
  await downloads.close(rateLimited, 'client-a');

  const expiring = await downloads.open({ path, confirmed: true }, 'client-b');
  now += 101;
  await assert.rejects(() => downloads.read({ ...expiring, offset: 0 }, 'client-b'), /download_capability_invalid/);
});

test('download audit is local and de-identified', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'personal-name.secret');
  const auditPath = join(directory, 'audit', 'downloads.jsonl');
  await writeFile(path, 'audit me');
  const downloads = new DownloadManager({ auditPath, allowAnyFileDownload: true });
  t.after(() => downloads.closeAll());

  const opened = await downloads.open({ path, confirmed: true }, 'private-client-id');
  await downloads.read({ ...opened, offset: 0 }, 'private-client-id');
  const audit = await readFile(auditPath, 'utf8');
  const records = audit.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.event), ['opened', 'completed']);
  assert.equal(audit.includes(path), false);
  assert.equal(audit.includes('personal-name'), false);
  assert.equal(audit.includes('private-client-id'), false);
  assert.match(records[0].pathHash, /^[a-f0-9]{24}$/);
});

test('download defaults to configured roots and rejects sibling paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-download-root-test-'));
  const allowedRoot = join(directory, 'allowed');
  const siblingRoot = join(directory, 'sibling');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([mkdir(allowedRoot), mkdir(siblingRoot)]);
  const allowedPath = join(allowedRoot, 'report.bin');
  const deniedPath = join(siblingRoot, 'secret.bin');
  await Promise.all([writeFile(allowedPath, 'allowed'), writeFile(deniedPath, 'denied')]);
  const downloads = new DownloadManager({ auditPath: null, allowedRoots: [allowedRoot] });
  t.after(() => downloads.closeAll());

  const opened = await downloads.open({ path: allowedPath, confirmed: true }, 'allowed-client');
  await downloads.close(opened, 'allowed-client');
  await assert.rejects(
    () => downloads.open({ path: deniedPath, confirmed: true }, 'denied-client'),
    /download_path_not_allowed/,
  );
});
