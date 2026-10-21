import { createHash } from 'node:crypto';
import { parseUserMessage } from '../shared/message-content.js';

type Value = Record<string, any>;
export function messageEditInput(input: Value[]) {
  const texts = input.filter(item => item.type === 'text');
  if (texts.length !== 1 || typeof texts[0].text !== 'string') throw new Error('message_edit_unsupported');
  const parsed = parseUserMessage(texts[0].text);
  if (!parsed.text.trim() || parsed.contexts.length || parsed.questionReplies?.length
    || !texts[0].text.includes(parsed.text)) throw new Error('message_edit_unsupported');
  return { text: parsed.text, replace: (text: string) => input.map(item => item !== texts[0] ? item : {
    ...item, text: item.text.replace(parsed.text, () => text), text_elements: [],
  }) };
}
export function editIdentifier(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new Error('message_edit_invalid');
  return value;
}
export function editText(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new Error('message_edit_invalid');
  return value.trim();
}
export function editToken(threadId: string, turnId: string, latestTurnId: string, input: Value[]) {
  return createHash('sha256').update(JSON.stringify([threadId, turnId, latestTurnId, input])).digest('hex');
}
