import { browserOrigin, requireInteger, requireRecord } from './contracts.js';

export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const SCREENSHOT_MAX_EDGE = 1920;
export const SCREENSHOT_MAX_BASE64 = Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4;
export const SCREENSHOT_MAX_RESULT_CHARS = SCREENSHOT_MAX_BASE64 + 4096;
export const SCREENSHOT_TIMEOUT_MS = 60_000;

export type BrowserScreenshot = {
  kind: 'screenshot'; mimeType: 'image/jpeg'; data: string;
  width: number; height: number; origin: string; redactedRegions: number;
};

// Validate the encoded file and its declared dimensions at each trust boundary.
// No image parser, decompression or browser-controlled paths are needed in MCP.
export function parseScreenshot(value: unknown): BrowserScreenshot {
  try {
    const input = requireRecord(value, ['kind', 'mimeType', 'data', 'width', 'height', 'origin', 'redactedRegions']);
    if (input.kind !== 'screenshot' || input.mimeType !== 'image/jpeg' || typeof input.data !== 'string'
      || input.data.length > SCREENSHOT_MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new Error();
    const data = atob(input.data);
    if (data.length > SCREENSHOT_MAX_BYTES || data.length < 4 || data.charCodeAt(0) !== 255 || data.charCodeAt(1) !== 216
      || data.charCodeAt(data.length - 2) !== 255 || data.charCodeAt(data.length - 1) !== 217) throw new Error();
    const width = requireInteger(input.width, 1, SCREENSHOT_MAX_EDGE), height = requireInteger(input.height, 1, SCREENSHOT_MAX_EDGE);
    let dimensions = false, scan = false;
    for (let offset = 2; offset + 4 <= data.length;) {
      if (data.charCodeAt(offset++) !== 255) throw new Error();
      while (data.charCodeAt(offset) === 255) offset++;
      const marker = data.charCodeAt(offset++);
      if (marker === 217) break;
      const length = data.charCodeAt(offset) * 256 + data.charCodeAt(offset + 1);
      if (length < 2 || offset + length > data.length) throw new Error();
      if (marker === 218) { scan = length >= 6 && offset + length < data.length - 2; break; }
      if ([192, 193, 194].includes(marker)) {
        if (length < 8 || data.charCodeAt(offset + 3) * 256 + data.charCodeAt(offset + 4) !== height
          || data.charCodeAt(offset + 5) * 256 + data.charCodeAt(offset + 6) !== width) throw new Error();
        dimensions = true;
      }
      offset += length;
    }
    if (!dimensions || !scan) throw new Error();
    const origin = browserOrigin(input.origin);
    if (origin !== input.origin) throw new Error();
    return { kind: 'screenshot', mimeType: 'image/jpeg', data: input.data, width, height, origin,
      redactedRegions: requireInteger(input.redactedRegions, 0, 20_000) };
  } catch { throw new Error('browser_screenshot_invalid'); }
}
