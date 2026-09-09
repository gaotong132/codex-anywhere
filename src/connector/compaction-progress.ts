import { homedir } from 'node:os';
import { join } from 'node:path';

type Request = { threadId: string; turnId: string; turnStartedAt: number; after: number };
type Progress = { turnId: string; startedAt: number };
type LogRow = { ts: number; ts_nanos: number; body: string };
const CACHE_MS = 1_000;
const MAX_TASKS = 12;

// Desktop owns its event stream. Its local trace span supplies a best-effort
// start signal that rollout files only record after compaction has finished.
// Never return log bodies, or infer compaction from token usage / elapsed time.
export class CompactionProgressReader {
  private cache = new Map<string, { at: number; request: Request; progress: Progress | null }>();
  private pending = new Map<string, Promise<Progress | null>>();
  constructor(private path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'logs_2.sqlite')) {}

  async read(request: Request): Promise<Progress | null> {
    if (!request.threadId || !request.turnId || request.turnStartedAt <= 0) return null;
    const key = request.threadId;
    const cached = this.cache.get(key);
    const matches = cached?.request.turnId === request.turnId && cached.request.after === request.after;
    if (matches && Date.now() - cached.at < CACHE_MS) return cached.progress;
    // Await one bounded read per task; a newer turn/boundary must read again.
    if (this.pending.has(key)) { await this.pending.get(key); return this.read(request); }
    if (this.pending.size >= MAX_TASKS) return null;
    const pending = this.query(request).then((progress) => {
      if (progress && cached?.progress?.turnId === progress.turnId && cached.progress.startedAt > request.after) {
        progress.startedAt = Math.min(progress.startedAt, cached.progress.startedAt);
      }
      this.cache.delete(key);
      this.cache.set(key, { at: Date.now(), request, progress });
      while (this.cache.size > MAX_TASKS) this.cache.delete(this.cache.keys().next().value!);
      return progress;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, pending);
    return pending;
  }

  private async query(request: Request): Promise<Progress | null> {
    let db: import('node:sqlite').DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(this.path, { readOnly: true });
      db.exec('PRAGMA busy_timeout=50');
      // The thread/timestamp index bounds the range; inspect only 256 recent
      // records and at most 2 KiB of each prefix, never request/response bodies.
      const rows = db.prepare(`SELECT ts, ts_nanos, body FROM (
        SELECT ts, ts_nanos, id, target,
          CASE WHEN target = 'codex_http_client::custom_ca' THEN substr(feedback_log_body, 1, 2048) END AS body
        FROM logs WHERE thread_id = ? AND ts >= ?
        ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 256
      ) WHERE target = 'codex_http_client::custom_ca'
      ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1`).all(
        request.threadId, Math.floor(Math.max(request.turnStartedAt, request.after) / 1000),
      ) as LogRow[];
      const row = rows[0];
      if (!row) return null;
      const startedAt = row.ts * 1000 + Math.floor(row.ts_nanos / 1_000_000);
      if (startedAt <= request.after || startedAt < request.turnStartedAt || startedAt > Date.now() + 5_000) return null;
      const turnId = /(?:^|[ {])turn\.id=([a-zA-Z0-9_-]+)(?=[ }])/.exec(row.body)?.[1];
      if (turnId !== request.turnId || !/:run_auto_compact\{[^}]*\}:/.test(row.body)) return null;
      return { turnId, startedAt };
    } catch {
      // Missing/changed log schema or an older Node runtime cannot block chat.
      return null;
    } finally { db?.close(); }
  }
}
