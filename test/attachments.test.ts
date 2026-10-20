import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { cleanupAttachments, readImageAttachment, saveImageAttachment, resolveNativeImageAttachment } from '../src/connector/attachments.js';
import { MAX_VISUALIZATION_BYTES, readVisualization } from '../src/connector/visualizations.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('native image input accepts validated originals but rejects arbitrary paths, preview files and replaced content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = await saveImageAttachment({ name: 'test.png', mimeType: 'image/png', size: ONE_PIXEL_PNG.length, data: ONE_PIXEL_PNG.toString('base64') }, { directory });
  assert.equal(await resolveNativeImageAttachment(image, { directory }), image.path);
  await assert.rejects(resolveNativeImageAttachment({ path: join(directory, '..', 'secret.png') }, { directory }), /attachment_path_not_allowed/);
  await assert.rejects(resolveNativeImageAttachment({ path: image.path + '.preview' }, { directory }), /attachment_path_not_allowed/);
  await writeFile(image.path, 'This is not an image');
  await assert.rejects(resolveNativeImageAttachment(image, { directory }), /attachment_content_mismatch/);
});

test('same-size image replacement with preserved mtime invalidates preview cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-image-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'preview.png');
  const replacement = join(directory, 'replacement.png');
  const red = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
  const length = Math.max(red.length, blue.length);
  const pad = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(length - bytes.length)]);
  const time = new Date('2026-01-01T00:00:00Z');
  await writeFile(path, pad(red));
  await utimes(path, time, time);
  const before = await readImageAttachment({ path, source: 'local' }, { localAllowedRoots: [directory] });
  await writeFile(replacement, pad(blue));
  await utimes(replacement, time, time);
  await rename(replacement, path);
  const after = await readImageAttachment({ path, source: 'local' }, { localAllowedRoots: [directory] });
  assert.notEqual(after.data, before.data);
});

test('visualizations preserve the UTF-8 byte count and reject invalid encoding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-visualization-encoding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'view.html');
  await writeFile(path, '\uFEFF<main>中文🙂</main>');
  const preview = await readVisualization({ path }, { directory });
  assert.equal(Buffer.byteLength(preview.content), preview.size);
  await writeFile(path, Buffer.from([0xff]));
  await assert.rejects(readVisualization({ path }, { directory }), /visualization_encoding_invalid/);
});

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

test('generated image read returns a lightweight preview only from the Codex image directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-generated-image-test-'));
  const threadDirectory = join(directory, 'thread-1');
  await mkdir(threadDirectory);
  const generated = join(threadDirectory, 'result.png');
  const outside = join(tmpdir(), `outside-${Date.now()}.png`);
  await writeFile(generated, ONE_PIXEL_PNG);
  await writeFile(outside, ONE_PIXEL_PNG);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  const result = await readImageAttachment({
    path: generated, source: 'generated',
  }, { generatedDirectory: directory });
  assert.equal(result.mimeType, 'image/webp');
  assert.ok(result.size > 0);
  assert.ok(result.data.length > 0);
  await assert.rejects(
    () => readImageAttachment({ path: outside, source: 'generated' }, { generatedDirectory: directory }),
    /generated_image_path_not_allowed/,
  );
});

test('local Markdown images render only from configured project roots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-local-image-test-'));
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'bridge-local-image-outside-'));
  const localImage = join(directory, 'diagram.png');
  const fakeImage = join(directory, 'not-an-image.png');
  const outsideImage = join(outsideDirectory, 'outside.png');
  await writeFile(localImage, ONE_PIXEL_PNG);
  await writeFile(fakeImage, 'not an image');
  await writeFile(outsideImage, ONE_PIXEL_PNG);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  });

  const result = await readImageAttachment({
    path: localImage, source: 'local',
  }, { localAllowedRoots: [directory] });
  assert.equal(result.mimeType, 'image/webp');
  assert.ok(result.data.length > 0);
  await assert.rejects(
    () => readImageAttachment({ path: outsideImage, source: 'local' }, { localAllowedRoots: [directory] }),
    /local_image_path_not_allowed/,
  );
  await assert.rejects(
    () => readImageAttachment({ path: fakeImage, source: 'local' }, { localAllowedRoots: [directory] }),
    /local_image_content_mismatch/,
  );
});

test('interactive visualizations load only bounded HTML from the Codex visualization directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-visualization-test-'));
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'bridge-visualization-outside-'));
  const visualization = join(directory, 'concept.html');
  const renderedPreview = join(directory, 'concept-preview.html');
  const wrongType = join(directory, 'concept.svg');
  const tooLarge = join(directory, 'too-large.html');
  const outside = join(outsideDirectory, 'outside.html');
  await writeFile(visualization, '<main>Safe concept</main><script>document.body.dataset.ready="1"</script>');
  await writeFile(wrongType, '<svg />');
  await writeFile(tooLarge, Buffer.alloc(MAX_VISUALIZATION_BYTES + 1));
  await writeFile(outside, '<main>outside</main>');
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  });

  const result = await readVisualization({ path: visualization }, { directory });
  assert.equal(result.name, 'concept.html');
  assert.match(result.content, /Safe concept/);
  await writeFile(renderedPreview, '<!doctype html><main>Rendered concept shell</main>');
  const preferred = await readVisualization({ path: visualization }, { directory });
  assert.equal(preferred.name, 'concept.html');
  assert.match(preferred.content, /Rendered concept shell/);
  await assert.rejects(() => readVisualization({ path: wrongType }, { directory }), /visualization_path_invalid/);
  await assert.rejects(() => readVisualization({ path: tooLarge }, { directory }), /visualization_too_large/);
  await assert.rejects(() => readVisualization({ path: outside }, { directory }), /visualization_path_not_allowed/);
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

test('concurrent attachment cleanup tolerates files removed by another upload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-cleanup-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (let i = 0; i < 30; i++) {
    const path = join(directory, `${i}.png`);
    await writeFile(path, ONE_PIXEL_PNG);
    await utimes(path, old, old);
  }
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => cleanupAttachments(directory)));
  assert.deepEqual(results.map(result => result.status), Array(4).fill('fulfilled'),
    JSON.stringify(results.filter(result => result.status === 'rejected')));
  // Cleanup must finish scanning, rather than swallowing the first missing file.
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(directory), []);
});

test('a failed cleanup does not poison the next scan of the directory', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'bridge-cleanup-retry-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'attachments');
  await assert.rejects(cleanupAttachments(directory), /ENOENT/);
  await mkdir(directory);
  await cleanupAttachments(directory);
});
