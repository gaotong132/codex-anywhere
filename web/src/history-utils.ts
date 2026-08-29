import { t } from './i18n';
import {
  parseAssistantMessage,
  parseUserMessage,
  stripImageAttachments,
} from '../../src/shared/message-content';
import type { MessageContext } from '../../src/shared/message-content';
import { localFileName, localFilePathFromHref } from './file-utils';

export { parseAssistantMessage } from '../../src/shared/message-content';

const ATTACHMENT_STORAGE_KEY = 'bridge.knownAttachments.v2';
const LOCAL_MARKDOWN_IMAGE_PATTERN = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|((?:file:\/\/\/|[A-Za-z]:[\\/])[^)\r\n]+))\s*\)/i;

type TurnItem = {
  type?: string;
  phase?: string;
  status?: string;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  contexts?: MessageContext[];
  attachment?: ImageAttachment;
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

export type TimelineKind = 'user' | 'assistant' | 'progress' | 'error';
export type ImageAttachment = { path: string; name: string; source?: 'generated' | 'local' };
export type TimelineItem = {
  id: string;
  kind: TimelineKind;
  text: string;
  historyTurnId?: string;
  transient?: boolean;
  attachment?: ImageAttachment;
  contexts?: MessageContext[];
  completedAt?: number | string | null;
};
export type KnownAttachment = ImageAttachment & { savedAt: number };

export function historyItems(turns: Turn[]) {
  const items: TimelineItem[] = [];
  for (const turn of [...(turns || [])].reverse()) {
    for (const [index, item] of (turn.items || []).entries()) {
      const type = item.type || '';
      const rawText = item.text?.trim();
      const userItem = /user/i.test(type);
      const localMarkdownImage = userItem ? undefined : extractLocalMarkdownImage(rawText || '');
      const attachment = item.attachment
        || (userItem
          ? extractImageAttachment(rawText || '')
          : localMarkdownImage);
      const presentationText = localMarkdownImage && attachment === localMarkdownImage
        ? stripLocalMarkdownImage(rawText || '')
        : rawText || '';
      const content = userItem
        ? parseUserMessage(rawText || '')
        : parseAssistantMessage(presentationText);
      const text = content.text;
      let kind: TimelineKind | null = null;
      const displayText = text || '';
      if (/user/i.test(type) && (text || attachment)) kind = 'user';
      else if (/agent|assistant|message/i.test(type) && (text || attachment)) {
        kind = !item.phase || item.phase === 'final_answer' ? 'assistant' : 'progress';
      }
      if (!kind || (!displayText && !attachment)) continue;
      const previous = items.at(-1);
      if (kind === 'progress' && previous?.kind === 'progress' && previous.historyTurnId === turn.id) {
        previous.text = `${previous.text}\n\n${displayText}`;
        previous.completedAt = messageTime(item, turn, kind) || previous.completedAt;
        continue;
      }
      const completedAt = messageTime(item, turn, kind);
      items.push({
        id: `history:${turn.id}:${index}`,
        kind,
        text: displayText,
        historyTurnId: turn.id,
        attachment,
        contexts: item.contexts?.length ? item.contexts : content.contexts,
        ...(completedAt ? { completedAt } : {}),
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

export function historyFingerprint(turns: Turn[]) {
  return JSON.stringify(turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    items: turn.items?.map((item) => ({
      type: item.type,
      phase: item.phase,
      status: item.status,
      text: item.text,
      input: item.input,
      output: item.output,
      contexts: item.contexts,
      attachment: item.attachment,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt,
      timestamp: item.timestamp,
    })),
  })));
}

function messageTime(item: TurnItem, turn: Turn, kind: TimelineKind) {
  return item.completedAt || item.updatedAt || item.createdAt || item.timestamp
    || (kind === 'user' ? turn.startedAt : turn.completedAt) || null;
}

export function mergeHistorySnapshot(current: TimelineItem[], latest: TimelineItem[], latestTurnIds: Set<string>) {
  const knownTurnIds = new Set(current.map((item) => item.historyTurnId).filter(Boolean));
  const introducesNewTurn = [...latestTurnIds].some((turnId) => !knownTurnIds.has(turnId));
  const transientAttachments = new Map(current
    .filter((item) => item.transient && item.attachment)
    .map((item) => [messageContentIdentity(item), item.attachment]));
  const hydratedLatest = latest.map((item) => item.attachment ? item : {
    ...item,
    attachment: transientAttachments.get(messageContentIdentity(item)),
  });
  const persistedMessages = new Set(hydratedLatest
    .filter((item) => item.kind === 'user' || item.kind === 'assistant')
    .map(messageIdentity));
  const firstMatch = current.findIndex((item) => item.historyTurnId && latestTurnIds.has(item.historyTurnId));
  const keep = (item: TimelineItem) => (
    !(item.historyTurnId && latestTurnIds.has(item.historyTurnId))
    && !(introducesNewTurn && item.transient && item.kind !== 'user')
    && !(item.transient && persistedMessages.has(messageIdentity(item)))
  );
  const retained = current.filter(keep);
  const insertionIndex = firstMatch < 0
    ? retained.length
    : current.slice(0, firstMatch).filter(keep).length;
  return [
    ...retained.slice(0, insertionIndex),
    ...hydratedLatest,
    ...retained.slice(insertionIndex),
  ];
}

function messageIdentity(item: TimelineItem) {
  return `${messageContentIdentity(item)}\0${item.attachment?.path || ''}`;
}

function messageContentIdentity(item: TimelineItem) {
  return `${item.kind}\0${canonicalMessageText(item.text)}`;
}

function canonicalMessageText(text: string) {
  return stripImageAttachments(text)
    .replace(/(?:\r?\n)+📎[^\r\n]*$/u, '')
    .trim();
}

export function attachmentRegistryKey(threadId: string, text: string) {
  return `${threadId}\0${canonicalMessageText(text)}`;
}

export function resolveTimelineAttachment(
  item: TimelineItem,
  threadId: string | null,
  knownAttachments: Record<string, KnownAttachment>,
) {
  if (item.attachment) return item.attachment;
  if (!threadId) return undefined;
  return knownAttachments[attachmentRegistryKey(threadId, item.text)];
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
