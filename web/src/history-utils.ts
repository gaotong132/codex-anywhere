import { t } from './i18n';

const ATTACHMENT_STORAGE_KEY = 'bridge.knownAttachments.v2';

export type TurnItem = {
  type?: string;
  phase?: string;
  status?: string;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
};

export type Turn = {
  id: string;
  status?: string;
  startedAt?: number | null;
  items?: TurnItem[];
};

export type TimelineKind = 'user' | 'assistant' | 'progress' | 'error' | 'notice';
export type ImageAttachment = { path: string; name: string };
export type TimelineItem = {
  id: string;
  kind: TimelineKind;
  text: string;
  historyTurnId?: string;
  transient?: boolean;
  attachment?: ImageAttachment;
};
export type KnownAttachment = ImageAttachment & { savedAt: number };

export function historyItems(turns: Turn[]) {
  const items: TimelineItem[] = [];
  for (const turn of [...(turns || [])].reverse()) {
    for (const [index, item] of (turn.items || []).entries()) {
      const type = item.type || '';
      const rawText = item.text?.trim();
      const attachment = /user/i.test(type) ? extractImageAttachment(rawText || '') : undefined;
      const text = /user/i.test(type)
        ? displayUserMessage(rawText || '')
        : displayAssistantMessage(rawText || '');
      let kind: TimelineKind | null = null;
      const displayText = text || '';
      if (/user/i.test(type) && text) kind = 'user';
      else if (/agent|assistant|message/i.test(type) && text) {
        kind = !item.phase || item.phase === 'final_answer' ? 'assistant' : 'progress';
      }
      if (!kind || !displayText) continue;
      const previous = items.at(-1);
      if (kind === 'progress' && previous?.kind === 'progress' && previous.historyTurnId === turn.id) {
        previous.text = `${previous.text}\n\n${displayText}`;
        continue;
      }
      items.push({
        id: `history:${turn.id}:${index}`,
        kind,
        text: displayText,
        historyTurnId: turn.id,
        attachment,
      });
    }
  }
  return items;
}

export function displayUserMessage(text: string) {
  const delegation = /^\s*<codex_delegation>\s*<source_thread_id>\s*[0-9a-f-]{16,64}\s*<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/i.exec(text);
  let visibleText = delegation ? delegation[1] : text;
  const request = /(?:^|\r?\n)##\s+My request:\s*(?:\r?\n|$)([\s\S]*)/i.exec(visibleText);
  if (request) visibleText = request[1];
  else if (/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/i.test(visibleText)) return '';
  return normalizeBareLinks(visibleText
    .replace(/<image\b[^>]*?(?:\/\s*>|>\s*<\/image\s*>)/gi, '')
    .replace(/&lt;image\b[\s\S]*?(?:\/\s*&gt;|&gt;\s*&lt;\/image\s*&gt;)/gi, '')
    .trim());
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

export function displayAssistantMessage(text: string) {
  const visibleText = String(text || '').trim();
  const heartbeat = /^\s*<heartbeat\b[^>]*>([\s\S]*?)<\/heartbeat>\s*$/i.exec(visibleText);
  const message = heartbeat
    ? /<message\b[^>]*>([\s\S]*?)<\/message>/i.exec(heartbeat[1])?.[1]?.trim() || ''
    : visibleText;
  return normalizeBareLinks(message);
}

function normalizeBareLinks(text: string) {
  return text.replace(/(?<![<(])(https?:\/\/[^\s<>()]+?)(?=[，。；：！？、）》】])/gu, '<$1>');
}

export function historyFingerprint(turns: Turn[]) {
  return JSON.stringify(turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items?.map((item) => ({
      type: item.type,
      phase: item.phase,
      status: item.status,
      text: item.text,
      input: item.input,
      output: item.output,
    })),
  })));
}

export function mergeHistorySnapshot(current: TimelineItem[], latest: TimelineItem[], latestTurnIds: Set<string>) {
  const knownTurnIds = new Set(current.map((item) => item.historyTurnId).filter(Boolean));
  const introducesNewTurn = [...latestTurnIds].some((turnId) => !knownTurnIds.has(turnId));
  const transientAttachments = new Map(current
    .filter((item) => item.transient && item.attachment)
    .map((item) => [messageIdentity(item), item.attachment]));
  const hydratedLatest = latest.map((item) => item.attachment ? item : {
    ...item,
    attachment: transientAttachments.get(messageIdentity(item)),
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
  return `${item.kind}\0${canonicalMessageText(item.text)}`;
}

function canonicalMessageText(text: string) {
  return String(text || '')
    .replace(/<image\b[^>]*?(?:\/\s*>|>\s*<\/image\s*>)/gi, '')
    .replace(/&lt;image\b[\s\S]*?(?:\/\s*&gt;|&gt;\s*&lt;\/image\s*&gt;)/gi, '')
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
