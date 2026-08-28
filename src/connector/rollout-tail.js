import { open } from 'node:fs/promises';
import { displayAssistantMessage, displayUserMessage } from '../shared/message-content.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 80;
const MAX_TEXT_LENGTH = 4_000;
const ACTIVITY_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const ACTIVITY_SCAN_OVERLAP_BYTES = 1_024;
const MAX_CACHED_ROLLOUTS = 12;
const activityMarkers = [
  { needle: Buffer.from('"type":"task_started"'), status: 'inProgress' },
  { needle: Buffer.from('"type":"task_complete"'), status: 'completed' },
  { needle: Buffer.from('"type":"task_failed"'), status: 'failed' },
  { needle: Buffer.from('"type":"turn_aborted"'), status: 'failed' },
  { needle: Buffer.from('"type":"turn_error"'), status: 'failed' },
];
const rolloutCache = new Map();

export async function readRolloutTail(options) {
  const filePath = String(options?.filePath || '');
  const threadId = String(options?.threadId || '');
  const maxBytes = Number.isFinite(options?.maxBytes)
    ? Math.max(64 * 1024, options.maxBytes) : DEFAULT_MAX_BYTES;
  const maxItems = Number.isFinite(options?.maxItems)
    ? Math.max(1, options.maxItems) : DEFAULT_MAX_ITEMS;
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
    };
  } finally {
    await handle.close();
  }
}

async function initializeSnapshot(handle, fileSize, options) {
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
  };
}

async function updateSnapshot(handle, fileSize, cached) {
  if (fileSize === cached.fileSize) return cached;
  if (fileSize - cached.parsedOffset > cached.maxBytes * 2) {
    return initializeSnapshot(handle, fileSize, cached);
  }
  const appended = await readCompleteRows(handle, cached.parsedOffset, fileSize, false);
  const appendedActivity = inferRolloutActivity(appended.rows);
  return {
    ...cached,
    fileSize,
    parsedOffset: appended.parsedOffset,
    items: appendItems(cached.items, mapRolloutRows(appended.rows), cached.maxItems),
    activity: appendedActivity.status === 'unknown' ? cached.activity : appendedActivity,
  };
}

async function readCompleteRows(handle, start, end, dropLeadingPartial) {
  const length = Math.max(0, end - start);
  if (!length) return { rows: [], parsedOffset: start, firstCompleteOffset: start };
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  let begin = 0;
  if (dropLeadingPartial) {
    const firstNewline = data.indexOf(0x0a);
    if (firstNewline < 0) return { rows: [], parsedOffset: start, firstCompleteOffset: end };
    begin = firstNewline + 1;
  }
  const firstCompleteOffset = start + begin;
  const lastNewline = data.lastIndexOf(0x0a);
  if (lastNewline < begin) {
    return { rows: [], parsedOffset: firstCompleteOffset, firstCompleteOffset };
  }
  const rows = data.subarray(begin, lastNewline + 1).toString('utf8')
    .split('\n').filter(Boolean).map(parseRow).filter(Boolean);
  return { rows, parsedOffset: start + lastNewline + 1, firstCompleteOffset };
}

async function findLatestActivityBefore(handle, endOffset) {
  let cursor = endOffset;
  while (cursor > 0) {
    const start = Math.max(0, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const readEnd = Math.min(endOffset, cursor + ACTIVITY_SCAN_OVERLAP_BYTES);
    const buffer = Buffer.alloc(readEnd - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    let latest = null;
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
      return { status: latest.status, id };
    }
    cursor = start;
  }
  return { status: 'unknown', id: '' };
}

function appendItems(current, appended, maxItems) {
  const result = [...current];
  for (const item of appended) pushText(result, item);
  return result.slice(-maxItems);
}

function rememberSnapshot(filePath, snapshot) {
  rolloutCache.delete(filePath);
  rolloutCache.set(filePath, snapshot);
  while (rolloutCache.size > MAX_CACHED_ROLLOUTS) {
    rolloutCache.delete(rolloutCache.keys().next().value);
  }
}

function inferRolloutActivity(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.type !== 'event_msg') continue;
    const payload = row?.payload || {};
    const type = String(payload.type || '');
    const id = String(payload.turn_id || payload.turnId || '');
    if (type === 'task_complete') return { status: 'completed', id };
    if (type === 'task_started') return { status: 'inProgress', id };
    if (/task_failed|turn_aborted|turn_error/.test(type)) return { status: 'failed', id };
  }
  return { status: 'unknown', id: '' };
}

function inferRolloutStatus(rows) {
  return inferRolloutActivity(rows).status;
}

function parseRow(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function mapRolloutRows(rows) {
  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = row?.payload || {};
    const payloadType = String(payload.type || '');
    if (row?.type === 'event_msg' && payloadType === 'agent_message') {
      pushText(items, {
        type: 'agentMessage', phase: payload.phase || 'commentary', text: displayAssistantMessage(payload.message),
      });
    } else if (row?.type === 'event_msg' && payloadType === 'user_message') {
      pushText(items, { type: 'userMessage', text: displayUserMessage(payload.message || payload.text) });
    } else if (row?.type === 'response_item' && payloadType === 'message') {
      if (payload.role === 'user') {
        pushText(items, { type: 'userMessage', text: displayUserMessage(extractContent(payload.content)) });
      } else if (payload.role === 'assistant') {
        pushText(items, {
          type: 'agentMessage', phase: payload.phase || 'commentary',
          text: displayAssistantMessage(extractContent(payload.content)),
        });
      }
    }
  }
  return items;
}

function pushText(items, item) {
  const text = capText(item.text);
  if (!text) return;
  const previous = items.at(-1);
  if (previous?.type === item.type && previous.phase === item.phase && previous.text === text) return;
  items.push({ ...item, text, status: '', name: '', input: '', output: '' });
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    return item?.text || item?.input_text || item?.output_text || '';
  }).filter(Boolean).join('\n');
}

function capText(value, limit = MAX_TEXT_LENGTH) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断）`;
}

export const internals = {
  capText, extractContent, findLatestActivityBefore, inferRolloutActivity, inferRolloutStatus,
  mapRolloutRows, rolloutCache,
};
