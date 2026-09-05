import type { DownloadFileChunk, OpenedDownload } from './app-types';
import { decodeBase64Chunk } from './file-utils';

export function validateDownloadCapability(value: OpenedDownload) {
  if (!value || typeof value.downloadId !== 'string' || !value.downloadId
    || typeof value.downloadToken !== 'string' || !value.downloadToken
    || typeof value.name !== 'string' || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error('download_capability_invalid');
  }
  return value;
}

export function decodeDownloadChunk(chunk: DownloadFileChunk, offset: number, size: number) {
  if (!chunk || chunk.offset !== offset || !Number.isSafeInteger(chunk.nextOffset)
    || typeof chunk.done !== 'boolean' || typeof chunk.data !== 'string'
    || chunk.nextOffset > size || chunk.nextOffset < offset
    || (chunk.nextOffset === offset && !(size === 0 && offset === 0 && chunk.done))
    || chunk.done !== (chunk.nextOffset === size)) throw new Error('download_chunk_invalid');
  const bytes = size === 0 && chunk.data === '' ? new Uint8Array() : decodeBase64Chunk(chunk.data);
  if (bytes.byteLength !== chunk.nextOffset - offset) throw new Error('download_chunk_invalid');
  return bytes;
}
