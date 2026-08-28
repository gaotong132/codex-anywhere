import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 512 * 1024;
export const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ATTACHMENT_DIRECTORY = join(tmpdir(), 'personal-codex-bridge', 'attachments');

const IMAGE_TYPES = new Map([
  ['image/jpeg', { extension: '.jpg', matches: isJpeg }],
  ['image/png', { extension: '.png', matches: isPng }],
  ['image/webp', { extension: '.webp', matches: isWebp }],
]);

export async function saveImageAttachment(payload, options = {}) {
  const original = decodeImagePayload(payload, MAX_IMAGE_BYTES);
  const preview = payload?.preview ? decodeImagePayload(payload.preview, MAX_PREVIEW_BYTES) : null;

  const directory = resolve(options.directory || DEFAULT_ATTACHMENT_DIRECTORY);
  await ensureSafeDirectory(directory);
  await cleanupAttachments(directory, options.now || Date.now(), options.maxAgeMs || ATTACHMENT_MAX_AGE_MS);

  const path = join(directory, `${randomUUID()}${original.imageType.extension}`);
  if (dirname(resolve(path)) !== directory) throw new Error('attachment_path_invalid');
  await writeFile(path, original.bytes, { flag: 'wx', mode: 0o600 });
  if (preview) {
    try {
      await writeFile(previewPath(path), preview.bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
  }
  return {
    path,
    name: safeDisplayName(payload?.name, original.imageType.extension),
    mimeType: original.mimeType,
    size: original.bytes.length,
    hasPreview: Boolean(preview),
  };
}

export async function readImageAttachment(payload, options = {}) {
  const directory = resolve(options.directory || DEFAULT_ATTACHMENT_DIRECTORY);
  await ensureSafeDirectory(directory);
  const path = resolve(String(payload?.path || ''));
  if (dirname(path) !== directory) throw new Error('attachment_path_not_allowed');

  const candidate = await readablePreviewPath(path);
  if (!candidate) throw new Error('attachment_preview_not_found');
  const stats = await lstat(candidate).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error('attachment_not_found');
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_IMAGE_BYTES) {
    throw new Error('attachment_not_found');
  }
  const bytes = await readFile(candidate);
  const detected = detectImageType(bytes);
  if (!detected) throw new Error('attachment_content_mismatch');
  return {
    path,
    mimeType: detected.mimeType,
    size: bytes.length,
    data: bytes.toString('base64'),
  };
}

function decodeImagePayload(payload, maxBytes) {
  const mimeType = String(payload?.mimeType || '').trim().toLocaleLowerCase();
  const imageType = IMAGE_TYPES.get(mimeType);
  if (!imageType) throw new Error('attachment_type_not_allowed');

  const encoded = String(payload?.data || '').trim();
  if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error('attachment_too_large');
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('attachment_invalid_base64');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('attachment_too_large');
  if (Number(payload?.size) !== bytes.length) throw new Error('attachment_size_mismatch');
  if (!imageType.matches(bytes)) throw new Error('attachment_content_mismatch');
  return { bytes, imageType, mimeType };
}

function previewPath(path) {
  return `${path}.preview`;
}

async function readablePreviewPath(path) {
  const candidate = previewPath(path);
  const stats = await lstat(candidate).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats || !stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_PREVIEW_BYTES) {
    return null;
  }
  return candidate;
}

export async function cleanupAttachments(directory, now = Date.now(), maxAgeMs = ATTACHMENT_MAX_AGE_MS) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name);
    if (dirname(path) !== root) continue;
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || now - stats.mtimeMs <= maxAgeMs) continue;
    await unlink(path);
  }
}

async function ensureSafeDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('attachment_directory_invalid');
}

function safeDisplayName(value, extension) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || `image${extension}`;
}

function detectImageType(bytes) {
  for (const [mimeType, imageType] of IMAGE_TYPES) {
    if (imageType.matches(bytes)) return { mimeType, ...imageType };
  }
  return null;
}

function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isWebp(bytes) {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}
