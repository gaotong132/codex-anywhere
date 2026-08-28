import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupAttachments, readImageAttachment, saveImageAttachment } from '../src/connector/attachments.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('image upload validates content and writes it to the attachment directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-attachment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await saveImageAttachment({
    name: 'screen/shot.png',
    mimeType: 'image/png',
    size: ONE_PIXEL_PNG.length,
    data: ONE_PIXEL_PNG.toString('base64'),
  }, { directory });

  assert.equal(result.name, 'screen_shot.png');
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(await readFile(result.path), ONE_PIXEL_PNG);
});

test('image upload rejects a MIME type that does not match the bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-attachment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => saveImageAttachment({
    name: 'fake.jpg',
    mimeType: 'image/jpeg',
    size: ONE_PIXEL_PNG.length,
    data: ONE_PIXEL_PNG.toString('base64'),
  }, { directory }), /attachment_content_mismatch/);
});

test('image read returns only a validated preview from the managed directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-attachment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uploaded = await saveImageAttachment({
    name: 'phone.png',
    mimeType: 'image/png',
    size: ONE_PIXEL_PNG.length,
    data: ONE_PIXEL_PNG.toString('base64'),
    preview: {
      mimeType: 'image/png',
      size: ONE_PIXEL_PNG.length,
      data: ONE_PIXEL_PNG.toString('base64'),
    },
  }, { directory });

  const result = await readImageAttachment({ path: uploaded.path }, { directory });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.data, ONE_PIXEL_PNG.toString('base64'));
  await assert.rejects(
    () => readImageAttachment({ path: join(directory, '..', 'outside.png') }, { directory }),
    /attachment_path_not_allowed/,
  );
});

test('image read does not send a full-size original when no preview exists', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-attachment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uploaded = await saveImageAttachment({
    name: 'legacy.png',
    mimeType: 'image/png',
    size: ONE_PIXEL_PNG.length,
    data: ONE_PIXEL_PNG.toString('base64'),
  }, { directory });

  await assert.rejects(
    () => readImageAttachment({ path: uploaded.path }, { directory }),
    /attachment_preview_not_found/,
  );
});

test('image read prefers the stored lightweight preview', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-attachment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = Buffer.concat([ONE_PIXEL_PNG, Buffer.from([0])]);
  const uploaded = await saveImageAttachment({
    name: 'large.png',
    mimeType: 'image/png',
    size: original.length,
    data: original.toString('base64'),
    preview: {
      mimeType: 'image/png',
      size: ONE_PIXEL_PNG.length,
      data: ONE_PIXEL_PNG.toString('base64'),
    },
  }, { directory });

  assert.equal(uploaded.hasPreview, true);
  assert.deepEqual(await readFile(uploaded.path), original);
  const result = await readImageAttachment({ path: uploaded.path }, { directory });
  assert.equal(result.size, ONE_PIXEL_PNG.length);
  assert.equal(result.data, ONE_PIXEL_PNG.toString('base64'));
});

test('attachment cleanup deletes only expired regular files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-attachment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expired = join(directory, 'expired.png');
  const current = join(directory, 'current.png');
  const nested = join(directory, 'nested');
  await writeFile(expired, ONE_PIXEL_PNG);
  await writeFile(current, ONE_PIXEL_PNG);
  await mkdir(nested);
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1000);
  const { utimes } = await import('node:fs/promises');
  await utimes(expired, old, old);

  await cleanupAttachments(directory, now, 24 * 60 * 60 * 1000);

  await assert.rejects(() => stat(expired), /ENOENT/);
  assert.equal((await stat(current)).isFile(), true);
  assert.equal((await stat(nested)).isDirectory(), true);
});
