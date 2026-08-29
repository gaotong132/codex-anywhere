import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { normalizeToolPurpose, parseAssistantMessage, parseUserMessage } from '../shared/message-content.js';
import type { MessageContext } from '../shared/message-content.js';
import {
  extractGeneratedImageAttachment,
  type GeneratedImageAttachment,
} from './generated-images.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 80;
const MAX_TEXT_LENGTH = 4_000;
const ACTIVITY_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const ACTIVITY_SCAN_OVERLAP_BYTES = 1_024;
const MAX_CACHED_ROLLOUTS = 12;
type RolloutStatus = 'unknown' | 'inProgress' | 'completed' | 'failed';
type RolloutActivity = { status: RolloutStatus; id: string; startedAt: number | null };
type LiveActivityKind = 'starting' | 'planning' | 'command' | 'editing' | 'searching'
  | 'connectedTool' | 'generating' | 'waiting' | 'checking' | 'working';
type LiveActivity = { kind: LiveActivityKind; updatedAt: number | null };
type RolloutRow = Record<string, any>;
type RolloutItem = {
  type: string;
  phase?: string;
  text: string;
  contexts?: MessageContext[];
  status?: string;
  name?: string;
  input?: string;
  output?: string;
  attachment?: GeneratedImageAttachment;
  completedAt?: number | null;
};
type RolloutOptions = { filePath: string; threadId: string; maxBytes?: number; maxItems?: number };
type SnapshotOptions = { threadId: string; maxBytes: number; maxItems: number };
type RolloutSnapshot = SnapshotOptions & {
  fileSize: number;
  parsedOffset: number;
  items: RolloutItem[];
  activity: RolloutActivity;
  liveActivity: LiveActivity;
  toolPurpose: string;
};
type CompleteRows = { rows: RolloutRow[]; parsedOffset: number; firstCompleteOffset: number };
const activityMarkers = [
  { needle: Buffer.from('"type":"task_started"'), status: 'inProgress' },
  { needle: Buffer.from('"type":"task_complete"'), status: 'completed' },
  { needle: Buffer.from('"type":"task_failed"'), status: 'failed' },
  { needle: Buffer.from('"type":"turn_aborted"'), status: 'failed' },
  { needle: Buffer.from('"type":"turn_error"'), status: 'failed' },
] as const satisfies ReadonlyArray<{ needle: Buffer; status: RolloutStatus }>;
const rolloutCache = new Map<string, RolloutSnapshot>();

export async function readRolloutTail(options: RolloutOptions) {
  const filePath = String(options?.filePath || '');
  const threadId = String(options?.threadId || '');
  const maxBytes = Number.isFinite(options?.maxBytes)
    ? Math.max(64 * 1024, Number(options.maxBytes)) : DEFAULT_MAX_BYTES;
  const maxItems = Number.isFinite(options?.maxItems)
    ? Math.max(1, Number(options.maxItems)) : DEFAULT_MAX_ITEMS;
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    const cached = rolloutCache.get(filePath);
    const reusable = cached
      && cached.threadId === threadId
      && cached.maxBytes === maxBytes
      && cached.maxItems === maxItems
      && fileStat.size >= cached.fileSize;
    const snapshot = reusable
      ? await updateSnapshot(handle, fileStat.size, cached)
      : await initializeSnapshot(handle, fileStat.size, { threadId, maxBytes, maxItems });
    rememberSnapshot(filePath, snapshot);
    return {
      threadId,
      turns: snapshot.items.length || snapshot.activity.status !== 'unknown' ? [{
        id: `tail:${threadId}`,
        status: snapshot.activity.status,
        startedAt: null,
        completedAt: null,
        items: snapshot.items,
      }] : [],
      nextCursor: null,
      truncated: true,
      source: 'rolloutTail',
      fileSize: fileStat.size,
      activityId: snapshot.activity.id,
      activityKind: snapshot.activity.status === 'inProgress' ? snapshot.liveActivity.kind : '',
      activityStartedAt: snapshot.activity.status === 'inProgress' ? snapshot.activity.startedAt : null,
      activityUpdatedAt: snapshot.activity.status === 'inProgress' ? snapshot.liveActivity.updatedAt : null,
      toolPurpose: snapshot.activity.status === 'inProgress' ? snapshot.toolPurpose : '',
    };
  } finally {
    await handle.close();
  }
}

async function initializeSnapshot(handle: FileHandle, fileSize: number, options: SnapshotOptions): Promise<RolloutSnapshot> {
  const windowStart = Math.max(0, fileSize - options.maxBytes);
  const window = await readCompleteRows(handle, windowStart, fileSize, windowStart > 0);
  let activity = inferRolloutActivity(window.rows);
  if (activity.status === 'unknown' && window.firstCompleteOffset > 0) {
    activity = await findLatestActivityBefore(handle, window.firstCompleteOffset);
  }
  return {
    ...options,
    fileSize,
    parsedOffset: window.parsedOffset,
    items: mapRolloutRows(window.rows).slice(-options.maxItems),
    activity,
    liveActivity: updateLiveActivity({ kind: 'working', updatedAt: activity.startedAt }, window.rows, activity.status),
    toolPurpose: updateToolPurpose('', window.rows, activity.status),
  };
}

async function updateSnapshot(handle: FileHandle, fileSize: number, cached: RolloutSnapshot): Promise<RolloutSnapshot> {
  if (fileSize === cached.fileSize) return cached;
  if (fileSize - cached.parsedOffset > cached.maxBytes * 2) {
    return initializeSnapshot(handle, fileSize, cached);
  }
  const appended = await readCompleteRows(handle, cached.parsedOffset, fileSize, false);
  const appendedActivity = inferRolloutActivity(appended.rows);
  const activity = appendedActivity.status === 'unknown' ? cached.activity : {
    ...appendedActivity,
    startedAt: appendedActivity.startedAt || cached.activity.startedAt,
  };
  return {
    ...cached,
    fileSize,
    parsedOffset: appended.parsedOffset,
    items: appendItems(cached.items, mapRolloutRows(appended.rows), cached.maxItems),
    activity,
    liveActivity: updateLiveActivity(cached.liveActivity, appended.rows, activity.status),
    toolPurpose: updateToolPurpose(cached.toolPurpose, appended.rows, activity.status),
  };
}

async function readCompleteRows(
  handle: FileHandle, start: number, end: number, dropLeadingPartial: boolean,
): Promise<CompleteRows> {
  const length = Math.max(0, end - start);
  if (!length) return { rows: [], parsedOffset: start, firstCompleteOffset: start };
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  let begin = 0;
  const recoveredRows: RolloutRow[] = [];
  if (dropLeadingPartial) {
    const firstNewline = data.indexOf(0x0a);
    if (firstNewline < 0) return { rows: [], parsedOffset: start, firstCompleteOffset: end };
    recoveredRows.push(...recoverGeneratedImageRows(data.subarray(0, firstNewline).toString('utf8')));
    begin = firstNewline + 1;
  }
  const firstCompleteOffset = start + begin;
  const lastNewline = data.lastIndexOf(0x0a);
  if (lastNewline < begin) {
    return { rows: recoveredRows, parsedOffset: firstCompleteOffset, firstCompleteOffset };
  }
  const rows = recoveredRows.concat(data.subarray(begin, lastNewline + 1).toString('utf8')
    .split('\n').filter(Boolean).map(parseRow).filter((row): row is RolloutRow => Boolean(row)));
  return { rows, parsedOffset: start + lastNewline + 1, firstCompleteOffset };
}

async function findLatestActivityBefore(handle: FileHandle, endOffset: number): Promise<RolloutActivity> {
  let cursor = endOffset;
  while (cursor > 0) {
    const start = Math.max(0, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const readEnd = Math.min(endOffset, cursor + ACTIVITY_SCAN_OVERLAP_BYTES);
    const buffer = Buffer.alloc(readEnd - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    let latest: (typeof activityMarkers[number] & { index: number }) | null = null;
    for (const marker of activityMarkers) {
      const index = data.lastIndexOf(marker.needle);
      if (index >= 0 && (!latest || index > latest.index)) latest = { ...marker, index };
    }
    if (latest) {
      const lineStart = data.lastIndexOf(0x0a, Math.max(0, latest.index - 1)) + 1;
      const nextNewline = data.indexOf(0x0a, latest.index);
      const lineEnd = nextNewline < 0 ? data.length : nextNewline;
      const row = parseRow(data.subarray(lineStart, lineEnd).toString('utf8'));
      const exactActivity = inferRolloutActivity(row ? [row] : []);
      if (exactActivity.status !== 'unknown') return exactActivity;
      const context = data.subarray(latest.index, Math.min(data.length, latest.index + 1_024)).toString('utf8');
      const id = /"(?:turn_id|turnId)"\s*:\s*"([^"]*)"/.exec(context)?.[1] || '';
      return { status: latest.status, id, startedAt: null };
    }
    cursor = start;
  }
  return { status: 'unknown', id: '', startedAt: null };
}

function appendItems(current: RolloutItem[], appended: RolloutItem[], maxItems: number) {
  const result = [...current];
  for (const item of appended) pushText(result, item);
  return result.slice(-maxItems);
}

function rememberSnapshot(filePath: string, snapshot: RolloutSnapshot) {
  rolloutCache.delete(filePath);
  rolloutCache.set(filePath, snapshot);
  while (rolloutCache.size > MAX_CACHED_ROLLOUTS) {
    const oldest = rolloutCache.keys().next().value;
    if (oldest === undefined) break;
    rolloutCache.delete(oldest);
  }
}

function inferRolloutActivity(rows: RolloutRow[]): RolloutActivity {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.type !== 'event_msg') continue;
    const payload = row?.payload || {};
    const type = String(payload.type || '');
    const id = String(payload.turn_id || payload.turnId || '');
    const startedAt = epochMillis(payload.started_at || payload.startedAt || row.timestamp);
    if (type === 'task_complete') return { status: 'completed', id, startedAt };
    if (type === 'task_started') return { status: 'inProgress', id, startedAt };
    if (/task_failed|turn_aborted|turn_error/.test(type)) return { status: 'failed', id, startedAt };
  }
  return { status: 'unknown', id: '', startedAt: null };
}

function inferRolloutStatus(rows: RolloutRow[]) {
  return inferRolloutActivity(rows).status;
}

function updateToolPurpose(current: string, rows: RolloutRow[], status: RolloutStatus) {
  let purpose = current;
  for (const row of rows) {
    if (row?.type !== 'event_msg') continue;
    const payload = row.payload || {};
    const type = String(payload.type || '');
    if (type === 'task_started' || /task_complete|task_failed|turn_aborted|turn_error/.test(type)) {
      purpose = '';
    } else if (type === 'agent_reasoning') {
      purpose = normalizeToolPurpose(payload.text);
    }
  }
  return status === 'inProgress' ? purpose : '';
}

function updateLiveActivity(current: LiveActivity, rows: RolloutRow[], status: RolloutStatus): LiveActivity {
  let activity = current;
  for (const row of rows) {
    const kind = activityKind(row);
    if (!kind) continue;
    activity = { kind, updatedAt: epochMillis(row.timestamp) || activity.updatedAt };
  }
  return status === 'inProgress' ? activity : { kind: 'working', updatedAt: null };
}

function activityKind(row: RolloutRow): LiveActivityKind | null {
  const payload = row?.payload || {};
  const type = String(payload.type || '');
  const itemType = String(payload.item?.type || '');
  const name = String(payload.name || payload.item?.name || '').toLowerCase();
  if (type === 'task_started') return 'starting';
  if (/task_complete|task_failed|turn_aborted|turn_error/.test(type)) return null;
  if (type === 'agent_reasoning' || type === 'reasoning' || itemType === 'Reasoning') return 'planning';
  if (/patch_apply|file_change/i.test(type) || /FileChange/i.test(itemType) || /apply.?patch/.test(name)) return 'editing';
  if (/web_search/i.test(type) || /WebSearch/i.test(itemType) || /web.?search/.test(name)) return 'searching';
  if (/image_generation/i.test(type) || /ImageGeneration/i.test(itemType) || /image.?gen/.test(name)) return 'generating';
  if (/mcp_tool_call/i.test(type) || /McpTool/i.test(itemType)) return 'connectedTool';
  if (row?.type === 'response_item' && /custom_tool_call|function_call/.test(type)) {
    if (name === 'wait' || /wait/.test(name)) return 'waiting';
    if (name === 'exec' || /command|shell/.test(name)) return 'command';
    return 'connectedTool';
  }
  if (row?.type === 'response_item' && /custom_tool_call_output|function_call_output/.test(type)) return 'checking';
  if (/CommandExecution/i.test(itemType)) return 'command';
  return null;
}

function epochMillis(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRow(line: string): RolloutRow | null {
  try { return JSON.parse(line); } catch { return null; }
}

function recoverGeneratedImageRows(partialRow: string): RolloutRow[] {
  const rows: RolloutRow[] = [];
  const pattern = /"saved_path"\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of partialRow.matchAll(pattern)) {
    try {
      const savedPath = JSON.parse(match[1]);
      if (typeof savedPath === 'string' && /\.codex[\\/]generated_images[\\/]/i.test(savedPath)) {
        rows.push({
          type: 'event_msg',
          payload: { type: 'image_generation_end', status: 'completed', saved_path: savedPath },
        });
      }
    } catch { /* incomplete JSON string */ }
  }
  return rows;
}

function mapRolloutRows(rows: RolloutRow[]): RolloutItem[] {
  const items: RolloutItem[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = row?.payload || {};
    const payloadType = String(payload.type || '');
    const completedAt = epochMillis(row.timestamp);
    const timing = completedAt ? { completedAt } : {};
    if (row?.type === 'event_msg' && payloadType === 'agent_message') {
      const content = parseAssistantMessage(payload.message);
      pushText(items, {
        type: 'agentMessage', phase: payload.phase || 'commentary', ...content, ...timing,
      });
    } else if (row?.type === 'event_msg' && payloadType === 'user_message') {
      pushText(items, {
        type: 'userMessage', ...parseUserMessage(payload.message || payload.text), ...timing,
      });
    } else if (row?.type === 'response_item' && payloadType === 'message') {
      if (payload.role === 'user') {
        pushText(items, {
          type: 'userMessage', ...parseUserMessage(extractContent(payload.content)), ...timing,
        });
      } else if (payload.role === 'assistant') {
        const content = parseAssistantMessage(extractContent(payload.content));
        pushText(items, {
          type: 'agentMessage', phase: payload.phase || 'commentary',
          ...content, ...timing,
        });
      }
    } else if (row?.type === 'event_msg' && payloadType === 'image_generation_end') {
      const attachment = extractGeneratedImageAttachment(payload);
      if (payload.status === 'completed' && attachment) {
        pushText(items, {
          type: 'agentMessage', phase: 'final_answer', text: '', attachment, ...timing,
        });
      }
    }
  }
  return items;
}

function pushText(items: RolloutItem[], item: RolloutItem) {
  const text = capText(item.text);
  if (!text && !item.attachment) return;
  const previous = items.at(-1);
  if (previous?.type === item.type
    && previous.phase === item.phase
    && previous.text === text
    && previous.attachment?.path === item.attachment?.path
    && JSON.stringify(previous.contexts || []) === JSON.stringify(item.contexts || [])) return;
  items.push({ ...item, text, status: '', name: '', input: '', output: '' });
}

function extractContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item: any) => {
    if (typeof item === 'string') return item;
    return item?.text || item?.input_text || item?.output_text || '';
  }).filter(Boolean).join('\n');
}

function capText(value: unknown, limit = MAX_TEXT_LENGTH) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断）`;
}

export const internals = {
  activityKind, capText, epochMillis, extractContent, findLatestActivityBefore, inferRolloutActivity,
  inferRolloutStatus, mapRolloutRows, recoverGeneratedImageRows, rolloutCache, updateLiveActivity,
  updateToolPurpose,
};
