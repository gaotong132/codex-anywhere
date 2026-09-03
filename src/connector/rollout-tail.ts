import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { normalizeToolPurpose, parseAssistantMessage, parseUserMessage } from '../shared/message-content.js';
import type { MessageContext } from '../shared/message-content.js';
import { summarizeToolActivity } from '../shared/activity-detail.js';
import type { ContextCompaction, ContextUsage } from '../shared/context-compaction.js';
import type { TimelineNotice, ToolSummaryNotice } from '../shared/timeline-notice.js';
import { publicError } from '../shared/protocol.js';
import {
  extractPlanProgressFromToolInput,
  summarizePatchChanges,
  summarizePlanSteps,
  summarizeUnifiedDiff,
  type TurnFileProgress,
  type TurnPlanProgress,
} from '../shared/turn-progress.js';
import {
  extractGeneratedImageAttachment,
  type GeneratedImageAttachment,
} from './generated-images.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 80;
const HISTORY_PAGE_BYTES = 512 * 1024;
const ROLLOUT_CURSOR_PREFIX = 'rollout:v1:';
const MAX_TEXT_LENGTH = 4_000;
const ACTIVITY_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const CONTEXT_USAGE_SCAN_CHUNK_BYTES = 256 * 1024;
const ACTIVITY_SCAN_OVERLAP_BYTES = 1_024;
const PLAN_SCAN_OVERLAP_BYTES = 64 * 1024;
const MAX_CACHED_ROLLOUTS = 12;
type RolloutStatus = 'unknown' | 'inProgress' | 'completed' | 'failed';
type RolloutActivity = { status: RolloutStatus; id: string; startedAt: number | null };
type LiveActivityKind = 'starting' | 'planning' | 'command' | 'editing' | 'searching'
  | 'connectedTool' | 'generating' | 'waiting' | 'checking' | 'working';
type LiveActivity = { kind: LiveActivityKind; updatedAt: number | null };
type RolloutProgress = {
  plan?: TurnPlanProgress;
  files?: TurnFileProgress;
  patchFiles: Set<string>;
};
type FileProgressEvent =
  | { kind: 'reset' }
  | { kind: 'replace'; files: TurnFileProgress }
  | { kind: 'patch'; files: TurnFileProgress; paths: string[] };
type RolloutRow = Record<string, any>;
type RolloutItem = {
  type: string;
  turnId?: string;
  phase?: string;
  text: string;
  contexts?: MessageContext[];
  status?: string;
  name?: string;
  input?: string;
  output?: string;
  attachment?: GeneratedImageAttachment;
  fileChanges?: TurnFileProgress;
  compaction?: ContextCompaction;
  notice?: TimelineNotice;
  completedAt?: number | null;
};
type RolloutOptions = {
  filePath: string;
  threadId: string;
  maxBytes?: number;
  maxItems?: number;
  cursor?: string | null;
  paged?: boolean;
};
export type RolloutModelSettings = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
};
type ToolSummaryState = Omit<ToolSummaryNotice, 'kind' | 'total'> & {
  callIds: Set<string>;
  total: number;
  flushed: boolean;
};
type RolloutMappingState = {
  currentTurnId: string;
  settings: RolloutModelSettings;
  tools: ToolSummaryState;
};
type SnapshotOptions = { threadId: string; maxBytes: number; maxItems: number };
type RolloutSnapshot = SnapshotOptions & {
  fileSize: number;
  parsedOffset: number;
  items: RolloutItem[];
  activity: RolloutActivity;
  liveActivity: LiveActivity;
  toolPurpose: string;
  activityDetail: string;
  progress: RolloutProgress;
  mapping: RolloutMappingState;
  contextUsage?: ContextUsage;
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

export async function readRolloutModelSettings(filePath: string): Promise<RolloutModelSettings> {
  const handle = await open(filePath, 'r');
  try {
    return await findLatestModelSettingsBefore(handle, (await handle.stat()).size);
  } finally {
    await handle.close();
  }
}

export async function readRolloutContextUsage(filePath: string): Promise<ContextUsage | undefined> {
  const handle = await open(filePath, 'r');
  try {
    return await findLatestContextUsageBefore(handle, (await handle.stat()).size);
  } finally {
    await handle.close();
  }
}

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
    if (options.paged) {
      return await readHistoryPage(handle, fileStat.size, threadId, options.cursor);
    }
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
      activityDetail: snapshot.activity.status === 'inProgress' ? snapshot.activityDetail : '',
      turnProgress: { plan: snapshot.progress.plan, files: snapshot.progress.files },
      contextUsage: snapshot.contextUsage,
    };
  } finally {
    await handle.close();
  }
}

async function readHistoryPage(
  handle: FileHandle, fileSize: number, threadId: string, encodedCursor?: string | null,
) {
  const endOffset = decodeRolloutCursor(encodedCursor, fileSize);
  const startOffset = Math.max(0, endOffset - HISTORY_PAGE_BYTES);
  const window = await readCompleteRows(handle, startOffset, endOffset, startOffset > 0);
  const activity = encodedCursor
    ? { status: 'completed' as const, id: '', startedAt: null }
    : await activityForHistoryPage(handle, window.rows, window.firstCompleteOffset);
  const nextOffset = window.firstCompleteOffset < endOffset
    ? window.firstCompleteOffset
    : startOffset;
  const nextCursor = nextOffset > 0 ? encodeRolloutCursor(nextOffset) : null;
  const needsPriorProgress = window.firstCompleteOffset > 0
    && (encodedCursor
      ? hasFinalReplyBeforeFirstTaskStart(window.rows)
      : needsInitialFileProgress(window.rows));
  const priorProgress = needsPriorProgress
    ? await findLatestFileProgressBefore(handle, window.firstCompleteOffset)
    : { patchFiles: new Set<string>() };
  const initialTurnId = await initialTurnIdForWindow(handle, window);
  const initialMapping = await mappingStateBefore(handle, window.firstCompleteOffset, initialTurnId);
  const mapped = mapRolloutRowsWithState(window.rows, priorProgress, initialMapping);
  const items = mapped.items;
  const progress = encodedCursor
    ? { patchFiles: new Set<string>() }
    : await progressForHistoryPage(
      handle, window.rows, activity, window.firstCompleteOffset, priorProgress,
    );
  const liveActivity = updateLiveActivity(
    { kind: 'working', updatedAt: activity.startedAt }, window.rows, activity.status,
  );
  return {
    threadId,
    turns: items.length || activity.status !== 'unknown' ? [{
      id: `rollout:${threadId}:${window.firstCompleteOffset}:${endOffset}`,
      status: activity.status,
      startedAt: null,
      completedAt: null,
      items,
    }] : [],
    nextCursor,
    truncated: Boolean(nextCursor),
    source: 'rolloutPage',
    fileSize,
    activityId: activity.id,
    activityKind: activity.status === 'inProgress' ? liveActivity.kind : '',
    activityStartedAt: activity.status === 'inProgress' ? activity.startedAt : null,
    activityUpdatedAt: activity.status === 'inProgress' ? liveActivity.updatedAt : null,
    toolPurpose: activity.status === 'inProgress'
      ? await purposeForHistoryPage(handle, window.rows, activity, window.firstCompleteOffset)
      : '',
    activityDetail: activity.status === 'inProgress' ? updateActivityDetail('', window.rows, activity.status) : '',
    turnProgress: { plan: progress.plan, files: progress.files },
    contextUsage: encodedCursor
      ? undefined
      : latestContextUsage(window.rows) || await findLatestContextUsageBefore(handle, window.firstCompleteOffset),
  };
}

async function activityForHistoryPage(handle: FileHandle, rows: RolloutRow[], firstCompleteOffset: number) {
  const activity = inferRolloutActivity(rows);
  if (activity.status !== 'unknown' || firstCompleteOffset <= 0) return activity;
  return findLatestActivityBefore(handle, firstCompleteOffset);
}

async function progressForHistoryPage(
  handle: FileHandle, rows: RolloutRow[], activity: RolloutActivity, firstCompleteOffset: number,
  recoveredProgress?: RolloutProgress,
) {
  const priorProgress = recoveredProgress || (firstCompleteOffset > 0 && needsInitialFileProgress(rows)
    ? await findLatestFileProgressBefore(handle, firstCompleteOffset)
    : { patchFiles: new Set<string>() });
  const progress = updateTurnProgress(priorProgress, rows, activity.status);
  if (activity.status !== 'unknown' && !progress.plan && firstCompleteOffset > 0) {
    progress.plan = await findLatestPlanBefore(handle, firstCompleteOffset);
  }
  return progress;
}

async function purposeForHistoryPage(
  handle: FileHandle, rows: RolloutRow[], activity: RolloutActivity, firstCompleteOffset: number,
) {
  const purpose = updateToolPurpose('', rows, activity.status);
  if (activity.status !== 'inProgress' || purpose || firstCompleteOffset <= 0) return purpose;
  return findLatestPurposeBefore(handle, firstCompleteOffset);
}

function encodeRolloutCursor(offset: number) {
  return `${ROLLOUT_CURSOR_PREFIX}${offset}`;
}

function decodeRolloutCursor(cursor: string | null | undefined, fileSize: number) {
  if (!cursor) return fileSize;
  if (!cursor.startsWith(ROLLOUT_CURSOR_PREFIX)) throw new Error('invalid_rollout_cursor');
  const value = cursor.slice(ROLLOUT_CURSOR_PREFIX.length);
  if (!/^\d+$/.test(value)) throw new Error('invalid_rollout_cursor');
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > fileSize) {
    throw new Error('invalid_rollout_cursor');
  }
  return offset;
}

async function initializeSnapshot(handle: FileHandle, fileSize: number, options: SnapshotOptions): Promise<RolloutSnapshot> {
  const windowStart = Math.max(0, fileSize - options.maxBytes);
  const window = await readCompleteRows(handle, windowStart, fileSize, windowStart > 0);
  let activity = inferRolloutActivity(window.rows);
  if (activity.status === 'unknown' && window.firstCompleteOffset > 0) {
    activity = await findLatestActivityBefore(handle, window.firstCompleteOffset);
  }
  const priorProgress = window.firstCompleteOffset > 0 && needsInitialFileProgress(window.rows)
    ? await findLatestFileProgressBefore(handle, window.firstCompleteOffset)
    : { patchFiles: new Set<string>() };
  const progress = updateTurnProgress(priorProgress, window.rows, activity.status);
  if (activity.status !== 'unknown' && !progress.plan && window.firstCompleteOffset > 0) {
    progress.plan = await findLatestPlanBefore(handle, window.firstCompleteOffset);
  }
  let toolPurpose = updateToolPurpose('', window.rows, activity.status);
  if (activity.status === 'inProgress' && !toolPurpose && window.firstCompleteOffset > 0) {
    toolPurpose = await findLatestPurposeBefore(handle, window.firstCompleteOffset);
  }
  const initialTurnId = await initialTurnIdForWindow(handle, window);
  const initialMapping = await mappingStateBefore(handle, window.firstCompleteOffset, initialTurnId);
  const mapped = mapRolloutRowsWithState(window.rows, priorProgress, initialMapping);
  return {
    ...options,
    fileSize,
    parsedOffset: window.parsedOffset,
    items: mapped.items.slice(-options.maxItems),
    activity,
    liveActivity: updateLiveActivity({ kind: 'working', updatedAt: activity.startedAt }, window.rows, activity.status),
    toolPurpose,
    activityDetail: updateActivityDetail('', window.rows, activity.status),
    progress,
    mapping: mapped.state,
    contextUsage: latestContextUsage(window.rows)
      || await findLatestContextUsageBefore(handle, window.firstCompleteOffset),
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
  const mapped = mapRolloutRowsWithState(appended.rows, cached.progress, cached.mapping);
  return {
    ...cached,
    fileSize,
    parsedOffset: appended.parsedOffset,
    items: appendItems(
      cached.items,
      mapped.items,
      cached.maxItems,
    ),
    activity,
    liveActivity: updateLiveActivity(cached.liveActivity, appended.rows, activity.status),
    toolPurpose: updateToolPurpose(cached.toolPurpose, appended.rows, activity.status),
    activityDetail: updateActivityDetail(cached.activityDetail, appended.rows, activity.status),
    progress: updateTurnProgress(cached.progress, appended.rows, activity.status),
    mapping: mapped.state,
    contextUsage: latestContextUsage(appended.rows) || cached.contextUsage,
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

async function initialTurnIdForWindow(handle: FileHandle, window: CompleteRows) {
  if (window.firstCompleteOffset <= 0 || !hasVisibleRowsBeforeFirstTaskStart(window.rows)) return '';
  return (await findLatestActivityBefore(handle, window.firstCompleteOffset)).id;
}

function hasVisibleRowsBeforeFirstTaskStart(rows: RolloutRow[]) {
  for (const row of rows) {
    if (String(row?.payload?.type || '') === 'task_started') return false;
    if (isVisibleRolloutRow(row)) return true;
  }
  return false;
}

function isVisibleRolloutRow(row: RolloutRow) {
  const payload = row?.payload || {};
  const type = String(payload.type || '');
  return Boolean(
    delegatedUserMessage(row)
    || row?.type === 'compacted'
    || row?.type === 'turn_context'
    || (row?.type === 'event_msg' && /^(?:agent_message|user_message|image_generation_end)$/.test(type))
    || (row?.type === 'event_msg' && /^(?:thread_settings_applied|task_failed|turn_aborted|turn_error)$/.test(type))
    || (row?.type === 'response_item' && type === 'message')
    || toolCallFromRow(row)
    || (type === 'task_complete' && fullText(payload.last_agent_message).trim()),
  );
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

async function findLatestPlanBefore(handle: FileHandle, endOffset: number): Promise<TurnPlanProgress | undefined> {
  const lowerBound = 0;
  const planNeedle = Buffer.from('tools.update_plan');
  const taskNeedle = Buffer.from('"type":"task_started"');
  let cursor = endOffset;
  while (cursor > lowerBound) {
    const start = Math.max(lowerBound, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const readEnd = Math.min(endOffset, cursor + PLAN_SCAN_OVERLAP_BYTES);
    const buffer = Buffer.alloc(readEnd - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const data = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    const taskIndex = data.lastIndexOf(taskNeedle);
    let planIndex = data.lastIndexOf(planNeedle);
    while (planIndex >= 0) {
      const prefix = data.subarray(Math.max(0, planIndex - 96), planIndex).toString('utf8');
      if (!/"input":"const\s+\w+\s*=\s*await\s*$/.test(prefix)) {
        planIndex = data.lastIndexOf(planNeedle, planIndex - 1);
        continue;
      }
      const lineStart = data.lastIndexOf(0x0a, Math.max(0, planIndex - 1)) + 1;
      const nextNewline = data.indexOf(0x0a, planIndex);
      const lineEnd = nextNewline < 0 ? data.length : nextNewline;
      const plan = planProgressFromRow(parseRow(data.subarray(lineStart, lineEnd).toString('utf8')));
      if (plan) {
        if (taskIndex > planIndex) return undefined;
        return plan;
      }
      planIndex = data.lastIndexOf(planNeedle, planIndex - 1);
    }
    if (taskIndex >= 0) return undefined;
    cursor = start;
  }
  return undefined;
}

async function findLatestFileProgressBefore(handle: FileHandle, endOffset: number): Promise<RolloutProgress> {
  const chunks: FileProgressEvent[][] = [];
  let cursor = endOffset;
  while (cursor > 0) {
    const start = Math.max(0, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const window = await readCompleteRows(handle, start, cursor, start > 0);
    let taskStartIndex = -1;
    for (let index = window.rows.length - 1; index >= 0; index -= 1) {
      if (String(window.rows[index]?.payload?.type || '') !== 'task_started') continue;
      taskStartIndex = index;
      break;
    }
    const relevantRows = taskStartIndex >= 0 ? window.rows.slice(taskStartIndex) : window.rows;
    const events = relevantRows.map(fileProgressEvent).filter((event): event is FileProgressEvent => Boolean(event));
    if (events.length) chunks.push(events);
    if (taskStartIndex >= 0 || start === 0) break;
    cursor = window.firstCompleteOffset < cursor ? window.firstCompleteOffset : start;
  }

  let progress: RolloutProgress = { patchFiles: new Set() };
  for (const events of chunks.reverse()) {
    for (const event of events) progress = applyFileProgressEvent(progress, event);
  }
  return progress;
}

async function findLatestPurposeBefore(handle: FileHandle, endOffset: number): Promise<string> {
  let cursor = endOffset;
  while (cursor > 0) {
    const start = Math.max(0, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const readEnd = Math.min(endOffset, cursor + PLAN_SCAN_OVERLAP_BYTES);
    const window = await readCompleteRows(handle, start, readEnd, start > 0);
    for (let index = window.rows.length - 1; index >= 0; index -= 1) {
      const payload = window.rows[index]?.payload || {};
      const type = String(payload.type || '');
      if (type === 'task_started' || /task_complete|task_failed|turn_aborted|turn_error/.test(type)) return '';
      if (type === 'agent_reasoning' || type === 'reasoning' || /Reasoning/i.test(String(payload.item?.type || ''))) {
        const purpose = reasoningSummary(payload);
        if (purpose) return purpose;
      }
    }
    cursor = start;
  }
  return '';
}

async function findLatestModelSettingsBefore(
  handle: FileHandle, endOffset: number,
): Promise<RolloutModelSettings> {
  const settings: RolloutModelSettings = {};
  let cursor = endOffset;
  while (cursor > 0) {
    const start = Math.max(0, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const readEnd = Math.min(endOffset, cursor + PLAN_SCAN_OVERLAP_BYTES);
    const window = await readCompleteRows(handle, start, readEnd, start > 0);
    for (let index = window.rows.length - 1; index >= 0; index -= 1) {
      const rowSettings = modelSettingsFromRow(window.rows[index]);
      if (!rowSettings) continue;
      settings.model ||= rowSettings.model;
      settings.reasoningEffort ||= rowSettings.reasoningEffort;
      settings.serviceTier ||= rowSettings.serviceTier;
      if (settings.model && settings.reasoningEffort && settings.serviceTier) return settings;
    }
    cursor = start;
  }
  return settings;
}

function modelSettingsFromRow(row: RolloutRow): RolloutModelSettings | undefined {
  const payload = row?.payload || {};
  const source = row?.type === 'turn_context'
    ? payload
    : payload.type === 'thread_settings_applied' ? payload.thread_settings || {} : null;
  if (!source) return undefined;
  const model = String(source.model || '').trim();
  const reasoningEffort = String(
    source.reasoning_effort || source.effort || source.collaboration_mode?.settings?.reasoning_effort || '',
  ).trim();
  const serviceTier = String(source.service_tier || '').trim();
  if (!model && !reasoningEffort && !serviceTier) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
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
    const payload = row.payload || {};
    const type = String(payload.type || '');
    if (type === 'task_started' || /task_complete|task_failed|turn_aborted|turn_error/.test(type)) {
      purpose = '';
    } else if (type === 'agent_reasoning' || type === 'reasoning' || /Reasoning/i.test(String(payload.item?.type || ''))) {
      purpose = reasoningSummary(payload) || purpose;
    }
  }
  return status === 'inProgress' ? purpose : '';
}

function updateActivityDetail(current: string, rows: RolloutRow[], status: RolloutStatus) {
  let detail = current;
  for (const row of rows) {
    const payload = row.payload || {};
    const type = String(payload.type || '');
    if (type === 'task_started' || /task_complete|task_failed|turn_aborted|turn_error/.test(type)) {
      detail = '';
      continue;
    }
    const next = summarizeToolActivity(payload);
    if (next) detail = /(?:_end|completed)$/i.test(type) ? `✓ ${next}` : next;
    else if (/custom_tool_call_output|function_call_output/i.test(type) && detail && !detail.startsWith('✓ ')) {
      detail = `✓ ${detail}`;
    }
  }
  return status === 'inProgress' ? detail : '';
}

function reasoningSummary(payload: RolloutRow) {
  const candidates = [payload.text, payload.summary_text, payload.item?.summary_text, payload.summary, payload.item?.summary];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const summary = normalizeToolPurpose(value);
      if (summary) return summary;
    }
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const text = typeof entry === 'string' ? entry : entry?.text;
      const summary = normalizeToolPurpose(text);
      if (summary) return summary;
    }
  }
  return '';
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

function updateTurnProgress(current: RolloutProgress, rows: RolloutRow[], status: RolloutStatus): RolloutProgress {
  let progress: RolloutProgress = {
    plan: current.plan,
    files: current.files,
    patchFiles: new Set(current.patchFiles),
  };
  for (const row of rows) {
    const payload = row?.payload || {};
    const type = String(payload.type || '');
    if (type === 'task_started') {
      progress = { patchFiles: new Set() };
      continue;
    }
    if (/task_complete|task_failed|turn_aborted|turn_error/.test(type)) continue;
    const structuredPlan = summarizePlanSteps(payload.plan);
    if (structuredPlan) progress.plan = structuredPlan;
    const fileEvent = fileProgressEvent(row);
    if (fileEvent) progress = applyFileProgressEvent(progress, fileEvent);
    const plan = planProgressFromRow(row);
    if (plan) progress.plan = plan;
  }
  return status === 'unknown' ? { patchFiles: new Set() } : progress;
}

function fileProgressEvent(row: RolloutRow): FileProgressEvent | undefined {
  const payload = row?.payload || {};
  const type = String(payload.type || '');
  if (type === 'task_started') return { kind: 'reset' };
  const structuredDiff = summarizeUnifiedDiff(payload.diff);
  if (structuredDiff) return { kind: 'replace', files: structuredDiff };
  const changes = type === 'patch_apply_end' && payload.success !== false
    ? payload.changes
    : type === 'item_completed' && /FileChange/i.test(String(payload.item?.type || ''))
      ? payload.item?.changes
      : undefined;
  const patch = summarizePatchChanges(changes);
  return patch ? { kind: 'patch', files: patch, paths: patch.paths } : undefined;
}

function applyFileProgressEvent(current: RolloutProgress, event: FileProgressEvent): RolloutProgress {
  if (event.kind === 'reset') return { patchFiles: new Set() };
  if (event.kind === 'replace') {
    return { ...current, files: event.files, patchFiles: new Set() };
  }
  const patchFiles = new Set(current.patchFiles);
  for (const path of event.paths) patchFiles.add(path);
  return {
    ...current,
    patchFiles,
    files: {
      changed: patchFiles.size || event.files.changed,
      additions: (current.files?.additions || 0) + event.files.additions,
      deletions: (current.files?.deletions || 0) + event.files.deletions,
    },
  };
}

function planProgressFromRow(row: RolloutRow | null) {
  const payload = row?.payload || {};
  const type = String(payload.type || '');
  if (row?.type !== 'response_item' || !/custom_tool_call|function_call/.test(type)) return undefined;
  const name = String(payload.name || '').toLowerCase();
  const input = String(payload.input || payload.arguments || '');
  const isPlanCall = name === 'update_plan'
    || (name === 'exec' && /^\s*const\s+\w+\s*=\s*await\s+tools\.update_plan\s*\(/.test(input));
  return isPlanCall ? extractPlanProgressFromToolInput(input) : undefined;
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

async function mappingStateBefore(
  handle: FileHandle, endOffset: number, currentTurnId = '',
): Promise<RolloutMappingState> {
  if (endOffset <= 0) return {
    currentTurnId,
    settings: {},
    tools: emptyToolSummary(),
  };
  const [settings, tools] = await Promise.all([
    findLatestModelSettingsBefore(handle, endOffset),
    findCurrentToolSummaryBefore(handle, endOffset),
  ]);
  return { currentTurnId, settings, tools };
}

async function findCurrentToolSummaryBefore(handle: FileHandle, endOffset: number) {
  let cursor = endOffset;
  const summary = emptyToolSummary();
  while (cursor > 0) {
    const start = Math.max(0, cursor - ACTIVITY_SCAN_CHUNK_BYTES);
    const window = await readCompleteRows(handle, start, cursor, start > 0);
    for (let index = window.rows.length - 1; index >= 0; index -= 1) {
      const row = window.rows[index];
      const type = String(row?.payload?.type || '');
      if (/task_complete|task_failed|turn_aborted|turn_error/.test(type)) return emptyToolSummary();
      if (type === 'task_started') return summary;
      if (isFinalAssistantRow(row)) summary.flushed = true;
      addToolCall(summary, row);
    }
    if (start === 0) break;
    cursor = window.firstCompleteOffset < cursor ? window.firstCompleteOffset : start;
  }
  return summary;
}

function emptyToolSummary(): ToolSummaryState {
  return { total: 0, callIds: new Set(), flushed: false };
}

function cloneToolSummary(summary?: ToolSummaryState): ToolSummaryState {
  return summary ? { ...summary, callIds: new Set(summary.callIds) } : emptyToolSummary();
}

function addToolCall(summary: ToolSummaryState, row: RolloutRow) {
  const payload = row?.payload || {};
  const payloadType = String(payload.type || '');
  const item = row?.type === 'response_item' && /^(?:custom_tool_call|function_call)$/i.test(payloadType)
    ? payload
    : row?.type === 'event_msg' && payloadType === 'item_started'
      ? payload.item || {}
      : null;
  const itemType = String(item?.type || '');
  if (!item || (row?.type === 'event_msg'
    && !/commandExecution|toolCall|webSearch|fileChange|mcpTool/i.test(itemType))) return;
  const detail = summarizeToolActivity(item);
  const label = detail.split(' · ')[0]?.trim().toLowerCase() || '';
  if (!label || /^(?:update_plan|wait|request_user_input)$/.test(label)) return;
  const fallbackId = `${row?.timestamp || ''}:${itemType}:${item?.name || ''}:${summary.total}`;
  const callId = String(item.call_id || item.callId || item.id || fallbackId);
  if (summary.callIds.has(callId)) return;
  summary.callIds.add(callId);
  summary.total += 1;
  const field = /exec_command|command/.test(label) ? 'commands'
    : /apply_patch|file.?change|patch/.test(label) ? 'edits'
      : /web|search/.test(label) ? 'searches'
        : /image.?gen/.test(label) ? 'generations'
          : /mcp/.test(label) ? 'connectedTools'
            : 'other';
  summary[field] = (summary[field] || 0) + 1;
}

function toolSummaryNotice(summary: ToolSummaryState): ToolSummaryNotice | undefined {
  if (!summary.total || summary.flushed) return undefined;
  return {
    kind: 'toolSummary',
    total: summary.total,
    ...(summary.commands ? { commands: summary.commands } : {}),
    ...(summary.edits ? { edits: summary.edits } : {}),
    ...(summary.searches ? { searches: summary.searches } : {}),
    ...(summary.connectedTools ? { connectedTools: summary.connectedTools } : {}),
    ...(summary.generations ? { generations: summary.generations } : {}),
    ...(summary.other ? { other: summary.other } : {}),
  };
}

function changedModelSettings(
  previous: RolloutModelSettings, next: RolloutModelSettings,
): RolloutModelSettings | undefined {
  const changed: RolloutModelSettings = {};
  if (next.model && previous.model && next.model !== previous.model) changed.model = next.model;
  if (next.reasoningEffort && previous.reasoningEffort
    && next.reasoningEffort !== previous.reasoningEffort) changed.reasoningEffort = next.reasoningEffort;
  if (next.serviceTier && previous.serviceTier && next.serviceTier !== previous.serviceTier) {
    changed.serviceTier = next.serviceTier;
  }
  return Object.keys(changed).length ? changed : undefined;
}

function turnStatusNotice(payload: RolloutRow): TimelineNotice | undefined {
  const type = String(payload.type || '');
  if (!/task_failed|turn_aborted|turn_error/.test(type)) return undefined;
  const status = type === 'turn_aborted' ? 'aborted' : type === 'turn_error' ? 'error' : 'failed';
  const detailValue = payload.error?.message || payload.error || payload.message || payload.reason;
  const rawDetail = typeof detailValue === 'string'
    ? detailValue.replace(/[\0\r]+/g, ' ').trim()
    : '';
  const detail = rawDetail ? capText(publicError(rawDetail), 500) : '';
  return { kind: 'turnStatus', status, ...(detail ? { detail } : {}) };
}

function mapRolloutRows(
  rows: RolloutRow[], initialProgress?: RolloutProgress, initialTurnId = '',
): RolloutItem[] {
  return mapRolloutRowsWithState(rows, initialProgress, {
    currentTurnId: initialTurnId,
    settings: {},
    tools: emptyToolSummary(),
  }).items;
}

function mapRolloutRowsWithState(
  rows: RolloutRow[], initialProgress?: RolloutProgress, initialState?: RolloutMappingState,
) {
  const items: RolloutItem[] = [];
  let progress: RolloutProgress = initialProgress
    ? { ...initialProgress, patchFiles: new Set(initialProgress.patchFiles) }
    : { patchFiles: new Set() };
  let turnItemStart = 0;
  let currentTurnId = initialState?.currentTurnId || '';
  let settings = { ...(initialState?.settings || {}) };
  let tools = cloneToolSummary(initialState?.tools);
  const flushToolSummary = (turn: { turnId?: string }, timing: { completedAt?: number }) => {
    const notice = toolSummaryNotice(tools);
    if (!notice) return;
    pushText(items, { type: 'timelineNotice', text: '', notice, ...turn, ...timing });
    tools.flushed = true;
  };
  for (const [rowIndex, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const payload = row?.payload || {};
    const payloadType = String(payload.type || '');
    currentTurnId = rolloutRowTurnId(row) || currentTurnId;
    const turn = currentTurnId ? { turnId: currentTurnId } : {};
    if (payloadType === 'task_started') {
      turnItemStart = items.length;
      tools = emptyToolSummary();
    }
    addToolCall(tools, row);
    const progressEvent = fileProgressEvent(row);
    if (progressEvent) progress = applyFileProgressEvent(progress, progressEvent);
    const completedAt = epochMillis(row.timestamp);
    const timing = completedAt ? { completedAt } : {};
    const nextSettings = modelSettingsFromRow(row);
    if (nextSettings) {
      const changed = changedModelSettings(settings, nextSettings);
      settings = { ...settings, ...nextSettings };
      if (changed) {
        pushText(items, {
          type: 'timelineNotice', text: '', notice: { kind: 'modelSettings', ...changed },
          ...turn, ...timing,
        });
      }
    }
    const delegatedMessage = delegatedUserMessage(row);
    if (delegatedMessage) {
      pushText(items, { type: 'userMessage', ...delegatedMessage, ...turn, ...timing });
    } else if (row?.type === 'compacted') {
      const compaction = contextCompactionFromRows(rows, rowIndex);
      if (compaction) {
        pushText(items, { type: 'contextCompaction', text: '', compaction, ...turn, ...timing });
      }
    } else if (row?.type === 'event_msg' && payloadType === 'agent_message') {
      const content = parseAssistantMessage(payload.message);
      if (payload.phase === 'final_answer') flushToolSummary(turn, timing);
      pushText(items, {
        type: 'agentMessage', phase: payload.phase || 'commentary', ...content,
        ...finalFileChanges(payload.phase, progress), ...turn, ...timing,
      });
    } else if (row?.type === 'event_msg' && payloadType === 'user_message') {
      pushText(items, {
        type: 'userMessage', ...parseUserMessage(payload.message || payload.text), ...turn, ...timing,
      });
    } else if (row?.type === 'response_item' && payloadType === 'message') {
      if (payload.role === 'user') {
        pushText(items, {
          type: 'userMessage', ...parseUserMessage(extractContent(payload.content)), ...turn, ...timing,
        });
      } else if (payload.role === 'assistant') {
        const content = parseAssistantMessage(extractContent(payload.content));
        if (payload.phase === 'final_answer') flushToolSummary(turn, timing);
        pushText(items, {
          type: 'agentMessage', phase: payload.phase || 'commentary',
          ...content, ...finalFileChanges(payload.phase, progress), ...turn, ...timing,
        });
      }
    } else if (row?.type === 'event_msg' && payloadType === 'image_generation_end') {
      const attachment = extractGeneratedImageAttachment(payload);
      if (payload.status === 'completed' && attachment) {
        pushText(items, {
          type: 'agentMessage', phase: 'final_answer', text: '', attachment, ...turn, ...timing,
        });
      }
    }
    if (/task_complete|task_failed|turn_aborted|turn_error/.test(payloadType)) {
      flushToolSummary(turn, timing);
      const notice = turnStatusNotice(payload);
      if (notice) pushText(items, { type: 'timelineNotice', text: '', notice, ...turn, ...timing });
    }
    if (payloadType === 'task_complete') {
      const finalText = fullText(payload.last_agent_message).trim();
      if (finalText) {
        const parsed = parseAssistantMessage(finalText);
        const alreadyPresent = items.slice(turnItemStart).some((item) => (
          item.type === 'agentMessage'
          && item.phase === 'final_answer'
          && item.text === parsed.text
        ));
        if (!alreadyPresent) {
          pushText(items, {
            type: 'agentMessage', phase: 'final_answer', ...parsed,
            ...finalFileChanges('final_answer', progress), ...turn, ...timing,
          });
        }
      }
    }
    if (payloadType === 'task_complete' && progress.files) {
      for (let index = items.length - 1; index >= turnItemStart; index -= 1) {
        if (items[index]?.type !== 'agentMessage' || items[index]?.phase !== 'final_answer') continue;
        items[index].fileChanges = progress.files;
        break;
      }
    }
  }
  return {
    items,
    state: { currentTurnId, settings, tools },
  };
}

function rolloutRowTurnId(row: RolloutRow) {
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

function delegatedUserMessage(row: RolloutRow) {
  const payload = row?.payload || {};
  const item = row?.type === 'response_item'
    && /^(?:function_call_output|custom_tool_call_output)$/i.test(String(payload.type || ''))
    ? payload
    : row?.type === 'event_msg'
      && String(payload.type || '') === 'item_completed'
      && /^(?:FunctionCallOutput|CustomToolCallOutput)$/i.test(String(payload.item?.type || ''))
      ? payload.item
      : null;
  if (!item || String(item.name || '') !== 'send_message_to_thread' || typeof item.output !== 'string') {
    return null;
  }
  const content = parseUserMessage(item.output);
  return content.text && content.contexts.some((context) => context.kind === 'delegation') ? content : null;
}

function isFinalAssistantRow(row: RolloutRow) {
  const payload = row?.payload || {};
  return (row?.type === 'event_msg' && payload.type === 'agent_message' && payload.phase === 'final_answer')
    || (row?.type === 'response_item' && payload.type === 'message'
      && payload.role === 'assistant' && payload.phase === 'final_answer');
}

function needsInitialFileProgress(rows: RolloutRow[]) {
  const taskStartIndex = rows.findIndex((row) => String(row?.payload?.type || '') === 'task_started');
  return taskStartIndex < 0 || hasFinalReplyBeforeFirstTaskStart(rows, taskStartIndex);
}

function hasFinalReplyBeforeFirstTaskStart(rows: RolloutRow[], knownTaskStartIndex?: number) {
  const taskStartIndex = knownTaskStartIndex ?? rows.findIndex(
    (row) => String(row?.payload?.type || '') === 'task_started',
  );
  const firstFinalIndex = rows.findIndex(isFinalAssistantRow);
  return firstFinalIndex >= 0 && (taskStartIndex < 0 || firstFinalIndex < taskStartIndex);
}

function finalFileChanges(phase: unknown, progress: RolloutProgress) {
  return phase === 'final_answer' && progress.files ? { fileChanges: progress.files } : {};
}

function pushText(items: RolloutItem[], item: RolloutItem) {
  const text = item.phase === 'final_answer' ? fullText(item.text) : capText(item.text);
  if (!text && !item.attachment && !item.compaction && !item.notice) return;
  const previous = items.at(-1);
  if (previous?.type === item.type
    && previous.turnId === item.turnId
    && previous.phase === item.phase
    && previous.text === text
    && previous.attachment?.path === item.attachment?.path
    && JSON.stringify(previous.compaction) === JSON.stringify(item.compaction)
    && JSON.stringify(previous.notice) === JSON.stringify(item.notice)
    && JSON.stringify(previous.contexts || []) === JSON.stringify(item.contexts || [])) {
    if (item.fileChanges) previous.fileChanges = item.fileChanges;
    return;
  }
  items.push({ ...item, text, status: '', name: '', input: '', output: '' });
}

function toolCallFromRow(row: RolloutRow) {
  const payload = row?.payload || {};
  const type = String(payload.type || '');
  return (row?.type === 'response_item' && /^(?:custom_tool_call|function_call)$/i.test(type))
    || (row?.type === 'event_msg' && type === 'item_started'
      && /commandExecution|toolCall|webSearch|fileChange|mcpTool/i.test(String(payload.item?.type || '')));
}

function contextCompactionFromRows(rows: RolloutRow[], index: number): ContextCompaction | undefined {
  const payload = rows[index]?.payload || {};
  const sequence = positiveInteger(payload.window_number);
  if (!sequence) return undefined;
  const before = nearbyTokenCount(rows, index, -1);
  const after = nearbyTokenCount(rows, index, 1);
  const contextWindow = after?.contextWindow || before?.contextWindow;
  return {
    sequence,
    ...(contextWindow ? { contextWindow } : {}),
    ...(before?.tokens !== undefined ? { beforeTokens: before.tokens } : {}),
    ...(after?.tokens !== undefined ? { afterTokens: after.tokens } : {}),
  };
}

function nearbyTokenCount(rows: RolloutRow[], start: number, direction: -1 | 1) {
  for (let distance = 1; distance <= 8; distance += 1) {
    const row = rows[start + distance * direction];
    if (!row) break;
    const payload = row.payload || {};
    if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info || {};
    const tokens = nonNegativeInteger(info.last_token_usage?.total_tokens);
    const contextWindow = positiveInteger(info.model_context_window);
    if (tokens === undefined && !contextWindow) return undefined;
    return { tokens, contextWindow };
  }
  return undefined;
}

function latestContextUsage(rows: RolloutRow[]): ContextUsage | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const usage = contextUsageFromRow(rows[index]);
    if (usage) return usage;
  }
  return undefined;
}

async function findLatestContextUsageBefore(handle: FileHandle, endOffset: number) {
  let cursor = endOffset;
  while (cursor > 0) {
    const start = Math.max(0, cursor - CONTEXT_USAGE_SCAN_CHUNK_BYTES);
    const window = await readCompleteRows(handle, start, cursor, start > 0);
    const usage = latestContextUsage(window.rows);
    if (usage) return usage;
    if (start === 0) break;
    cursor = window.firstCompleteOffset < cursor ? window.firstCompleteOffset : start;
  }
  return undefined;
}

function contextUsageFromRow(row: RolloutRow): ContextUsage | undefined {
  const payload = row?.payload || {};
  if (row?.type !== 'event_msg' || payload.type !== 'token_count') return undefined;
  const info = payload.info || {};
  const tokens = nonNegativeInteger(info.last_token_usage?.total_tokens);
  const contextWindow = positiveInteger(info.model_context_window);
  if (tokens === undefined && !contextWindow) return undefined;
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    updatedAt: epochMillis(row.timestamp),
  };
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function fullText(value: unknown) {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
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
  const text = fullText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断）`;
}

export const internals = {
  activityKind, capText, decodeRolloutCursor, delegatedUserMessage, encodeRolloutCursor,
  epochMillis, extractContent, fullText,
  findLatestActivityBefore, findLatestFileProgressBefore, findLatestModelSettingsBefore,
  findLatestPlanBefore, findLatestPurposeBefore,
  inferRolloutActivity,
  inferRolloutStatus, mapRolloutRows, mapRolloutRowsWithState, recoverGeneratedImageRows,
  rolloutCache, rolloutRowTurnId,
  contextCompactionFromRows,
  contextUsageFromRow, latestContextUsage,
  updateLiveActivity,
  reasoningSummary, updateActivityDetail, updateToolPurpose,
  updateTurnProgress,
};
