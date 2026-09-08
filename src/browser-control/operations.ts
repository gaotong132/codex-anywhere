import { requireBrowserId, requireInteger, requireRecord } from './contracts.js';

export type BrowserOperation =
  | { method: 'snapshot' }
  | { method: 'screenshot' }
  | { method: 'zoom'; percent: number }
  | { method: 'click'; ref: string }
  | { method: 'open_link'; ref: string }
  | { method: 'fill'; ref: string; text: string }
  | { method: 'scroll'; deltaY: number; deltaX?: number; ref?: string };

// Only fixed codes cross the page/extension/connector boundary, never exception text.
export function browserOperationErrorCode(value: unknown): string {
  return typeof value === 'string' && [
    'browser_child_permission_required', 'browser_child_origin_denied', 'browser_operation_timeout',
    'browser_screenshot_permission_required', 'browser_screenshot_unavailable', 'browser_screenshot_changed',
    'browser_screenshot_too_large', 'browser_screenshot_invalid',
    'browser_zoom_unavailable', 'browser_zoom_interrupted',
    'browser_document_changed', 'browser_stale_element_read_again', 'browser_element_not_allowed',
    'browser_element_obscured', 'browser_input_not_allowed', 'browser_number_value_invalid',
    'browser_native_click_permission_required', 'browser_native_click_unavailable', 'browser_native_click_interrupted',
    'browser_option_not_available', 'browser_select_multiple_not_supported', 'browser_scroll_target_not_scrollable',
    'browser_link_required', 'browser_navigation_not_allowed',
  ].includes(value) ? value : 'browser_operation_failed_or_authorization_changed';
}

export function parseOperation(value: unknown): BrowserOperation {
  const input = requireRecord(value, ['method', 'ref', 'text', 'deltaY', 'deltaX', 'percent']);
  if (input.method === 'snapshot' && Object.keys(input).length === 1) return { method: 'snapshot' };
  if (input.method === 'screenshot' && Object.keys(input).length === 1) return { method: 'screenshot' };
  if (input.method === 'zoom' && Object.keys(input).length === 2) return { method: 'zoom', percent: requireInteger(input.percent, 50, 200) };
  if (input.method === 'scroll') {
    requireRecord(input, ['method', 'deltaY', 'deltaX', 'ref']);
    return { method: 'scroll', deltaY: requireInteger(input.deltaY, -2000, 2000),
      ...(input.deltaX === undefined ? {} : { deltaX: requireInteger(input.deltaX, -2000, 2000) }),
      ...(input.ref === undefined ? {} : { ref: requireBrowserId(input.ref) }) };
  }
  if (input.method === 'click' && Object.keys(input).length === 2) return { method: 'click', ref: requireBrowserId(input.ref) };
  if (input.method === 'open_link' && Object.keys(input).length === 2) return { method: 'open_link', ref: requireBrowserId(input.ref) };
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
