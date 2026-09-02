import { open, type FileHandle } from 'node:fs/promises';

export const MAX_TURN_DIFF_BYTES = 512 * 1024;

const READ_CHUNK_BYTES = 128 * 1024;
const MAX_ROLLOUT_ROW_BYTES = 8 * 1024 * 1024;

type JsonObject = Record<string, any>;
type DiffAccumulator = {
  content: string;
  size: number;
  truncated: boolean;
};

export type TurnDiffDocument = {
  threadId: string;
  turnId: string;
  size: number;
  content: string;
  truncated: boolean;
};

export function createTurnDiffDocument(
  threadId: string,
  turnId: string,
  value: unknown,
): TurnDiffDocument | null {
  const resolvedThreadId = optionalIdentifier(threadId);
  const resolvedTurnId = optionalIdentifier(turnId);
  if (!resolvedThreadId || !resolvedTurnId) return null;
  const content = normalizeDiffText(value);
  if (!content.trim()) return null;
  const bounded = boundedUtf8(content, MAX_TURN_DIFF_BYTES);
  return {
    threadId: resolvedThreadId,
    turnId: resolvedTurnId,
    size: Buffer.byteLength(bounded.text, 'utf8'),
    content: bounded.text,
    truncated: bounded.truncated,
  };
}

export async function readRolloutTurnDiff({
  filePath,
  threadId,
  turnId,
}: {
  filePath: string;
  threadId: string;
  turnId: string;
}): Promise<TurnDiffDocument> {
  const resolvedThreadId = requiredIdentifier(threadId, 'thread_id_required');
  const resolvedTurnId = requiredIdentifier(turnId, 'turn_id_required');
  const handle = await open(String(filePath || ''), 'r');
  const accumulator: DiffAccumulator = { content: '', size: 0, truncated: false };
  let currentTurnId = '';
  let foundTurn = false;

  try {
    await scanCompleteRows(handle, (row) => {
      const payload = row?.payload || {};
      const type = String(payload.type || '');
      const rowTurnId = rolloutRowTurnId(row);
      if (type === 'task_started') {
        if (foundTurn && rowTurnId !== resolvedTurnId) return false;
        currentTurnId = rowTurnId;
        if (currentTurnId === resolvedTurnId) {
          foundTurn = true;
          resetAccumulator(accumulator);
        }
      } else if (rowTurnId) {
        currentTurnId = rowTurnId;
      }
      if (currentTurnId !== resolvedTurnId && rowTurnId !== resolvedTurnId) return true;
      foundTurn = true;

      if (typeof payload.diff === 'string' && payload.diff.trim()) {
        replaceAccumulator(accumulator, payload.diff);
      }
      const changes = patchChanges(row);
      if (changes) appendPatchChanges(accumulator, changes);
      return true;
    });
  } finally {
    await handle.close();
  }

  if (!foundTurn || !accumulator.content.trim()) throw new Error('turn_diff_unavailable');
  return {
    threadId: resolvedThreadId,
    turnId: resolvedTurnId,
    size: accumulator.size,
    content: accumulator.content,
    truncated: accumulator.truncated,
  };
}

function requiredIdentifier(value: unknown, error: string) {
  const identifier = optionalIdentifier(value);
  if (!identifier) throw new Error(error);
  return identifier;
}

function optionalIdentifier(value: unknown) {
  const identifier = String(value || '').trim();
  return identifier && identifier.length <= 256 && !/[\0\r\n]/.test(identifier) ? identifier : '';
}

async function scanCompleteRows(handle: FileHandle, visit: (row: JsonObject) => boolean | void) {
  const fileSize = (await handle.stat()).size;
  let position = 0;
  let parts: Buffer[] = [];
  let pendingBytes = 0;
  let droppingOversizedRow = false;

  const clearPending = () => {
    parts = [];
    pendingBytes = 0;
  };
  const visitLine = (tail: Buffer) => {
    if (droppingOversizedRow) {
      droppingOversizedRow = false;
      clearPending();
      return true;
    }
    const totalBytes = pendingBytes + tail.length;
    if (totalBytes > MAX_ROLLOUT_ROW_BYTES) {
      clearPending();
      return true;
    }
    const line = parts.length
      ? Buffer.concat([...parts, tail], totalBytes).toString('utf8')
      : tail.toString('utf8');
    clearPending();
    if (!line.trim()) return true;
    try {
      const row = JSON.parse(line);
      return !row || typeof row !== 'object' || Array.isArray(row) || visit(row) !== false;
    } catch {
      return true;
    }
  };

  while (position < fileSize) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, fileSize - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    let cursor = 0;
    while (cursor < data.length) {
      const newline = data.indexOf(0x0a, cursor);
      if (newline >= 0) {
        if (!visitLine(data.subarray(cursor, newline))) return;
        cursor = newline + 1;
        continue;
      }
      const tail = data.subarray(cursor);
      if (!droppingOversizedRow) {
        if (pendingBytes + tail.length > MAX_ROLLOUT_ROW_BYTES) {
          droppingOversizedRow = true;
          clearPending();
        } else {
          parts.push(Buffer.from(tail));
          pendingBytes += tail.length;
        }
      }
      break;
    }
  }
  if (!droppingOversizedRow && pendingBytes) visitLine(Buffer.alloc(0));
}

function patchChanges(row: JsonObject): Record<string, unknown> | null {
  const payload = row?.payload || {};
  const type = String(payload.type || '');
  const value = type === 'patch_apply_end' && payload.success !== false
    ? payload.changes
    : type === 'item_completed' && /FileChange/i.test(String(payload.item?.type || ''))
      ? payload.item?.changes
      : undefined;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function appendPatchChanges(accumulator: DiffAccumulator, changes: Record<string, unknown>) {
  for (const [rawPath, rawChange] of Object.entries(changes)) {
    if (accumulator.size >= MAX_TURN_DIFF_BYTES) {
      accumulator.truncated = true;
      return;
    }
    if (!rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) continue;
    const change = rawChange as Record<string, unknown>;
    const path = safeDiffPath(rawPath);
    const type = String(change.type || 'update').toLowerCase();
    const rawDiff = normalizeDiffText(change.unified_diff || change.diff);
    if (rawDiff) {
      appendAccumulator(accumulator, withFileHeaders(path, rawDiff));
      continue;
    }
    if (type !== 'add' && type !== 'delete') continue;
    const source = normalizeDiffText(change.content);
    const limited = boundedUtf8(source, MAX_TURN_DIFF_BYTES);
    const lineCount = countContentLines(source);
    const body = prefixLines(limited.text, type === 'add' ? '+' : '-');
    const header = type === 'add'
      ? [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${lineCount} @@`,
      ]
      : [
        `diff --git a/${path} b/${path}`,
        'deleted file mode 100644',
        `--- a/${path}`,
        '+++ /dev/null',
        `@@ -1,${lineCount} +0,0 @@`,
      ];
    appendAccumulator(accumulator, `${header.join('\n')}\n${body}`);
    if (limited.truncated) accumulator.truncated = true;
  }
}

function withFileHeaders(path: string, value: string) {
  const diff = value.trimEnd();
  if (/^diff --git /m.test(diff)) return diff;
  const gitHeader = `diff --git a/${path} b/${path}`;
  if (/^--- /m.test(diff) && /^\+\+\+ /m.test(diff)) return `${gitHeader}\n${diff}`;
  return `${gitHeader}\n--- a/${path}\n+++ b/${path}\n${diff}`;
}

function safeDiffPath(value: unknown) {
  const path = String(value || 'unknown').replace(/[\0\r\n]/g, '�').slice(0, 1_024);
  return path || 'unknown';
}

function normalizeDiffText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\0/g, '').replace(/\r\n/g, '\n') : '';
}

function countContentLines(value: string) {
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return value.endsWith('\n') ? lines - 1 : lines;
}

function prefixLines(value: string, prefix: string) {
  if (!value) return '';
  const trailingNewline = value.endsWith('\n');
  const lines = value.split('\n');
  if (trailingNewline) lines.pop();
  return `${lines.map((line) => `${prefix}${line}`).join('\n')}${trailingNewline ? '\n' : ''}`;
}

function resetAccumulator(accumulator: DiffAccumulator) {
  accumulator.content = '';
  accumulator.size = 0;
  accumulator.truncated = false;
}

function replaceAccumulator(accumulator: DiffAccumulator, value: unknown) {
  resetAccumulator(accumulator);
  const bounded = boundedUtf8(normalizeDiffText(value), MAX_TURN_DIFF_BYTES);
  accumulator.content = bounded.text;
  accumulator.size = Buffer.byteLength(bounded.text, 'utf8');
  accumulator.truncated = bounded.truncated;
}

function appendAccumulator(accumulator: DiffAccumulator, value: unknown) {
  const part = normalizeDiffText(value).trimEnd();
  if (!part) return;
  const separator = accumulator.content ? '\n\n' : '';
  const available = MAX_TURN_DIFF_BYTES - accumulator.size - Buffer.byteLength(separator, 'utf8');
  if (available <= 0) {
    accumulator.truncated = true;
    return;
  }
  const bounded = boundedUtf8(part, available);
  accumulator.content += `${separator}${bounded.text}`;
  accumulator.size = Buffer.byteLength(accumulator.content, 'utf8');
  accumulator.truncated ||= bounded.truncated;
}

function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, Math.max(0, maxBytes)).toString('utf8');
  if (text.endsWith('�')) text = text.slice(0, -1);
  return { text, truncated: true };
}

function rolloutRowTurnId(row: JsonObject) {
  const payload = row?.payload || {};
  const item = payload.item || {};
  return String(
    payload.turn_id
    || payload.turnId
    || payload.internal_chat_message_metadata_passthrough?.turn_id
    || item.turn_id
    || item.turnId
    || item.internal_chat_message_metadata_passthrough?.turn_id
    || row?.turn_id
    || row?.turnId
    || '',
  ).trim();
}

export const internals = {
  appendPatchChanges,
  boundedUtf8,
  rolloutRowTurnId,
};
