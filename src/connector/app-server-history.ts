import { summarizeToolActivity } from '../shared/activity-detail.js';
import {
  parseAssistantMessage, parseInjectedUserMessage, parseUserMessage,
} from '../shared/message-content.js';
import { publicError } from '../shared/protocol.js';
import { extractGeneratedImageAttachment } from './generated-images.js';

type JsonObject = Record<string, any>;

export function summarizeItem(item: JsonObject) {
  const detail = summarizeToolActivity(item);
  return {
    type: item.type || '',
    status: item.status || '',
    ...(detail ? { detail } : {}),
  };
}

export function isReasoningMethod(method: string) {
  return /reasoning/i.test(method) && /delta|summary|completed/i.test(method);
}

export function extractText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.delta === 'string') return value.delta;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.summary === 'string') return value.summary;
  if (Array.isArray(value.summary)) return value.summary.map(extractText).filter(Boolean).join('\n');
  if (Array.isArray(value.content)) return value.content.map(extractText).filter(Boolean).join('\n');
  if (Array.isArray(value.input)) return value.input.map(extractText).filter(Boolean).join('\n');
  if (value.item) return extractText(value.item);
  return '';
}

export function mapTurns(turns: unknown) {
  return (Array.isArray(turns) ? turns : []).map((turn: JsonObject) => {
    const rawItems = Array.isArray(turn.items) ? turn.items : [];
    const items: JsonObject[] = rawItems
      .filter((item: JsonObject) => {
        const type = String(item.type || '');
        return Boolean(parseInjectedUserMessage(item))
          || Boolean(extractGeneratedImageAttachment(item))
          || (!/reasoning|command|tool|webSearch|fileChange|system|developer/i.test(type)
            && /user|agent|assistant|message/i.test(type));
      })
      .map((item: JsonObject) => {
        const injectedUserMessage = parseInjectedUserMessage(item);
        const attachment = extractGeneratedImageAttachment(item);
        const userMessage = Boolean(injectedUserMessage) || /user/i.test(String(item.type || ''));
        const completedAt = item.completedAt || item.updatedAt || item.createdAt || item.timestamp
          || (userMessage ? turn.startedAt : turn.completedAt) || null;
        const timing = completedAt ? { completedAt } : {};
        if (attachment) {
          return {
            type: 'agentMessage', phase: 'final_answer', status: item.status || '', text: '', attachment,
            ...timing,
          };
        }
        const content = injectedUserMessage || (userMessage
          ? parseUserMessage(extractText(item)) : parseAssistantMessage(extractText(item)));
        return {
          type: injectedUserMessage ? 'userMessage' : item.type,
          phase: item.phase || '',
          status: item.status || '',
          ...content,
          ...timing,
        };
      })
      .filter((item: JsonObject) => item.text || item.attachment);
    const toolSummary = summarizeTurnTools(rawItems);
    if (toolSummary) {
      const finalIndex = items.findIndex((item: JsonObject) => item.phase === 'final_answer');
      items.splice(finalIndex < 0 ? items.length : finalIndex, 0, {
        type: 'timelineNotice', text: '', notice: toolSummary,
        completedAt: turn.completedAt || null,
      });
    }
    const status = String(turn.status?.type || turn.status || '');
    if (/failed|aborted|error/i.test(status)) {
      const detailValue = turn.error?.message || turn.error || turn.message || turn.reason;
      const rawDetail = typeof detailValue === 'string' ? detailValue.trim() : '';
      const detail = rawDetail ? publicError(rawDetail).slice(0, 500) : '';
      items.push({
        type: 'timelineNotice', text: '',
        notice: {
          kind: 'turnStatus',
          status: /aborted/i.test(status) ? 'aborted' : /error/i.test(status) ? 'error' : 'failed',
          ...(detail ? { detail } : {}),
        },
        completedAt: turn.completedAt || null,
      });
    }
    return {
      id: turn.id,
      status,
      startedAt: turn.startedAt || null,
      completedAt: turn.completedAt || null,
      items,
    };
  });
}

function summarizeTurnTools(items: JsonObject[]) {
  const counts = {
    commands: 0, edits: 0, searches: 0, connectedTools: 0, generations: 0, other: 0,
  };
  let total = 0;
  for (const item of items) {
    const type = String(item?.type || '');
    if (!/command|tool|webSearch|fileChange|mcp/i.test(type)
      || /output/i.test(type)) continue;
    const label = summarizeToolActivity(item).split(' · ')[0]?.toLowerCase() || '';
    if (!label) continue;
    const field = /command|exec_command/.test(label) ? 'commands'
      : /file.?change|apply_patch|patch/.test(label) ? 'edits'
        : /web|search/.test(label) ? 'searches'
          : /image.?gen/.test(label) ? 'generations'
            : /mcp/.test(label) ? 'connectedTools'
              : 'other';
    counts[field] += 1;
    total += 1;
  }
  return total ? {
    kind: 'toolSummary', total,
    ...Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)),
  } : undefined;
}
