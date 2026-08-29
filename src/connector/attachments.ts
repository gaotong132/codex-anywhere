import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { readGeneratedImagePreview } from './generated-images.js';
import { readRasterImagePreview } from './image-previews.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ATTACHMENT_DIRECTORY = join(tmpdir(), 'personal-codex-bridge', 'attachments');

const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
const FILE_TYPE_SAMPLE_BYTES = 4_100;

type ImagePayload = {
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  data?: unknown;
  path?: unknown;
  source?: unknown;
  preview?: ImagePayload;
};

type AttachmentOptions = {
  directory?: string;
  generatedDirectory?: string;
  localAllowedRoots?: string[];
  now?: number;
  maxAgeMs?: number;
};

export async function saveImageAttachment(payload: ImagePayload, options: AttachmentOptions = {}) {
  const original = await decodeImagePayload(payload, MAX_IMAGE_BYTES);
  const preview = payload?.preview ? await decodeImagePayload(payload.preview, MAX_PREVIEW_BYTES) : null;

  const directory = resolve(options.directory || DEFAULT_ATTACHMENT_DIRECTORY);
  await ensureSafeDirectory(directory);
  await cleanupAttachments(directory, options.now || Date.now(), options.maxAgeMs || ATTACHMENT_MAX_AGE_MS);

  const path = join(directory, `${randomUUID()}${original.extension}`);
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
    name: safeDisplayName(payload?.name, original.extension),
    mimeType: original.mimeType,
    size: original.bytes.length,
    hasPreview: Boolean(preview),
  };
}

export async function readImageAttachment(payload: ImagePayload, options: AttachmentOptions = {}) {
  if (payload?.source === 'generated') {
    return readGeneratedImagePreview(payload, { directory: options.generatedDirectory });
  }
  if (payload?.source === 'local') {
    return readRasterImagePreview({
      path: payload.path,
      allowedRoots: options.localAllowedRoots || [],
      errorPrefix: 'local_image',
    });
  }
  const directory = resolve(options.directory || DEFAULT_ATTACHMENT_DIRECTORY);
  await ensureSafeDirectory(directory);
  const path = resolve(String(payload?.path || ''));
  if (dirname(path) !== directory) throw new Error('attachment_path_not_allowed');

  const candidate = await readablePreviewPath(path);
  if (!candidate) throw new Error('attachment_preview_not_found');
  const stats = await lstat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('attachment_not_found');
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_IMAGE_BYTES) {
    throw new Error('attachment_not_found');
  }
  const bytes = await readFile(candidate);
  const detected = await detectImageType(bytes);
  if (!detected) throw new Error('attachment_content_mismatch');
  return {
    path,
    mimeType: detected.mimeType,
    size: bytes.length,
    data: bytes.toString('base64'),
  };
}

async function decodeImagePayload(payload: ImagePayload, maxBytes: number) {
  const mimeType = String(payload?.mimeType || '').trim().toLocaleLowerCase();
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error('attachment_type_not_allowed');

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
  const detected = await detectImageType(bytes);
  if (detected?.mimeType !== mimeType) throw new Error('attachment_content_mismatch');
  return { bytes, extension, mimeType };
}

function previewPath(path: string) {
  return `${path}.preview`;
}

async function readablePreviewPath(path: string) {
  const candidate = previewPath(path);
  const stats = await lstat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats || !stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_PREVIEW_BYTES) {
    return null;
  }
  return candidate;
}

export async function cleanupAttachments(directory: string, now = Date.now(), maxAgeMs = ATTACHMENT_MAX_AGE_MS) {
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

async function ensureSafeDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('attachment_directory_invalid');
}

function safeDisplayName(value: unknown, extension: string) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || `image${extension}`;
}

async function detectImageType(bytes: Buffer) {
  const detected = await fileTypeFromBuffer(bytes.subarray(0, FILE_TYPE_SAMPLE_BYTES));
  const extension = detected && IMAGE_EXTENSIONS.get(detected.mime);
  return extension ? { mimeType: detected.mime, extension } : null;
}
