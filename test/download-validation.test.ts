import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDownloadChunk, validateDownloadCapability } from '../web/src/download-validation.js';
import { validateTextPreview, validPreviewText } from '../web/src/file-preview-client.js';

test('empty downloads complete, while premature completion and incorrect offsets are rejected', () => {
  assert.equal(decodeDownloadChunk({ offset: 0, nextOffset: 0, done: true, data: '' }, 0, 0).byteLength, 0);
  const chunk = { offset: 0, nextOffset: 3, done: true, data: 'YWJj' };
  assert.equal(new TextDecoder().decode(decodeDownloadChunk(chunk, 0, 3)), 'abc');
  assert.throws(() => decodeDownloadChunk(chunk, 0, 6), /download_chunk_invalid/);
  assert.throws(() => decodeDownloadChunk({ ...chunk, done: false }, 0, 3), /download_chunk_invalid/);
  assert.throws(() => decodeDownloadChunk({ ...chunk, nextOffset: 2 }, 0, 2), /download_chunk_invalid/);
  assert.throws(() => decodeDownloadChunk(chunk, 1, 3), /download_chunk_invalid/);
  assert.throws(() => decodeDownloadChunk({ ...chunk, done: 'true' as unknown as boolean }, 0, 3), /download_chunk_invalid/);
  assert.throws(() => decodeDownloadChunk({ offset: 0, nextOffset: 0, done: false, data: '' }, 0, 3), /download_chunk_invalid/);
});

test('download capabilities and preview sizes are checked before consuming their content', () => {
  const capability = { downloadId: 'id', downloadToken: 'token', name: 'empty', size: 0 };
  assert.equal(validateDownloadCapability(capability), capability);
  assert.throws(() => validateDownloadCapability({ ...capability, size: -1 }), /download_capability_invalid/);
  assert.throws(() => validateDownloadCapability({ ...capability, downloadToken: '' }), /download_capability_invalid/);
  assert.equal(validPreviewText('中文', 6, 6), true);
  assert.equal(validPreviewText('中文', 2, 6), false);
  assert.equal(validPreviewText('中文', 6, 5), false);
  assert.equal(validPreviewText('bad\0', 4, 100), false);
  const document = { name: 'note.txt', size: 6, content: '中文', kind: 'text' as const, language: 'plaintext' };
  assert.equal(validateTextPreview(document), document);
  assert.throws(() => validateTextPreview({ ...document, size: 2 }), /text_preview_content_invalid/);
});
