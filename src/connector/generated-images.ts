import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename, isAbsolute, join, relative, resolve, win32,
} from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { LRUCache } from 'lru-cache';
import sharp from 'sharp';

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
const FILE_TYPE_SAMPLE_BYTES = 4_100;
const GENERATED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type GeneratedImageAttachment = {
  path: string;
  name: string;
  source: 'generated';
};

type GeneratedImagePayload = { path?: unknown; source?: unknown };
type GeneratedImageOptions = { directory?: string };
type CachedPreview = { mimeType: string; size: number; data: string };

const previewCache = new LRUCache<string, CachedPreview>({
  maxSize: PREVIEW_CACHE_BYTES,
  sizeCalculation: (value) => value.data.length,
});

export function generatedImagesDirectory() {
  const codexDirectory = String(process.env.CODEX_HOME || '').trim() || join(homedir(), '.codex');
  return resolve(codexDirectory, 'generated_images');
}

export function extractGeneratedImageAttachment(value: Record<string, any>): GeneratedImageAttachment | undefined {
  const type = String(value?.type || '');
  if (!/image.?generation|generated.?image/i.test(type)) return undefined;
  const path = [
    value.saved_path,
    value.savedPath,
    value.path,
    value.result?.saved_path,
    value.result?.savedPath,
    value.result?.path,
  ].map((candidate) => String(candidate || '').trim()).find(Boolean) || '';
  if (!path || !/\.(?:jpe?g|png|webp)$/i.test(path)) return undefined;
  return { path, name: imageFileName(path), source: 'generated' };
}

export async function readGeneratedImagePreview(
  payload: GeneratedImagePayload,
  options: GeneratedImageOptions = {},
) {
  const requestedPath = resolve(String(payload?.path || ''));
  const root = resolve(options.directory || generatedImagesDirectory());
  const [canonicalRoot, candidateStats] = await Promise.all([
    realpath(root).catch(() => root),
    lstat(requestedPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('generated_image_not_found');
      throw error;
    }),
  ]);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()
    || candidateStats.size <= 0 || candidateStats.size > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('generated_image_not_found');
  }
  const path = await realpath(requestedPath);
  if (!pathWithinRoot(path, canonicalRoot)) throw new Error('generated_image_path_not_allowed');

  const cacheKey = `${path}\0${candidateStats.size}\0${candidateStats.mtimeMs}`;
  const cached = previewCache.get(cacheKey);
  if (cached) return { path: requestedPath, ...cached };

  const original = await readFile(path);
  const detected = await fileTypeFromBuffer(original.subarray(0, FILE_TYPE_SAMPLE_BYTES));
  if (!detected || !GENERATED_IMAGE_TYPES.has(detected.mime)) {
    throw new Error('generated_image_content_mismatch');
  }
  let preview = await makePreview(original, 720, 72);
  if (preview.length > MAX_PREVIEW_BYTES) preview = await makePreview(original, 480, 58);
  if (!preview.length || preview.length > MAX_PREVIEW_BYTES) throw new Error('generated_image_preview_too_large');

  const result = { mimeType: 'image/webp', size: preview.length, data: preview.toString('base64') };
  previewCache.set(cacheKey, result);
  return { path: requestedPath, ...result };
}

function makePreview(bytes: Buffer, maxDimension: number, quality: number) {
  return sharp(bytes, { animated: false })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
}

function pathWithinRoot(path: string, root: string) {
  const difference = relative(root, path);
  return difference === ''
    || (difference !== '..' && !difference.startsWith(`..${win32.sep}`)
      && !difference.startsWith('../') && !isAbsolute(difference));
}

function imageFileName(path: string) {
  return (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') ? win32.basename(path) : basename(path))
    || 'generated-image.png';
}

export const internals = { pathWithinRoot, previewCache };
