import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type FileSnapshot = ReturnType<typeof fileSnapshot>;

export function fileSnapshot(stats: Stats) {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs,
    dev: String(stats.dev), ino: String(stats.ino) };
}

export function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev && left.ino === right.ino;
}

/** Allocate only the checked size; never follow a growing file to EOF. */
export async function readBoundedFile(handle: FileHandle, maxBytes: number, errorPrefix: string, stats?: Stats) {
  const initial = stats || await handle.stat();
  if (!initial.isFile()) throw new Error(`${errorPrefix}_not_a_file`);
  if (!Number.isSafeInteger(initial.size) || initial.size < 0 || initial.size > maxBytes) {
    throw new Error(`${errorPrefix}_too_large`);
  }
  const bytes = Buffer.alloc(initial.size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  if (offset !== bytes.length || !sameFileSnapshot(fileSnapshot(initial), fileSnapshot(await handle.stat()))) {
    throw new Error(`${errorPrefix}_file_changed`);
  }
  return bytes;
}

export function decodePreviewText(bytes: Buffer, errorPrefix: string) {
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${errorPrefix}_encoding_invalid`); }
  if (content.includes('\0')) throw new Error(`${errorPrefix}_content_invalid`);
  return content;
}
