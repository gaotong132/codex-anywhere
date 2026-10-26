import { homedir } from 'node:os';
import { join } from 'node:path';

type Request = { threadId: string; turnId: string; turnStartedAt: number; after: number };
type Progress = { turnId: string; startedAt: number };
type LogRow = { ts: number; ts_nanos: number; target: string; body: string };
const CACHE_MS = 1_000;
const MAX_TASKS = 12;
const REQUEST_LOG_TARGETS = [
  'codex_http_client::custom_ca',
  'codex_core::client',
  'codex_api::sse::responses',
  'codex_api::endpoint::responses_websocket',
  'codex_core::responses_retry',
  'codex_core::compact_remote_v2::attempt',
];

function requestCompaction(row: LogRow, turnId: string): boolean | null {
  // Only inspect trace spans, not text supplied in a response or tool output.
  const messageOffset = row.body.indexOf(': ');
  if (messageOffset < 0) return null;
  const spans = row.body.slice(0, messageOffset + 1);
  const turnIds = [...spans.matchAll(/(?:^|[ {])turn\.id=(?:"([a-zA-Z0-9_-]+)"|([a-zA-Z0-9_-]+))(?=[ }])/g)]
    .map(match => match[1] || match[2]);
  if (!turnIds.length || turnIds.some(id => id !== turnId)) return null;
  const compacting = /:run_auto_compact(?:\{[^}]*\})?:/.test(spans);
  if (compacting && row.target === 'codex_core::compact_remote_v2::attempt') return true;
  // Both HTTP and WebSocket request spans identify actual model requests.
  // Preflight checks and token-usage logs alone never prove compaction.
  if (!/:model_client\.stream_responses_(?:api|websocket)(?:\{[^}]*\})?:/.test(spans)) return null;
  return compacting;
}

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
    const matches = cached?.request.turnId === request.turnId && cached.request.after === request.after
      && cached.request.turnStartedAt === request.turnStartedAt;
    if (matches && Date.now() - cached.at < CACHE_MS) return cached.progress;
    // Await one bounded read per task; a newer turn/boundary must read again.
    if (this.pending.has(key)) { await this.pending.get(key); return this.read(request); }
    if (this.pending.size >= MAX_TASKS) return null;
    const pending = this.query(request, cached?.progress).then((progress) => {
      this.cache.delete(key);
      this.cache.set(key, { at: Date.now(), request, progress });
      while (this.cache.size > MAX_TASKS) this.cache.delete(this.cache.keys().next().value!);
      return progress;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, pending);
    return pending;
  }

  private async query(request: Request, previous?: Progress | null): Promise<Progress | null> {
    let db: import('node:sqlite').DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(this.path, { readOnly: true });
      db.exec('PRAGMA busy_timeout=50');
      // The thread/timestamp index bounds the range; inspect only 256 recent
      // records and at most 2 KiB of each prefix, never request/response bodies.
      const targets = REQUEST_LOG_TARGETS.map(() => '?').join(',');
      const rows = db.prepare(`SELECT ts, ts_nanos, target, body FROM (
        SELECT ts, ts_nanos, id, target,
          CASE WHEN target IN (${targets}) THEN substr(feedback_log_body, 1, 2048) END AS body
        FROM logs WHERE thread_id = ? AND ts >= ?
        ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 256
      ) WHERE body IS NOT NULL
      ORDER BY ts DESC, ts_nanos DESC, id DESC`).all(
        ...REQUEST_LOG_TARGETS, request.threadId, Math.floor(Math.max(request.turnStartedAt, request.after) / 1000),
      ) as LogRow[];
      let progress: Progress | null = null;
      let boundary = Math.max(request.after, request.turnStartedAt - 1);
      for (const row of rows) {
        const at = row.ts * 1000 + Math.floor(row.ts_nanos / 1_000_000);
        if (at <= boundary || at > Date.now() + 5_000) continue;
        const compacting = requestCompaction(row, request.turnId);
        if (compacting === null) continue;
        if (!compacting) { boundary = at; break; }
        progress = { turnId: request.turnId, startedAt: at };
      }
      if (progress && previous?.turnId === progress.turnId && previous.startedAt > boundary) {
        progress.startedAt = Math.min(progress.startedAt, previous.startedAt);
      }
      return progress;
    } catch {
      // Missing/changed log schema or an older Node runtime cannot block chat.
      return null;
    } finally { db?.close(); }
  }
}
