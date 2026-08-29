import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename, dirname, extname, isAbsolute, join, resolve,
} from 'node:path';
import { isPathWithinRoot } from './path-policy.js';

export const MAX_VISUALIZATION_BYTES = 2 * 1024 * 1024;

type VisualizationPayload = { path?: unknown };
type VisualizationOptions = { directory?: string; maxBytes?: number };

export function visualizationsDirectory() {
  const codexDirectory = String(process.env.CODEX_HOME || '').trim() || join(homedir(), '.codex');
  return resolve(codexDirectory, 'visualizations');
}

export async function readVisualization(
  payload: VisualizationPayload,
  options: VisualizationOptions = {},
) {
  const requested = String(payload?.path || '').trim();
  if (!requested || requested.includes('\0') || !isAbsolute(requested) || !/\.html?$/i.test(requested)) {
    throw new Error('visualization_path_invalid');
  }
  const configuredRoot = resolve(options.directory || visualizationsDirectory());
  const root = await realpath(configuredRoot).catch(() => configuredRoot);
  const path = await realpath(resolve(requested)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('visualization_not_found');
    throw error;
  });
  if (!isPathWithinRoot(path, root)) {
    throw new Error('visualization_path_not_allowed');
  }

  const maxBytes = Number.isSafeInteger(options.maxBytes) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes) : MAX_VISUALIZATION_BYTES;
  const extension = extname(path);
  const previewCandidate = /-preview\.html?$/i.test(path)
    ? ''
    : join(dirname(path), `${basename(path, extension)}-preview${extension}`);
  if (previewCandidate) {
    const previewPath = await realpath(previewCandidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    if (previewPath && isPathWithinRoot(previewPath, root)) {
      const preview = await readVisualizationFile(previewPath, maxBytes, true);
      if (preview) return { name: basename(path), ...preview };
    }
  }

  const visualization = await readVisualizationFile(path, maxBytes);
  return { name: basename(path), ...visualization };
}

async function readVisualizationFile(path: string, maxBytes: number, optional = false) {
  const handle = await open(path, 'r').catch((error) => {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('visualization_not_found');
    throw error;
  });
  if (!handle) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      if (optional) return null;
      throw new Error('visualization_not_a_file');
    }
    if (stats.size > maxBytes) {
      if (optional) return null;
      throw new Error('visualization_too_large');
    }
    const content = await handle.readFile('utf8');
    if (content.includes('\0')) throw new Error('visualization_content_invalid');
    return { size: stats.size, content };
  } finally {
    await handle.close();
  }
}
