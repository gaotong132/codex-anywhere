import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const pending = new Map<string, Promise<void>>();

/** Serialize per directory: Windows can report EPERM for concurrent unlink. */
export function cleanupAttachments(directory: string, now = Date.now(), maxAgeMs = ATTACHMENT_MAX_AGE_MS) {
  const root = resolve(directory);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const cleanup = (pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const path = resolve(root, entry.name);
      if (dirname(path) !== root) continue;
      try {
        const stats = await lstat(path);
        if (!stats.isFile() || stats.isSymbolicLink() || now - stats.mtimeMs <= maxAgeMs) continue;
        await unlink(path);
      } catch (error) {
        // Another process may have removed an entry. Continue the scan, while
        // preserving permission and I/O failures for the caller.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }).finally(() => {
    if (pending.get(key) === cleanup) pending.delete(key);
  });
  pending.set(key, cleanup);
  return cleanup;
}
