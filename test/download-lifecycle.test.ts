import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DownloadManager } from '../src/connector/file-downloads.js';

test('concurrent download opens reserve one capability per client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'download-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file.bin');
  await writeFile(path, 'download');
  const manager = new DownloadManager({ auditPath: null, allowedRoots: [root] });
  t.after(() => manager.closeAll());
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => manager.open({ path, confirmed: true }, 'client')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(manager.sessions.size, 1);
  for (const result of results) if (result.status === 'rejected') assert.match(String(result.reason), /download_in_progress/);
  const next = await manager.open({ path, confirmed: true }, 'client');
  assert.equal(manager.sessions.size, 1);
  assert.equal((await manager.read({ ...next, offset: 0 }, 'client')).done, true);
});

test('shutdown rejects an unfinished open and cannot publish new capabilities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'download-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file.bin');
  await writeFile(path, 'download');
  const manager = new DownloadManager({ auditPath: null, allowedRoots: [root] });
  t.after(() => manager.closeAll());
  const pending = manager.open({ path, confirmed: true }, 'client');
  const rejected = assert.rejects(pending, /download_manager_closed/);
  await manager.closeAll();
  await rejected;
  assert.equal(manager.sessions.size, 0);
  await assert.rejects(manager.open({ path, confirmed: true }, 'client'), /download_manager_closed/);
});

test('expiry pruning cannot close another client\'s active read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'download-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file.bin');
  await writeFile(path, 'download');
  let now = 0;
  const manager = new DownloadManager({ auditPath: null, allowedRoots: [root], ttlMs: 100, clock: () => now });
  t.after(() => manager.closeAll());
  const opened = await manager.open({ path, confirmed: true }, 'client');
  const session = manager.sessions.get(opened.downloadId)!;
  session.busy = true;
  now = 101;
  await manager.open({ path, confirmed: true }, 'other-client');
  assert.equal(manager.sessions.has(opened.downloadId), true);
  assert.ok(session.handle);
  session.busy = false;
  await assert.rejects(manager.read({ ...opened, offset: 0 }, 'client'), /download_capability_invalid/);
});

test('a file changed during the final chunk cannot complete successfully', async t => {
  const root = await mkdtemp(join(tmpdir(), 'download-final-chunk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file.bin');
  await writeFile(path, 'before');
  const manager = new DownloadManager({ auditPath: null, allowedRoots: [root] });
  t.after(() => manager.closeAll());
  const opened = await manager.open({ path, confirmed: true }, 'client');
  const handle = manager.sessions.get(opened.downloadId)!.handle!;
  const read = handle.read.bind(handle);
  handle.read = (async (...args: Parameters<typeof handle.read>) => {
    const result = await read(...args);
    await writeFile(path, 'after and longer');
    return result;
  }) as typeof handle.read;
  await assert.rejects(manager.read({ ...opened, offset: 0 }, 'client'), /download_file_changed/);
  assert.equal(manager.sessions.size, 0);
});
