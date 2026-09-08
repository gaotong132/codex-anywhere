export type AsyncQuestion = { id: string; title: string; options: string[] };
export type QuestionReply = { questionItemId: string; question: string; answer: string };

const MAX_QUESTIONS = 12;
const MAX_TEXT = 16_000;
const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';

function text(value: unknown, limit = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

// Codex Desktop identifies each async question by its source item and index.
export function asyncQuestionsFromItem(item: Record<string, any>): AsyncQuestion[] | undefined {
  if (item.type !== 'agentMessage' || item.delivery !== 'async' || !text(item.id, 512)) return undefined;
  if (item.questions == null || (Array.isArray(item.questions) && !item.questions.length)) {
    return text(item.text) ? [{ id: item.id, title: item.text, options: [] }] : undefined;
  }
  if (!Array.isArray(item.questions) || item.questions.length > MAX_QUESTIONS) return undefined;
  const questions = item.questions.map((question: any, index: number) => ({
    id: JSON.stringify(['request_user_input_async', item.id, index]),
    title: question?.title,
    options: question?.options ?? [],
  }));
  return normalizeAsyncQuestions(questions);
}

export function asyncQuestionsFromCall(item: Record<string, any>): AsyncQuestion[] | undefined {
  if (item.type !== 'function_call' || item.name !== 'request_user_input_async'
    || typeof item.arguments !== 'string' || item.arguments.length > 128_000) return undefined;
  try {
    const args = JSON.parse(item.arguments);
    if (!Array.isArray(args?.questions) || !args.questions.length) return undefined;
    return asyncQuestionsFromItem({ type: 'agentMessage', delivery: 'async', id: item.call_id, questions: args.questions });
  } catch { return undefined; }
}

export function normalizeAsyncQuestions(value: unknown): AsyncQuestion[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_QUESTIONS) return undefined;
  const ids = new Set<string>();
  const result: AsyncQuestion[] = [];
  for (const q of value) {
    if (!q || !text(q.id, 1024) || ids.has(q.id) || !text(q.title)
      || !Array.isArray(q.options) || q.options.length > 20
      || q.options.some((option: unknown) => !text(option, 4000))) return undefined;
    ids.add(q.id);
    result.push({ id: q.id, title: q.title, options: [...q.options] });
  }
  return result;
}

export function parseQuestionReplies(value: unknown): QuestionReply[] | undefined {
  if (typeof value !== 'string' || value.length > 256_000) return undefined;
  const envelope = value.trim();
  if (!envelope.startsWith(OPEN) || !envelope.endsWith(CLOSE)) return undefined;
  try {
    const parsed = JSON.parse(envelope.slice(OPEN.length, -CLOSE.length));
    return normalizeQuestionReplies(Array.isArray(parsed) ? parsed : [parsed]);
  } catch { return undefined; }
}

export function normalizeQuestionReplies(rows: unknown): QuestionReply[] | undefined {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_QUESTIONS) return undefined;
  const ids = new Set<string>();
  const result: QuestionReply[] = [];
  for (const row of rows) {
    if (!row || !text(row.questionItemId, 1024) || ids.has(row.questionItemId)
      || !text(row.question) || !text(row.answer)) return undefined;
    ids.add(row.questionItemId);
    result.push({ questionItemId: row.questionItemId, question: row.question, answer: row.answer });
  }
  return result;
}

export function buildQuestionReply(replies: QuestionReply[]) {
  const envelope = `${OPEN}\n${JSON.stringify(replies)}\n${CLOSE}`;
  if (!parseQuestionReplies(envelope)) throw new Error('question_reply_invalid');
  return envelope;
}

export function questionReplyText(replies: QuestionReply[]) {
  return replies.map((reply) => `${reply.question}\n\n${reply.answer}`).join('\n\n');
}
