import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename, isAbsolute, join, relative, resolve,
} from 'node:path';

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
  const pathFromRoot = relative(root, path);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('visualization_path_not_allowed');
  }

  const handle = await open(path, 'r').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('visualization_not_found');
    throw error;
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('visualization_not_a_file');
    const maxBytes = Number.isSafeInteger(options.maxBytes) && Number(options.maxBytes) > 0
      ? Number(options.maxBytes) : MAX_VISUALIZATION_BYTES;
    if (stats.size > maxBytes) throw new Error('visualization_too_large');
    const content = await handle.readFile('utf8');
    if (content.includes('\0')) throw new Error('visualization_content_invalid');
    return { name: basename(path), size: stats.size, content };
  } finally {
    await handle.close();
  }
}
