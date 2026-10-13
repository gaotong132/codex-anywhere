import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { parseUserMessage } from '../shared/message-content.js';
import type { QuestionReply } from '../shared/async-questions.js';

const CHUNK_BYTES = 256 * 1024;
const MAX_ROW_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 12;
type Index = {
  signature: string; identity: string; size: number; offset: number; tail: Buffer;
  replies: Map<string, QuestionReply>;
};
const cache = new Map<string, Index>();
const pending = new Map<string, Promise<QuestionReply[]>>();

// Read all history in bounded chunks, retaining only requested answer metadata.
// Large tool/image rows are skipped without retaining or decoding their bodies.
export function readRolloutQuestionReplies(filePath: string, ids?: ReadonlySet<string>): Promise<QuestionReply[]> {
  const wanted = ids ? new Set(ids) : undefined;
  const key = JSON.stringify([filePath, wanted ? [...wanted].sort() : null]);
  const active = pending.get(key);
  if (active) return active;
  const read = scan(filePath, key, wanted).finally(() => { pending.delete(key); });
  pending.set(key, read);
  return read;
}

async function tail(handle: FileHandle, size: number) {
  const bytes = Buffer.alloc(Math.min(size, 1024));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, size - bytes.length);
  return bytes.subarray(0, bytesRead);
}

async function scan(filePath: string, key: string, wanted?: ReadonlySet<string>): Promise<QuestionReply[]> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const signature = `${identity}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const previous = cache.get(key);
    if (previous?.signature === signature) {
      cache.delete(key); cache.set(key, previous);
      return [...previous.replies.values()];
    }
    const append = previous && previous.identity === identity && info.size > previous.size
      && previous.tail.equals(await tail(handle, previous.size));
    const replies = new Map(append ? previous.replies : []);
    let position = append ? previous.offset : 0;
    let offset = position;
    let parts: Buffer[] = [];
    let length = 0;
    let skipped = false;
    while (position < info.size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
        length += end - start;
        if (length > MAX_ROW_BYTES) { skipped = true; parts = []; }
        if (!skipped) parts.push(chunk.subarray(start, end));
        if (end === bytesRead) break;
        if (!skipped) collect(Buffer.concat(parts, length).toString('utf8'), replies, wanted);
        offset = position + end + 1;
        parts = []; length = 0; skipped = false;
        start = end + 1;
      }
      position += bytesRead;
    }
    cache.delete(key);
    cache.set(key, { signature, identity, size: info.size, offset, replies, tail: await tail(handle, info.size) });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return [...replies.values()];
  } finally { await handle.close(); }
}

function collect(line: string, replies: Map<string, QuestionReply>, wanted?: ReadonlySet<string>) {
  if (!line.includes('send_user_message_question_reply')) return;
  try {
    const row = JSON.parse(line);
    const payload = row.payload || {};
    const input = row.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      ? (Array.isArray(payload.content) ? payload.content.map((part: { text?: string }) => part.text || '').join('\n') : '')
      : row.type === 'event_msg' && payload.type === 'user_message' ? String(payload.message || payload.text || '') : '';
    for (const reply of parseUserMessage(input).questionReplies || []) {
      if (!wanted || wanted.has(reply.questionItemId)) replies.set(reply.questionItemId, reply);
    }
  } catch { /* Incomplete and malformed records are not answers. */ }
}
