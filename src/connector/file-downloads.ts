import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename, dirname, isAbsolute, join, resolve, win32,
} from 'node:path';
import { secretMatches } from '../shared/protocol.js';
import { isPathWithinRoot } from './path-policy.js';

export const DOWNLOAD_CHUNK_BYTES = 384 * 1024;
const DOWNLOAD_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_CHUNKS_PER_WINDOW = 200;
const MAX_AUDIT_BYTES = 1024 * 1024;

type DownloadPayload = Record<string, any>;
type DownloadManagerOptions = {
  clock?: () => number;
  ttlMs?: number;
  rateWindowMs?: number;
  maxChunksPerWindow?: number;
  auditPath?: string | null;
  allowedRoots?: unknown[];
  allowAnyFileDownload?: boolean;
};
type FileSnapshot = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: string;
  ino: string;
};
type DownloadSession = {
  id: string;
  token: string;
  clientId: string;
  path: string;
  handle: FileHandle;
  name: string;
  snapshot: FileSnapshot;
  nextOffset: number;
  expiresAt: number;
  busy: boolean;
};
type ClientRate = { windowStartedAt: number; chunks: number };

export class DownloadManager {
  clock: () => number;
  ttlMs: number;
  rateWindowMs: number;
  maxChunksPerWindow: number;
  auditPath: string | null;
  allowedRoots: string[];
  allowAnyFileDownload: boolean;
  sessions: Map<string, DownloadSession>;
  clientRates: Map<string, ClientRate>;

  constructor(options: DownloadManagerOptions = {}) {
    this.clock = options.clock || (() => Date.now());
    this.ttlMs = positiveInteger(options.ttlMs, DOWNLOAD_SESSION_TTL_MS);
    this.rateWindowMs = positiveInteger(options.rateWindowMs, DEFAULT_RATE_WINDOW_MS);
    this.maxChunksPerWindow = positiveInteger(
      options.maxChunksPerWindow,
      DEFAULT_MAX_CHUNKS_PER_WINDOW,
    );
    this.auditPath = options.auditPath === undefined ? defaultAuditPath() : options.auditPath;
    this.allowedRoots = Array.isArray(options.allowedRoots)
      ? options.allowedRoots.map(resolveDownloadPath)
      : [];
    this.allowAnyFileDownload = options.allowAnyFileDownload === true;
    this.sessions = new Map();
    this.clientRates = new Map();
  }

  async open(payload: DownloadPayload, clientId: unknown) {
    const owner = requireClientId(clientId);
    if (payload?.confirmed !== true) throw new Error('download_confirmation_required');
    await this.#pruneExpired();
    await this.#revokeClientSessions(owner, 'replaced');

    const requestedPath = resolveDownloadPath(payload?.path);
    const path = await canonicalDownloadPath(requestedPath);
    if (!this.allowAnyFileDownload && !await pathAllowedByRoots(path, this.allowedRoots)) {
      throw new Error('download_path_not_allowed');
    }
    const handle = await open(path, 'r').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('download_file_not_found');
      throw error;
    });
    let stats;
    try {
      stats = await handle.stat();
      if (!stats.isFile()) throw new Error('download_not_a_file');
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }

    const now = this.clock();
    const session = {
      id: randomUUID(),
      token: randomBytes(32).toString('base64url'),
      clientId: owner,
      path,
      handle,
      name: fileName(path),
      snapshot: fileSnapshot(stats),
      nextOffset: 0,
      expiresAt: now + this.ttlMs,
      busy: false,
    };
    this.sessions.set(session.id, session);
    await this.#audit('opened', session);
    return {
      downloadId: session.id,
      downloadToken: session.token,
      name: session.name,
      size: session.snapshot.size,
    };
  }

  async read(payload: DownloadPayload, clientId: unknown) {
    await this.#pruneExpired();
    const session = this.#authorize(payload, clientId);
    if (session.busy) throw new Error('download_in_progress');
    session.busy = true;
    try {
      return await this.#readSession(session, payload);
    } finally {
      session.busy = false;
    }
  }

  async #readSession(session: DownloadSession, payload: DownloadPayload) {
    const offset = Number(payload?.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset !== session.nextOffset) {
      throw new Error('download_offset_invalid');
    }
    this.#consumeRateLimit(session);

    const current = fileSnapshot(await session.handle.stat());
    if (!sameSnapshot(session.snapshot, current)) {
      await this.#finish(session, 'file_changed');
      throw new Error('download_file_changed');
    }

    const length = Math.min(DOWNLOAD_CHUNK_BYTES, session.snapshot.size - offset);
    if (length === 0) {
      await this.#finish(session, 'completed');
      return { offset, nextOffset: offset, done: true, data: '' };
    }

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await session.handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) {
      await this.#finish(session, 'read_failed');
      throw new Error('download_read_failed');
    }
    session.nextOffset = offset + bytesRead;
    session.expiresAt = this.clock() + this.ttlMs;
    const done = session.nextOffset >= session.snapshot.size;
    const result = {
      offset,
      nextOffset: session.nextOffset,
      done,
      data: buffer.subarray(0, bytesRead).toString('base64'),
    };
    if (done) await this.#finish(session, 'completed');
    return result;
  }

  async close(payload: DownloadPayload, clientId: unknown) {
    await this.#pruneExpired();
    const session = this.#authorize(payload, clientId);
    if (session.busy) throw new Error('download_in_progress');
    await this.#finish(session, 'canceled');
    return { closed: true };
  }

  async closeAll() {
    await Promise.all([...this.sessions.values()].map((session) => this.#finish(session, 'shutdown')));
    this.clientRates.clear();
  }

  #authorize(payload: DownloadPayload, clientId: unknown) {
    const session = this.sessions.get(String(payload?.downloadId || ''));
    if (!session) throw new Error('download_capability_invalid');
    const owner = requireClientId(clientId);
    if (session.clientId !== owner || !secretMatches(payload?.downloadToken, session.token)) {
      throw new Error('download_capability_invalid');
    }
    return session;
  }

  #consumeRateLimit(session: DownloadSession) {
    const now = this.clock();
    let rate = this.clientRates.get(session.clientId);
    if (!rate || now - rate.windowStartedAt >= this.rateWindowMs) {
      rate = { windowStartedAt: now, chunks: 0 };
      this.clientRates.set(session.clientId, rate);
    }
    rate.chunks += 1;
    if (rate.chunks > this.maxChunksPerWindow) throw new Error('download_rate_limited');
  }

  async #pruneExpired() {
    const now = this.clock();
    const expired = [...this.sessions.values()].filter((session) => session.expiresAt <= now);
    await Promise.all(expired.map((session) => this.#finish(session, 'expired')));
    for (const [clientId, rate] of this.clientRates) {
      if (now - rate.windowStartedAt >= this.rateWindowMs) this.clientRates.delete(clientId);
    }
  }

  async #revokeClientSessions(clientId: string, reason: string) {
    const previous = [...this.sessions.values()].filter((session) => session.clientId === clientId);
    if (previous.some((session) => session.busy)) throw new Error('download_in_progress');
    await Promise.all(previous.map((session) => this.#finish(session, reason)));
  }

  async #finish(session: DownloadSession, event: string) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    await session.handle.close().catch(() => {});
    await this.#audit(event, session);
  }

  async #audit(event: string, session: DownloadSession) {
    if (!this.auditPath) return;
    const record = {
      at: new Date(this.clock()).toISOString(),
      event,
      downloadId: session.id,
      clientHash: shortHash(session.clientId),
      pathHash: shortHash(session.path),
      size: session.snapshot.size,
      transferred: session.nextOffset,
    };
    try {
      await mkdir(dirname(this.auditPath), { recursive: true });
      const existing = await stat(this.auditPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (existing && existing.size >= MAX_AUDIT_BYTES) return;
      await appendFile(this.auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Audit availability must not block an otherwise authorized local download.
    }
  }
}

function resolveDownloadPath(value: unknown) {
  let path = String(value || '').trim();
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (isAbsolute(path)) return resolve(path);
  if (win32.isAbsolute(path)) return win32.normalize(path);
  throw new Error('download_path_must_be_absolute');
}

async function canonicalDownloadPath(path: string) {
  return realpath(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('download_file_not_found');
    throw error;
  });
}

async function pathAllowedByRoots(path: string, roots: string[]) {
  for (const root of roots) {
    const canonicalRoot = await realpath(root).catch(() => root);
    if (isPathWithinRoot(path, canonicalRoot)) return true;
  }
  return false;
}

function fileName(path: string) {
  return (win32.isAbsolute(path) ? win32.basename(path) : basename(path)) || 'download';
}

function fileSnapshot(stats: Stats): FileSnapshot {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    dev: String(stats.dev),
    ino: String(stats.ino),
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot) {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino;
}

function requireClientId(value: unknown) {
  const clientId = String(value || '').trim();
  if (!clientId) throw new Error('download_client_required');
  return clientId;
}

function positiveInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function shortHash(value: string) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function defaultAuditPath() {
  const base = process.env.LOCALAPPDATA || join(tmpdir(), 'personal-codex-bridge');
  return join(base, 'PersonalCodexBridge', 'download-audit.jsonl');
}
