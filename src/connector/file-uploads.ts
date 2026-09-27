import { createHash, randomUUID, type Hash } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, safeUploadName } from '../shared/file-upload.js';
import { cleanupAttachments } from './attachments.js';

export const UPLOAD_DIRECTORY = join(tmpdir(), 'personal-codex-bridge', 'files');
const UPLOAD_TTL_MS = 30 * 60_000;
const FILE_TTL_MS = 24 * 60 * 60_000;
type Upload = {
  owner: string; path: string; name: string; size: number; offset: number;
  hash: Hash; touchedAt: number; busy: boolean;
};
type Payload = Record<string, unknown>;

export class FileUploadManager {
  private readonly uploads = new Map<string, Upload>();
  readonly directory: string;
  constructor(options: { directory?: string; now?: () => number } = {}) {
    this.directory = resolve(options.directory || UPLOAD_DIRECTORY);
    this.now = options.now || Date.now;
  }
  private readonly now: () => number;

  async begin(payload: Payload, owner = '') {
    if (!owner) throw new Error('file_upload_owner_required');
    const size = payload.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES) {
      throw new Error('file_upload_too_large');
    }
    for (const [id, upload] of this.uploads) {
      if (!upload.busy && this.now() - upload.touchedAt >= UPLOAD_TTL_MS) {
        this.uploads.delete(id);
        await unlink(upload.path).catch(() => {});
      }
    }
    if (this.uploads.size >= 4 || [...this.uploads.values()].filter((u) => u.owner === owner).length >= 2) {
      throw new Error('file_upload_limit');
    }
    const uploadId = randomUUID();
    const upload: Upload = {
      owner, name: safeUploadName(payload.name), size, offset: 0,
      path: join(this.directory, `${uploadId}.part`), hash: createHash('sha256'),
      touchedAt: this.now(), busy: true,
    };
    // Reserve the slot before any asynchronous filesystem operation.
    this.uploads.set(uploadId, upload);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stats = await lstat(this.directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('attachment_directory_invalid');
      await cleanupAttachments(this.directory, this.now(), FILE_TTL_MS).catch((error: NodeJS.ErrnoException) => {
        // Another upload can finish or cancel between the cleanup scan and stat.
        if (error.code !== 'ENOENT') throw error;
      });
      await writeFile(upload.path, '', { flag: 'wx', mode: 0o600 });
      upload.busy = false;
      return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES };
    } catch (error) {
      this.uploads.delete(uploadId);
      throw error;
    }
  }

  private get(payload: Payload, owner: string) {
    const upload = this.uploads.get(String(payload.uploadId || ''));
    if (!owner || !upload || upload.owner !== owner) throw new Error('file_upload_not_found');
    if (upload.busy) throw new Error('file_upload_busy');
    if (this.now() - upload.touchedAt >= UPLOAD_TTL_MS) throw new Error('file_upload_expired');
    return upload;
  }

  async chunk(payload: Payload, owner = '') {
    const upload = this.get(payload, owner);
    if (payload.offset !== upload.offset) throw new Error('file_upload_offset_mismatch');
    const data = typeof payload.data === 'string' ? payload.data : '';
    if (!data || data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4
      || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('attachment_invalid_base64');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.length > UPLOAD_CHUNK_BYTES
      || upload.offset + bytes.length > upload.size) throw new Error('attachment_size_mismatch');
    upload.busy = true;
    try {
      const stats = await lstat(upload.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== upload.offset) throw new Error('file_upload_changed');
      const handle = await open(upload.path, 'r+');
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, upload.offset + written);
          if (!result.bytesWritten) throw new Error('file_upload_write_failed');
          written += result.bytesWritten;
        }
      } finally { await handle.close(); }
      upload.hash.update(bytes);
      upload.offset += bytes.length;
      upload.touchedAt = this.now();
      return { nextOffset: upload.offset };
    } catch (error) {
      this.uploads.delete(String(payload.uploadId));
      await unlink(upload.path).catch(() => {});
      throw error;
    } finally { upload.busy = false; }
  }

  async complete(payload: Payload, owner = '') {
    const upload = this.get(payload, owner);
    if (upload.offset !== upload.size) throw new Error('attachment_size_mismatch');
    upload.busy = true;
    try {
      const stats = await lstat(upload.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== upload.size) throw new Error('file_upload_changed');
      const path = join(this.directory, `${randomUUID()}-${upload.name}`);
      await rename(upload.path, path);
      this.uploads.delete(String(payload.uploadId));
      return { path, name: upload.name, size: upload.size, sha256: upload.hash.digest('hex') };
    } finally { upload.busy = false; }
  }

  async cancel(payload: Payload, owner = '') {
    const id = String(payload.uploadId || '');
    const upload = this.uploads.get(id);
    if (!upload) return { cancelled: true };
    if (!owner || upload.owner !== owner) throw new Error('file_upload_not_found');
    if (upload.busy) throw new Error('file_upload_busy');
    this.uploads.delete(id);
    await unlink(upload.path).catch(() => {});
    return { cancelled: true };
  }
}
