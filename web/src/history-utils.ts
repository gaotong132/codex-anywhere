import { t } from './i18n';
import { matchCompactionSnapshots } from './compaction-timeline';
import {
  parseAssistantMessage,
  parseUserMessage,
  mergeMessageContexts,
  stripImageAttachments,
} from '../../src/shared/message-content';
import type { MessageContext } from '../../src/shared/message-content';
import {
  normalizeContextCompaction,
  type ContextCompaction,
} from '../../src/shared/context-compaction';
import {
  normalizeTimelineNotice,
  type TimelineNotice,
} from '../../src/shared/timeline-notice';
import { normalizeTurnProgress, type TurnFileProgress } from '../../src/shared/turn-progress';
import { localFileName, localFilePathFromHref } from './file-utils';
import {
  normalizeAsyncQuestions, normalizeQuestionReplies, questionReplyText,
  type AsyncQuestion, type QuestionReply,
} from '../../src/shared/async-questions';

export { parseAssistantMessage } from '../../src/shared/message-content';

const ATTACHMENT_STORAGE_KEY = 'bridge.knownAttachments.v2';
const LOCAL_MARKDOWN_IMAGE_PATTERN = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|((?:file:\/\/\/|[A-Za-z]:[\\/])[^)\r\n]+))\s*\)/i;
const VISUALIZATION_MARKER_PATTERN = /(?:^|\r?\n)[ \t]*(?:visualize[ \t]+|\uE200visualize\uE202)\{[^\r\n{}]*"path"\s*:\s*("(?:\\.|[^"\\])*")[^\r\n{}]*\}[ \t]*(?:\uE201)?[ \t]*(?=\r?\n|$)/i;

type TurnItem = {
  questions?: AsyncQuestion[];
  questionReplies?: QuestionReply[];
  type?: string;
  turnId?: string;
  phase?: string;
  status?: string;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  contexts?: MessageContext[];
  attachment?: ImageAttachment;
  fileChanges?: TurnFileProgress;
  compaction?: ContextCompaction;
  notice?: TimelineNotice;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  completedAt?: number | string | null;
  timestamp?: number | string | null;
};

export type Turn = {
  id: string;
  status?: string;
  startedAt?: number | string | null;
  completedAt?: number | string | null;
  items?: TurnItem[];
};

export type TimelineKind = 'user' | 'assistant' | 'progress' | 'system' | 'error';
export type ImageAttachment = { path: string; name: string; source?: 'generated' | 'local' };
export type VisualizationArtifact = { path: string; name: string; source: 'visualize' };
export type TimelineItem = {
  compactionProgress?: { startedAt: number; status: 'inProgress' | 'completed' };
  questions?: AsyncQuestion[];
  questionReplies?: QuestionReply[];
  id: string;
  kind: TimelineKind;
  text: string;
  historyTurnId?: string;
  historySource?: 'appServer' | 'rollout';
  transient?: boolean;
  attachment?: ImageAttachment;
  visualization?: VisualizationArtifact;
  compaction?: ContextCompaction;
  notice?: TimelineNotice;
  contexts?: MessageContext[];
  completedAt?: number | string | null;
  fileChanges?: TurnFileProgress;
  // Keep message boundaries when a process block spans history pages.
  progressParts?: { text: string; completedAt?: number | string | null }[];
};
export type KnownAttachment = ImageAttachment & { savedAt: number };

export function acknowledgeOptimisticUser(items: TimelineItem[], id: string, sentAt: number) {
  // History may arrive before the send response and adopt the optimistic ID.
  // Never replace its persisted timestamp with the later receipt time.
  return items.map(item => item.id === id && item.kind === 'user' && item.transient
    ? { ...item, completedAt: sentAt } : item);
}

export function isDuplicateFinalProgress(progressText: string, assistantText: string) {
  const progress = canonicalMessageText(progressText);
  return Boolean(progress) && progress === canonicalMessageText(assistantText);
}

export function appendUniqueTimelineError(items: TimelineItem[], item: TimelineItem) {
  const previous = items.at(-1);
  if (item.kind === 'error' && previous?.kind === 'error' && previous.text === item.text) return items;
  return [...items, item];
}

export function appendStreamedMessageText(current: string, delta: string, newItem: boolean) {
  if (!newItem || !current || !delta) return `${current}${delta}`;
  const trailingNewlines = current.match(/\n*$/)?.[0].length || 0;
  const leadingNewlines = delta.match(/^\n*/)?.[0].length || 0;
  return `${current}${'\n'.repeat(Math.max(0, 2 - trailingNewlines - leadingNewlines))}${delta}`;
}

export function latestTurnProgressItemId(items: TimelineItem[]) {
  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  for (let index = items.length - 1; index > latestUserIndex; index -= 1) {
    const item = items[index];
    if (item?.kind === 'progress' && item.text.trim()) return item.id;
  }
  return null;
}

export function attachLatestAssistantFileChanges(items: TimelineItem[], progress: unknown) {
  const files = normalizeTurnProgress(progress).files;
  if (!files) return items;
  let latestUserIndex = -1;
  let assistantIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (assistantIndex < 0 && items[index]?.kind === 'assistant' && items[index]?.text.trim()) {
      assistantIndex = index;
    }
    if (items[index]?.kind === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (assistantIndex <= latestUserIndex) return items;
  return items.map((item, index) => index === assistantIndex ? { ...item, fileChanges: files } : item);
}

export function historyItems(turns: Turn[], source?: string) {
  const historySource = source === 'appServer' ? 'appServer'
    : source === 'rolloutTail' || source === 'rolloutPage' ? 'rollout' : undefined;
  const items: TimelineItem[] = [];
  for (const turn of [...(turns || [])].reverse()) {
    for (const [index, item] of (turn.items || []).entries()) {
      const type = item.type || '';
      const rawText = item.text?.trim();
      const userItem = /user/i.test(type);
      const localMarkdownImage = userItem ? undefined : extractLocalMarkdownImage(rawText || '');
      const visualization = userItem ? undefined : extractVisualizationArtifact(rawText || '');
      const attachment = item.attachment
        || (userItem
          ? extractImageAttachment(rawText || '')
          : localMarkdownImage);
      let presentationText = rawText || '';
      if (localMarkdownImage && attachment === localMarkdownImage) {
        presentationText = stripLocalMarkdownImage(presentationText);
      }
      if (visualization) presentationText = stripVisualizationMarker(presentationText);
      const content = userItem
        ? parseUserMessage(rawText || '')
        : parseAssistantMessage(presentationText);
      const questions = normalizeAsyncQuestions(item.questions);
      const questionReplies = normalizeQuestionReplies(item.questionReplies) || content.questionReplies;
      const text = questionReplies ? questionReplyText(questionReplies) : content.text;
      const historyTurnId = item.turnId?.trim() || turn.id;
      const compaction = type === 'contextCompaction'
        ? normalizeContextCompaction(item.compaction)
        : undefined;
      const notice = type === 'timelineNotice'
        ? normalizeTimelineNotice(item.notice)
        : undefined;
      let kind: TimelineKind | null = null;
      const displayText = questions ? questions.map((question) => question.title).join('\n\n') : text || '';
      if (questions) kind = 'assistant';
      else if (compaction || notice) kind = 'system';
      else if (/user/i.test(type) && (text || attachment)) kind = 'user';
      else if (/agent|assistant|message/i.test(type) && (text || attachment || visualization)) {
        kind = !item.phase || item.phase === 'final_answer' ? 'assistant' : 'progress';
      }
      if (!kind || (!displayText && !attachment && !visualization && !compaction && !notice)) continue;
      const previous = items.at(-1);
      if (kind === 'progress' && !visualization && !attachment
        && previous?.kind === 'progress' && !previous.attachment && !previous.visualization && previous.historyTurnId === historyTurnId) {
        previous.progressParts ||= [{ text: previous.text, completedAt: previous.completedAt }];
        previous.progressParts.push({ text: displayText, completedAt: messageTime(item, turn, kind) });
        previous.text = `${previous.text}\n\n${displayText}`;
        previous.completedAt = messageTime(item, turn, kind) || previous.completedAt;
        continue;
      }
      const completedAt = messageTime(item, turn, kind);
      const fileChanges = kind === 'assistant'
        ? normalizeTurnProgress({ files: item.fileChanges }).files
        : undefined;
      items.push({
        id: `history:${turn.id}:${index}`,
        kind,
        text: displayText,
        historyTurnId,
        ...(historySource ? { historySource } : {}),
        attachment,
        ...(visualization ? { visualization } : {}),
        ...(compaction ? { compaction } : {}),
        ...(notice ? { notice } : {}),
        ...(questions ? { questions } : {}),
        ...(questionReplies ? { questionReplies } : {}),
        contexts: mergeMessageContexts(item.contexts, content.contexts),
        ...(completedAt ? { completedAt } : {}),
        ...(fileChanges ? { fileChanges } : {}),
      });
    }
  }
  return items;
}

function extractLocalMarkdownImage(text: string): ImageAttachment | undefined {
  const image = LOCAL_MARKDOWN_IMAGE_PATTERN.exec(text);
  const rawHref = (image?.[2] || image?.[3] || '')
    .replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '')
    .trim();
  const path = localFilePathFromHref(rawHref);
  if (!path || !/\.(?:jpe?g|png|webp)$/i.test(path)) return undefined;
  return {
    path,
    name: image?.[1]?.trim() || localFileName(path),
    source: 'local',
  };
}

function stripLocalMarkdownImage(text: string) {
  return text
    .replace(LOCAL_MARKDOWN_IMAGE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractVisualizationArtifact(text: string): VisualizationArtifact | undefined {
  const marker = VISUALIZATION_MARKER_PATTERN.exec(text);
  if (!marker?.[1]) return undefined;
  let href = '';
  try { href = JSON.parse(marker[1]); } catch { return undefined; }
  const path = localFilePathFromHref(href);
  if (!path || !/\.html?$/i.test(path)) return undefined;
  return { path, name: localFileName(path), source: 'visualize' };
}

function stripVisualizationMarker(text: string) {
  return text
    .replace(VISUALIZATION_MARKER_PATTERN, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractImageAttachment(text: string): ImageAttachment | undefined {
  const decoded = String(text || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
  const image = /<image\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)')[^>]*>/i.exec(decoded);
  const path = (image?.[1] || image?.[2] || '').trim();
  if (!path) return undefined;
  const metadataName = /(?:^|\r?\n)##\s+([^:\r\n]+):\s+[A-Za-z]:[\\/]/m.exec(decoded)?.[1]?.trim();
  const fallbackName = path.split(/[\\/]/).at(-1) || t('图片', 'Image');
  return { path, name: metadataName || fallbackName };
}

export function historyFingerprint(turns: Turn[], progress?: unknown) {
  return JSON.stringify({
    turns: turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      items: turn.items?.map((item) => ({
        type: item.type,
        turnId: item.turnId,
        phase: item.phase,
        status: item.status,
        text: item.text,
        input: item.input,
        output: item.output,
        contexts: item.contexts,
        attachment: item.attachment,
        fileChanges: item.fileChanges,
        compaction: item.compaction,
        notice: item.notice,
        questions: item.questions,
        questionReplies: item.questionReplies,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        completedAt: item.completedAt,
        timestamp: item.timestamp,
      })),
    })),
    progress: normalizeTurnProgress(progress),
  });
}

function messageTime(item: TurnItem, turn: Turn, kind: TimelineKind) {
  return item.completedAt || item.updatedAt || item.createdAt || item.timestamp
    || (kind === 'user' ? turn.startedAt : turn.completedAt) || null;
}

export function mergeHistorySnapshot(
  current: TimelineItem[], latest: TimelineItem[], latestTurnIds: Set<string>,
  options: { partial?: boolean } = {},
) {
  const compactions = matchCompactionSnapshots(current, latest);
  latest = compactions.latest;
  const knownTurnIds = new Set(current.map((item) => item.historyTurnId).filter(Boolean));
  const introducesNewTurn = [...latestTurnIds].some((turnId) => !knownTurnIds.has(turnId));
  const persistedFileChanges = new Map(current
    .filter((item) => item.historyTurnId && item.fileChanges)
    .map((item) => [`${item.historyTurnId}\0${messageIdentity(item)}`, item.fileChanges!]));
  const transientAttachments = new Map(current
    .filter((item) => item.transient && item.attachment)
    .map((item) => [messageContentIdentity(item), item.attachment]));
  const crossSourceMatches = matchCrossSourceMessages(current, latest);
  const optimisticUserMatches = matchOptimisticUsers(current, latest, crossSourceMatches);
  const matchedOptimisticUserIds = new Set([...optimisticUserMatches.values()].map(item => item.id));
  const persistedIdentities = new Map<string, TimelineItem[]>();
  const claimedIds = new Set<string>();
  const occupiedIds = new Set([...current, ...latest].map((item) => item.id));
  for (const item of current) {
    const identity = persistedSnapshotIdentity(item);
    if (!identity) continue;
    const matches = persistedIdentities.get(identity) || [];
    matches.push(item);
    persistedIdentities.set(identity, matches);
  }
  const hydratedLatest = latest.map((item, index) => {
    // Rollout offsets and live-tail indexes change on each read. Keep the DOM
    // identity of the same persisted message, including its loaded image.
    const candidates = persistedIdentities.get(persistedSnapshotIdentity(item));
    while (candidates?.length && claimedIds.has(candidates[0].id)) candidates.shift();
    let persisted = item.compaction || item.compactionProgress ? undefined : candidates?.shift();
    const crossSource = crossSourceMatches.get(index);
    if (!persisted && crossSource && !claimedIds.has(crossSource.id)) persisted = crossSource;
    if (!persisted && options.partial) {
      persisted = current.find((previous) => !claimedIds.has(previous.id) && samePersistedMessage(previous, item));
    }
    if (persisted) claimedIds.add(persisted.id);
    const retainedFileChanges = item.historyTurnId
      ? persistedFileChanges.get(`${item.historyTurnId}\0${messageIdentity(item)}`)
      : undefined;
    let id = optimisticUserMatches.get(index)?.id || persisted?.id || item.id;
    if (options.partial && !persisted && !optimisticUserMatches.has(index)
      && current.some((previous) => previous.id === id && !compactions.matched.has(id))) {
      // Tail indexes are positions in a moving window, not message identities.
      const base = id;
      let suffix = 1;
      while (occupiedIds.has(id)) id = `${base}~${suffix++}`;
      occupiedIds.add(id);
    }
    const hydrated = {
      ...item,
      id,
      ...(item.attachment ? {} : {
        attachment: item.kind === 'user'
          ? optimisticUserMatches.get(index)?.attachment || persisted?.attachment
          : transientAttachments.get(messageContentIdentity(item)),
      }),
      ...(item.fileChanges || !retainedFileChanges ? {} : { fileChanges: retainedFileChanges }),
    };
    if (hydrated.kind !== 'progress' || !hydrated.historyTurnId || hydrated.attachment || hydrated.visualization) return hydrated;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const previous = current[index];
      if (previous.transient
        || previous.kind !== 'progress'
        || previous.attachment || previous.visualization
        || previous.historyTurnId !== hydrated.historyTurnId) continue;
      if (hydrated.text.startsWith(previous.text)) return { ...hydrated, id: previous.id };
      if (options.partial) {
        if (previous.text.includes(hydrated.text)) return { ...previous, ...hydrated, id: previous.id, text: previous.text, progressParts: previous.progressParts };
        const paragraphs = previous.text.split('\n\n');
        for (let start = 1; start < paragraphs.length; start++) {
          const overlap = paragraphs.slice(start).join('\n\n');
          if (overlap && hydrated.text.startsWith(`${overlap}\n\n`)) {
            const combined = prependHistoryPage([previous], [hydrated]);
            const text = previous.text + hydrated.text.slice(overlap.length);
            return { ...hydrated, id: previous.id, text,
              progressParts: combined.length === 1 && combined[0].text === text ? combined[0].progressParts : undefined };
          }
        }
      }
      break;
    }
    return hydrated;
  });
  const persistedItems = new Set(hydratedLatest.map(messageIdentity));
  const persistedSnapshotItems = new Set(hydratedLatest
    .map(persistedSnapshotIdentity)
    .filter(Boolean));
  const persistedProgressByTurn = new Map<string, string[]>();
  for (const item of hydratedLatest) {
    if (item.kind !== 'progress' || !item.historyTurnId) continue;
    const progress = persistedProgressByTurn.get(item.historyTurnId) || [];
    progress.push(canonicalMessageText(item.text));
    persistedProgressByTurn.set(item.historyTurnId, progress);
  }
  const finalRepliesByTurn = new Map<string, Set<string>>();
  for (const item of hydratedLatest) {
    if (item.kind !== 'assistant' || !item.historyTurnId) continue;
    const replies = finalRepliesByTurn.get(item.historyTurnId) || new Set<string>();
    replies.add(canonicalMessageText(item.text));
    finalRepliesByTurn.set(item.historyTurnId, replies);
  }
  const duplicateFinalProgressIds = new Set(current
    .filter((item) => item.transient
      && item.kind === 'progress'
      && item.historyTurnId
      && finalRepliesByTurn.get(item.historyTurnId)?.has(canonicalMessageText(item.text)))
    .map((item) => item.id));
  const coveredTransientProgressIds = new Set(current
    .filter((item) => item.transient
      && item.kind === 'progress'
      && item.historyTurnId
      && persistedProgressByTurn.get(item.historyTurnId)?.some((persisted) => (
        persisted.includes(canonicalMessageText(item.text))
      )))
    .map((item) => item.id));
  const carriedProgress = current.filter((item) => item.transient
    && item.kind === 'progress'
    && item.historyTurnId
    && latestTurnIds.has(item.historyTurnId)
    && !finalRepliesByTurn.get(item.historyTurnId)?.has(canonicalMessageText(item.text))
    && !persistedProgressByTurn.get(item.historyTurnId)?.some((persisted) => (
      persisted.includes(canonicalMessageText(item.text))
    ))
    && !persistedItems.has(messageIdentity(item)));
  const carriedProgressIds = new Set(carriedProgress.map((item) => item.id));
  const carriedProgressByTurn = new Map<string, TimelineItem[]>();
  for (const item of carriedProgress) {
    const turnItems = carriedProgressByTurn.get(item.historyTurnId!) || [];
    turnItems.push(item);
    carriedProgressByTurn.set(item.historyTurnId!, turnItems);
  }
  const insertedProgressTurns = new Set<string>();
  const mergedLatest: TimelineItem[] = [];
  for (const [index, item] of hydratedLatest.entries()) {
    const turnId = item.historyTurnId;
    const progress = turnId ? carriedProgressByTurn.get(turnId) : undefined;
    if (progress?.length && item.kind === 'assistant' && !insertedProgressTurns.has(turnId!)) {
      mergedLatest.push(...progress);
      insertedProgressTurns.add(turnId!);
    }
    mergedLatest.push(item);
    const nextTurnId = hydratedLatest[index + 1]?.historyTurnId;
    if (progress?.length && nextTurnId !== turnId && !insertedProgressTurns.has(turnId!)) {
      mergedLatest.push(...progress);
      insertedProgressTurns.add(turnId!);
    }
  }
  const firstMatch = current.findIndex((item) => item.historyTurnId && latestTurnIds.has(item.historyTurnId));
  const keep = (item: TimelineItem) => (
    !compactions.matched.has(item.id)
    && !carriedProgressIds.has(item.id)
    && !duplicateFinalProgressIds.has(item.id)
    && !coveredTransientProgressIds.has(item.id)
    && !(persistedSnapshotIdentity(item) && persistedSnapshotItems.has(persistedSnapshotIdentity(item)))
    && !(item.historyTurnId && latestTurnIds.has(item.historyTurnId) && !item.transient)
    && !(introducesNewTurn && item.transient && item.kind === 'assistant')
    && !(item.transient && (item.kind === 'user'
      ? matchedOptimisticUserIds.has(item.id) : persistedItems.has(messageIdentity(item))))
  );
  const retained = current.filter(keep);
  const insertionIndex = firstMatch < 0
    ? retained.length
    : current.slice(0, firstMatch).filter(keep).length;
  const result = [
    ...retained.slice(0, insertionIndex),
    ...mergedLatest,
    ...retained.slice(insertionIndex),
  ];
  if (!options.partial) return result;
  // A bounded tail is additive evidence. Missing rows are not deletions: a
  // long-running turn can scroll its input, images and earlier replies out of it.
  const omitted = current.filter((item) => !item.transient && !keep(item)
    && !compactions.matched.has(item.id)
    && !hydratedLatest.some((next) => next.id === item.id || samePersistedMessage(item, next)
      || (item.kind === 'progress' && next.kind === 'progress' && !item.attachment && !item.visualization
        && !next.attachment && !next.visualization
        && item.historyTurnId === next.historyTurnId && next.text.includes(item.text))));
  for (const item of omitted) {
    const previousIndex = current.indexOf(item);
    const successor = current.slice(previousIndex + 1).find((other) => result.some((next) => next.id === other.id));
    let index = successor ? result.findIndex((next) => next.id === successor.id) : -1;
    if (index < 0) {
      const time = timelineTime(item);
      index = time == null ? -1 : result.findIndex((next) => {
        const nextTime = timelineTime(next);
        return nextTime != null && nextTime > time;
      });
    }
    if (index < 0) {
      const predecessor = current.slice(0, previousIndex).reverse().find((other) => result.some((next) => next.id === other.id));
      index = predecessor ? result.findIndex((next) => next.id === predecessor.id) + 1
        : Math.max(0, result.findIndex((next) => next.historyTurnId === item.historyTurnId));
    }
    result.splice(index, 0, item);
  }
  return result;
}

function timelineTime(item: TimelineItem) {
  const value = item.completedAt;
  if (value == null) return null;
  const time = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1_000 : value) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function samePersistedMessage(previous: TimelineItem, next: TimelineItem) {
  if (previous.transient || next.transient || messageIdentity(previous) !== messageIdentity(next)) return false;
  const before = timelineTime(previous);
  const after = timelineTime(next);
  if (before != null && after != null) return before === after
    && JSON.stringify(previous.contexts || []) === JSON.stringify(next.contexts || []);
  return Boolean(previous.historyTurnId && !/^(tail|rollout):/.test(previous.historyTurnId)
    && previous.historyTurnId === next.historyTurnId);
}

export function prependHistoryPage(older: TimelineItem[], current: TimelineItem[]) {
  if (!older.length) return current;
  const ids = new Set(current.map((item) => item.id));
  const crossSourceMatches = matchCrossSourceMessages(current, older);
  const expand = (items: TimelineItem[]) => items.flatMap((owner) => (
    owner.progressParts?.length && plainProgress(owner)
      ? owner.progressParts.map((part) => ({ item: { ...owner, ...part, progressParts: undefined }, owner }))
      : [{ item: owner, owner }]
  ));
  const saved = expand(current);
  const snapshots = new Set(saved.map(({ item }) => persistedSnapshotIdentity(item)).filter(Boolean));
  const incoming = expand(older.filter((item, index) => !ids.has(item.id) && !crossSourceMatches.has(index)))
    .filter(({ item }) => !(persistedSnapshotIdentity(item) && snapshots.has(persistedSnapshotIdentity(item))));
  if (!incoming.length) return current;
  // A live tail can reach further back than the initial history page. Insert
  // overlapping pages chronologically instead of placing every row before it.
  const ordered: typeof saved = [];
  let left = 0;
  let right = 0;
  while (left < incoming.length && right < saved.length) {
    const before = timelineTime(incoming[left].item);
    const after = timelineTime(saved[right].item);
    if (before != null && after != null && before > after) ordered.push(saved[right++]);
    else ordered.push(incoming[left++]);
  }
  ordered.push(...incoming.slice(left), ...saved.slice(right));

  const result: TimelineItem[] = [];
  for (let start = 0; start < ordered.length;) {
    const first = ordered[start];
    let end = start + 1;
    if (plainProgress(first.item) && first.item.historyTurnId) {
      while (end < ordered.length && plainProgress(ordered[end].item)
        && ordered[end].item.historyTurnId === first.item.historyTurnId) end++;
    }
    if (end === start + 1 && first.item === first.owner) result.push(first.owner);
    else {
      const group = ordered.slice(start, end);
      // Keep the existing DOM node so paragraph-based scroll anchoring still
      // finds the text the user was reading after earlier paragraphs arrive.
      const owner = group.find((entry) => ids.has(entry.owner.id))?.owner || first.owner;
      const text = group.map(({ item }) => item.text).join('\n\n');
      const completedAt = group.at(-1)!.item.completedAt;
      result.push(owner.text === text && owner.completedAt === completedAt ? owner : {
        ...owner, text, completedAt,
        progressParts: group.map(({ item }) => ({ text: item.text, completedAt: item.completedAt })),
      });
    }
    start = end;
  }
  return result;
}

function plainProgress(item: TimelineItem) {
  return item.kind === 'progress' && !item.attachment && !item.visualization && !item.transient;
}

function matchCrossSourceMessages(current: TimelineItem[], latest: TimelineItem[]) {
  // App-server summaries may use whole seconds (or the turn start), while
  // rollout messages use their write time in milliseconds. Match only a unique
  // message on each side of the same native turn, never text across turns or
  // repeated messages within one source. A moving tail is not a stable ID.
  const key = (item: TimelineItem) => !item.transient && item.historySource
    && item.historyTurnId && !/^(tail|rollout):/.test(item.historyTurnId)
    && (item.kind === 'user' || item.kind === 'assistant')
    ? `${item.historyTurnId}\0${messageIdentity(item)}\0${JSON.stringify(item.contexts || [])}` : '';
  const group = (items: TimelineItem[]) => {
    const groups = new Map<string, number[]>();
    items.forEach((item, index) => {
      const identity = key(item);
      if (!identity) return;
      const indexes = groups.get(identity) || [];
      indexes.push(index);
      groups.set(identity, indexes);
    });
    return groups;
  };
  const previous = group(current);
  const matches = new Map<number, TimelineItem>();
  for (const [identity, indexes] of group(latest)) {
    const candidates = previous.get(identity);
    if (indexes.length !== 1 || candidates?.length !== 1) continue;
    const item = current[candidates[0]];
    if (item.historySource !== latest[indexes[0]].historySource) matches.set(indexes[0], item);
  }
  return matches;
}

function matchOptimisticUsers(current: TimelineItem[], latest: TimelineItem[], crossSourceMatches: Map<number, TimelineItem>) {
  const matches = new Map<number, TimelineItem>();
  const optimisticUsers = current.filter((item) => item.transient && item.kind === 'user').reverse();
  if (!optimisticUsers.length) return matches;
  // An unchanged poll of an older identical message is not confirmation of a
  // new submission. Reserve rows already represented by persisted history.
  const claimedLatestIndexes = new Set(latest.flatMap((item, index) => (
    crossSourceMatches.has(index) || current.some(previous => samePersistedMessage(previous, item))
      ? [index] : []
  )));
  for (const optimistic of optimisticUsers) {
    const identity = messageContentIdentity(optimistic);
    for (let index = latest.length - 1; index >= 0; index -= 1) {
      if (claimedLatestIndexes.has(index) || latest[index]?.kind !== 'user') continue;
      if (messageContentIdentity(latest[index]) !== identity) continue;
      if (optimistic.attachment && latest[index].attachment
        && optimistic.attachment.path !== latest[index].attachment!.path) continue;
      claimedLatestIndexes.add(index);
      matches.set(index, optimistic);
      break;
    }
  }
  return matches;
}

function messageIdentity(item: TimelineItem) {
  return `${messageContentIdentity(item)}\0${item.attachment?.path || ''}\0${item.visualization?.path || ''}`;
}

function persistedSnapshotIdentity(item: TimelineItem) {
  if (item.transient || item.completedAt == null) return '';
  const rawTime = item.completedAt;
  const completedAt = typeof rawTime === 'number'
    ? (rawTime < 10_000_000_000 ? rawTime * 1_000 : rawTime)
    : Date.parse(String(rawTime));
  if (!Number.isFinite(completedAt)) return '';
  return [
    messageIdentity(item),
    String(completedAt),
    JSON.stringify(item.contexts || []),
  ].join('\0');
}

function messageContentIdentity(item: TimelineItem) {
  return [
    item.kind,
    canonicalMessageText(item.text),
    JSON.stringify(item.compaction || null),
    JSON.stringify(item.notice || null),
    JSON.stringify(item.questions || null),
    JSON.stringify(item.questionReplies || null),
  ].join('\0');
}

function canonicalMessageText(text: string) {
  return stripImageAttachments(text)
    .replace(/(?:\r?\n)+📎[^\r\n]*$/u, '')
    .trim();
}

export function attachmentRegistryKey(
  threadId: string,
  text: string,
  environmentId = 'personal-pc',
) {
  return `${environmentId}\0${threadId}\0${canonicalMessageText(text)}`;
}

export function resolveTimelineAttachment(
  item: TimelineItem,
  threadId: string | null,
  knownAttachments: Record<string, KnownAttachment>,
  environmentId = 'personal-pc',
) {
  if (item.attachment) return item.attachment;
  if (!threadId) return undefined;
  return knownAttachments[attachmentRegistryKey(threadId, item.text, environmentId)]
    || (environmentId === 'personal-pc'
      ? knownAttachments[`${threadId}\0${canonicalMessageText(item.text)}`]
      : undefined);
}

export function loadKnownAttachments(): Record<string, KnownAttachment> {
  try {
    const legacy = JSON.parse(localStorage.getItem('bridge.knownAttachments') || '{}') as Record<string, KnownAttachment>;
    const current = JSON.parse(localStorage.getItem(ATTACHMENT_STORAGE_KEY) || '{}') as Record<string, KnownAttachment>;
    const value = { ...legacy, ...current };
    const now = Date.now();
    const valid = Object.fromEntries(Object.entries(value).filter(([, attachment]) => (
      attachment
      && typeof attachment.path === 'string'
      && typeof attachment.name === 'string'
      && Number.isFinite(attachment.savedAt)
      && now - attachment.savedAt < 24 * 60 * 60 * 1000
    )));
    localStorage.setItem(ATTACHMENT_STORAGE_KEY, JSON.stringify(valid));
    localStorage.removeItem('bridge.knownAttachments');
    return valid;
  } catch {
    return {};
  }
}

export function storeKnownAttachments(value: Record<string, KnownAttachment>) {
  localStorage.setItem(ATTACHMENT_STORAGE_KEY, JSON.stringify(value));
}
