const DELEGATION_ENVELOPE = /^\s*<codex_delegation>\s*<source_thread_id>\s*[0-9a-f-]{16,64}\s*<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/i;
const USER_REQUEST_SECTION = /(?:^|\r?\n)##\s+My request:\s*(?:\r?\n|$)([\s\S]*)/i;
const IMAGE_ATTACHMENT = /<image\b[^>]*?(?:\/\s*>|>\s*<\/image\s*>)/gi;
const ESCAPED_IMAGE_ATTACHMENT = /&lt;image\b[\s\S]*?(?:\/\s*&gt;|&gt;\s*&lt;\/image\s*&gt;)/gi;
const INTERNAL_CONTEXT = /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/i;
const HEARTBEAT_ENVELOPE = /^\s*<heartbeat\b[^>]*>([\s\S]*?)<\/heartbeat>\s*$/i;
const HEARTBEAT_MESSAGE = /<message\b[^>]*>([\s\S]*?)<\/message>/i;
const BARE_URL_BEFORE_CJK_PUNCTUATION = /(?<![<(])(https?:\/\/[^\s<>()]+?)(?=[，。；：！？、）》】])/gu;

export function displayUserMessage(value: unknown) {
  let text = String(value || '');
  const delegation = DELEGATION_ENVELOPE.exec(text);
  if (delegation) text = delegation[1];
  const request = USER_REQUEST_SECTION.exec(text);
  if (request) text = request[1];
  else if (INTERNAL_CONTEXT.test(text)) return '';
  return normalizeBareLinks(text.replace(IMAGE_ATTACHMENT, '').replace(ESCAPED_IMAGE_ATTACHMENT, '').trim());
}

export function displayAssistantMessage(value: unknown) {
  const text = String(value || '').trim();
  const heartbeat = HEARTBEAT_ENVELOPE.exec(text);
  const visibleText = heartbeat ? HEARTBEAT_MESSAGE.exec(heartbeat[1])?.[1]?.trim() || '' : text;
  return normalizeBareLinks(visibleText);
}

function normalizeBareLinks(text: string) {
  return text.replace(BARE_URL_BEFORE_CJK_PUNCTUATION, '<$1>');
}
