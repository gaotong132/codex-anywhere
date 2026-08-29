import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { LRUCache } from 'lru-cache';
import sharp from 'sharp';
import { isPathWithinRoot } from './path-policy.js';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
const FILE_TYPE_SAMPLE_BYTES = 4_100;
const RASTER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type CachedPreview = { mimeType: string; size: number; data: string };

const previewCache = new LRUCache<string, CachedPreview>({
  maxSize: PREVIEW_CACHE_BYTES,
  sizeCalculation: (value) => value.data.length,
});

export async function readRasterImagePreview({
  path: requestedValue,
  allowedRoots,
  errorPrefix,
}: {
  path: unknown;
  allowedRoots: string[];
  errorPrefix: string;
}) {
  const requestedPath = resolve(String(requestedValue || ''));
  const candidateStats = await lstat(requestedPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${errorPrefix}_not_found`);
    throw error;
  });
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()
    || candidateStats.size <= 0 || candidateStats.size > MAX_IMAGE_BYTES) {
    throw new Error(`${errorPrefix}_not_found`);
  }

  const path = await realpath(requestedPath);
  const roots = await Promise.all(allowedRoots.map(async (root) => realpath(resolve(root)).catch(() => resolve(root))));
  if (!roots.some((root) => isPathWithinRoot(path, root))) {
    throw new Error(`${errorPrefix}_path_not_allowed`);
  }

  const cacheKey = `${path}\0${candidateStats.size}\0${candidateStats.mtimeMs}`;
  const cached = previewCache.get(cacheKey);
  if (cached) return { path: requestedPath, ...cached };

  const original = await readFile(path);
  const detected = await fileTypeFromBuffer(original.subarray(0, FILE_TYPE_SAMPLE_BYTES));
  if (!detected || !RASTER_IMAGE_TYPES.has(detected.mime)) {
    throw new Error(`${errorPrefix}_content_mismatch`);
  }
  let preview = await makePreview(original, 720, 72);
  if (preview.length > MAX_PREVIEW_BYTES) preview = await makePreview(original, 480, 58);
  if (!preview.length || preview.length > MAX_PREVIEW_BYTES) {
    throw new Error(`${errorPrefix}_preview_too_large`);
  }

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
