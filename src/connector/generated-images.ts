import { homedir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';
import { internals as imagePreviewInternals, readRasterImagePreview } from './image-previews.js';

export type GeneratedImageAttachment = {
  path: string;
  name: string;
  source: 'generated';
};

type GeneratedImagePayload = { path?: unknown; source?: unknown };
type GeneratedImageOptions = { directory?: string };
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
  const root = resolve(options.directory || generatedImagesDirectory());
  return readRasterImagePreview({
    path: payload?.path,
    allowedRoots: [root],
    errorPrefix: 'generated_image',
  });
}

function imageFileName(path: string) {
  return (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') ? win32.basename(path) : basename(path))
    || 'generated-image.png';
}

export const internals = imagePreviewInternals;
