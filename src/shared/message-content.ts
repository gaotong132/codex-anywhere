import { XMLParser } from 'fast-xml-parser';

const USER_REQUEST_SECTION = /(?:^|\r?\n)##\s+My request:\s*(?:\r?\n|$)([\s\S]*)/i;
const IMAGE_ATTACHMENT = /<image\b[^>]*?(?:\/\s*>|>\s*<\/image\s*>)/gi;
const ESCAPED_IMAGE_ATTACHMENT = /&lt;image\b[\s\S]*?(?:\/\s*&gt;|&gt;\s*&lt;\/image\s*&gt;)/gi;
const INTERNAL_CONTEXT = /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/i;
const ESCAPED_INTERNAL_CONTEXT = /(?:\\?<|&lt;)environment_context\b[\s\S]*?(?:\\?<|&lt;)\/environment_context(?:>|&gt;)/i;
const INTERNAL_AGENT_INSTRUCTIONS = /^\s*#\s+AGENTS\.md instructions for\s+[^\r\n]+\s+(?:<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>|&lt;INSTRUCTIONS&gt;[\s\S]*&lt;\/INSTRUCTIONS&gt;)\s*$/i;
const BARE_URL_BEFORE_CJK_PUNCTUATION = /(?<![<(])(https?:\/\/[^\s<>()]+?)(?=[，。；：！？、）》】])/gu;
const CONTROL_ENVELOPE_START = /^\s*(?:\\?<(?:codex_delegation|heartbeat|environment_context)\b|&lt;(?:codex_delegation|heartbeat|environment_context)\b)/i;

type OrderedXmlNode = Record<string, unknown>;

export type MessageContext = {
  kind: 'delegation' | 'automation';
  sourceThreadId?: string;
  automationId?: string;
  currentTimeIso?: string;
  decision?: string;
};

export type ParsedMessageContent = {
  text: string;
  contexts: MessageContext[];
};

const envelopeParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: false,
  stopNodes: ['*.input', '*.instructions', '*.message'],
});

export function parseUserMessage(value: unknown): ParsedMessageContent {
  return parseMessageContent(value, 'user');
}

export function parseAssistantMessage(value: unknown): ParsedMessageContent {
  return parseMessageContent(value, 'assistant');
}

export function parseInjectedUserMessage(value: unknown): ParsedMessageContent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const expectedContext = String(item.name || '') === 'send_message_to_thread'
    ? 'delegation' : String(item.name || '') === 'automation_update' ? 'automation' : '';
  if (!expectedContext || typeof item.output !== 'string') return null;
  const content = parseUserMessage(item.output);
  return content.text && content.contexts.some((context) => context.kind === expectedContext)
    ? content : null;
}

export function displayUserMessage(value: unknown) {
  return parseUserMessage(value).text;
}

export function displayAssistantMessage(value: unknown) {
  return parseAssistantMessage(value).text;
}

export function stripImageAttachments(value: unknown) {
  return String(value || '').replace(IMAGE_ATTACHMENT, '').replace(ESCAPED_IMAGE_ATTACHMENT, '');
}

export function normalizeToolPurpose(value: unknown, limit = 160) {
  const firstLine = String(value || '').trim().split(/\r?\n/, 1)[0]
    .replace(/^\*{1,2}\s*/, '')
    .replace(/\s*\*{1,2}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstLine) return '';
  return firstLine.length <= limit ? firstLine : `${firstLine.slice(0, limit - 1).trimEnd()}…`;
}

function parseMessageContent(value: unknown, role: 'user' | 'assistant'): ParsedMessageContent {
  let text = String(value || '').trim();
  const contexts: MessageContext[] = [];

  for (let depth = 0; depth < 3; depth += 1) {
    const envelope = parseEnvelope(text);
    if (!envelope) break;
    if (envelope.name === 'codex_delegation') {
      contexts.push({
        kind: 'delegation',
        sourceThreadId: childText(envelope.children, 'source_thread_id').trim() || undefined,
      });
      text = childText(envelope.children, 'input').trim();
      continue;
    }
    if (envelope.name === 'heartbeat') {
      contexts.push({
        kind: 'automation',
        automationId: childText(envelope.children, 'automation_id').trim() || undefined,
        currentTimeIso: childText(envelope.children, 'current_time_iso').trim() || undefined,
        decision: childText(envelope.children, 'decision').trim() || undefined,
      });
      const preferred = role === 'user' ? ['instructions', 'message'] : ['message'];
      text = preferred.map((name) => childText(envelope.children, name).trim()).find(Boolean) || '';
      continue;
    }
    return { text: '', contexts };
  }

  const request = USER_REQUEST_SECTION.exec(text);
  if (request) text = request[1];
  else if (
    INTERNAL_AGENT_INSTRUCTIONS.test(text)
    || INTERNAL_CONTEXT.test(normalizeControlEnvelope(text))
    || ESCAPED_INTERNAL_CONTEXT.test(text)
  ) {
    return { text: '', contexts };
  }

  return {
    text: normalizeBareLinks(stripImageAttachments(text).trim()),
    contexts,
  };
}

function parseEnvelope(value: string) {
  const text = normalizeControlEnvelope(value);
  if (!CONTROL_ENVELOPE_START.test(value) && !CONTROL_ENVELOPE_START.test(text)) return null;
  try {
    const parsed = envelopeParser.parse(text) as OrderedXmlNode[];
    const root = parsed.find((node) => node && typeof node === 'object');
    if (!root) return null;
    for (const name of ['codex_delegation', 'heartbeat', 'environment_context'] as const) {
      const children = root[name];
      if (Array.isArray(children)) return { name, children: children as OrderedXmlNode[] };
    }
  } catch {
    return null;
  }
  return null;
}

function childText(children: OrderedXmlNode[], name: string) {
  const child = children.find((node) => Object.hasOwn(node, name));
  const value = child?.[name];
  if (!Array.isArray(value)) return '';
  return value.map(orderedText).join('');
}

function orderedText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const record = node as OrderedXmlNode;
  if (typeof record['#text'] === 'string') return record['#text'];
  return Object.entries(record)
    .filter(([name]) => !name.startsWith(':@'))
    .map(([, value]) => Array.isArray(value) ? value.map(orderedText).join('') : orderedText(value))
    .join('');
}

function normalizeBareLinks(text: string) {
  return text.replace(BARE_URL_BEFORE_CJK_PUNCTUATION, '<$1>');
}

function normalizeControlEnvelope(text: string) {
  if (!CONTROL_ENVELOPE_START.test(text)) return text;
  return text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\\(?=<\/?[a-z])/gi, '')
    .replace(/<[^>]+>/g, (tag) => tag.replace(/\\([_:-])/g, '$1'));
}
