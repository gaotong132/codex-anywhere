// Browser control is a separate resource domain, not a Codex execution environment.
// These contracts are experimental and are NOT accepted by the production relay yet.
export const BROWSER_CONTROL_VERSION = 1;
export const MAX_BROWSER_GRANT_MS = 10 * 60_000;
export const MAX_BROWSER_REQUEST_MS = 15_000;
export const SNAPSHOT_LIMITS = Object.freeze({ maxNodes: 100, maxChars: 8_000 });

export type BrowserOwner = Readonly<{
  environmentId: string;
  threadId: string;
  // The authenticated controller device, not a model-supplied identifier.
  controllerId: string;
}>;
export type BrowserTarget = Readonly<{
  browserDeviceId: string;
  tabId: number;
  documentId: string;
  origin: string;
}>;
export type SnapshotOptions = { maxNodes: number; maxChars: number };
export type BrowserReadRequest = {
  version: typeof BROWSER_CONTROL_VERSION;
  requestId: string;
  grantId: string;
  sequence: number;
  deadline: number;
  method: 'browser.snapshot';
  params: SnapshotOptions;
};

export class BrowserControlError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BrowserControlError'; }
}

export function requireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new BrowserControlError('browser_invalid_request');
  }
  return value as Record<string, unknown>;
}

export function requireBrowserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new BrowserControlError('browser_invalid_identity');
  }
  return value;
}

export function requireInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BrowserControlError('browser_invalid_request');
  }
  return value;
}

export function browserOrigin(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 4_096) throw new Error();
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new BrowserControlError('browser_origin_not_allowed'); }
}

export function parseBrowserOwner(value: unknown): BrowserOwner {
  const input = requireRecord(value, ['environmentId', 'threadId', 'controllerId']);
  return Object.freeze({
    environmentId: requireBrowserId(input.environmentId),
    threadId: requireBrowserId(input.threadId),
    controllerId: requireBrowserId(input.controllerId),
  });
}

export function parseBrowserTarget(value: unknown): BrowserTarget {
  const input = requireRecord(value, ['browserDeviceId', 'tabId', 'documentId', 'origin']);
  const origin = browserOrigin(input.origin);
  if (input.origin !== origin) throw new BrowserControlError('browser_origin_not_allowed');
  return Object.freeze({
    browserDeviceId: requireBrowserId(input.browserDeviceId),
    tabId: requireInteger(input.tabId, 0, Number.MAX_SAFE_INTEGER),
    documentId: requireBrowserId(input.documentId),
    origin,
  });
}

export function parseSnapshotOptions(value: unknown): SnapshotOptions {
  const input = requireRecord(value ?? {}, ['maxNodes', 'maxChars']);
  return {
    maxNodes: requireInteger(input.maxNodes ?? SNAPSHOT_LIMITS.maxNodes, 1, 200),
    maxChars: requireInteger(input.maxChars ?? SNAPSHOT_LIMITS.maxChars, 1, 16_000),
  };
}

export function parseBrowserReadRequest(value: unknown): BrowserReadRequest {
  const input = requireRecord(value, ['version', 'requestId', 'grantId', 'sequence', 'deadline', 'method', 'params']);
  if (input.version !== BROWSER_CONTROL_VERSION || input.method !== 'browser.snapshot') {
    throw new BrowserControlError('browser_method_not_supported');
  }
  return {
    version: BROWSER_CONTROL_VERSION,
    requestId: requireBrowserId(input.requestId),
    grantId: requireBrowserId(input.grantId),
    sequence: requireInteger(input.sequence, 1, Number.MAX_SAFE_INTEGER),
    deadline: requireInteger(input.deadline, 1, Number.MAX_SAFE_INTEGER),
    method: 'browser.snapshot',
    params: parseSnapshotOptions(input.params),
  };
}
