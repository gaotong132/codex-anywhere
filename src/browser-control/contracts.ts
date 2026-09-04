export type BrowserTarget = Readonly<{
  browserDeviceId: string;
  tabId: number;
  documentId: string;
  origin: string;
}>;

export function requireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('browser_invalid_request');
  return value as Record<string, unknown>;
}

export function requireBrowserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw new Error('browser_invalid_identity');
  return value;
}

export function requireInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('browser_invalid_request');
  return value;
}

export function browserOrigin(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error();
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new Error('browser_origin_not_allowed'); }
}

export function parseBrowserTarget(value: unknown): BrowserTarget {
  const input = requireRecord(value, ['browserDeviceId', 'tabId', 'documentId', 'origin']);
  const origin = browserOrigin(input.origin);
  if (input.origin !== origin) throw new Error('browser_origin_not_allowed');
  return Object.freeze({ browserDeviceId: requireBrowserId(input.browserDeviceId),
    tabId: requireInteger(input.tabId, 0, Number.MAX_SAFE_INTEGER), documentId: requireBrowserId(input.documentId), origin });
}
