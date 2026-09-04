import { requireBrowserId, requireInteger, requireRecord } from './contracts.js';

export type BrowserOperation =
  | { method: 'snapshot' }
  | { method: 'click'; ref: string }
  | { method: 'fill'; ref: string; text: string }
  | { method: 'scroll'; deltaY: number };

export function parseOperation(value: unknown): BrowserOperation {
  const input = requireRecord(value, ['method', 'ref', 'text', 'deltaY']);
  if (input.method === 'snapshot' && Object.keys(input).length === 1) return { method: 'snapshot' };
  if (input.method === 'scroll' && Object.keys(input).length === 2) {
    return { method: 'scroll', deltaY: requireInteger(input.deltaY, -2000, 2000) };
  }
  if (input.method === 'click' && Object.keys(input).length === 2) return { method: 'click', ref: requireBrowserId(input.ref) };
  if (input.method === 'fill' && Object.keys(input).length === 3 && typeof input.text === 'string' && input.text.length <= 4000) {
    return { method: 'fill', ref: requireBrowserId(input.ref), text: input.text };
  }
  throw new Error('browser_invalid_operation');
}

// Only the MCP host supplies this metadata. Session IDs are NEVER tool arguments.
export function codexCaller(meta: unknown) {
  if (!meta || typeof meta !== 'object') throw new Error('browser_host_context_required');
  const input = meta as Record<string, unknown>;
  const context = input['x-codex-turn-metadata'] as Record<string, unknown> | undefined;
  const threadId = requireBrowserId(context?.thread_id);
  const turnId = requireBrowserId(context?.turn_id);
  if (input.threadId !== undefined && input.threadId !== threadId) throw new Error('browser_host_context_mismatch');
  return { threadId, turnId };
}
