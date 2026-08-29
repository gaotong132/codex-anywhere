import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { LRUCache } from 'lru-cache';

export const VISUALIZATION_PREVIEW_PREFIX = '/visualization-preview/';
export const VISUALIZATION_PREVIEW_TTL_MS = 5 * 60_000;
export const MAX_VISUALIZATION_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_VISUALIZATION_PREVIEW_CACHE_BYTES = 16 * 1024 * 1024;
const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class VisualizationPreviewStore {
  private readonly previews: LRUCache<string, string>;

  constructor(options: { ttlMs?: number; maxBytes?: number } = {}) {
    this.previews = new LRUCache({
      maxSize: options.maxBytes || MAX_VISUALIZATION_PREVIEW_CACHE_BYTES,
      sizeCalculation: (content) => Math.max(1, Buffer.byteLength(content, 'utf8')),
      ttl: options.ttlMs || VISUALIZATION_PREVIEW_TTL_MS,
    });
  }

  create(content: unknown) {
    if (typeof content !== 'string' || content.includes('\0')) throw new Error('visualization_content_invalid');
    const document = /^\s*(?:<!doctype\s+html|<html\b)/i.test(content)
      ? content
      : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;min-height:100%}</style></head><body>${content}</body></html>`;
    const size = Buffer.byteLength(document, 'utf8');
    if (size < 1 || size > MAX_VISUALIZATION_PREVIEW_BYTES) throw new Error('visualization_content_invalid');
    const token = randomBytes(32).toString('base64url');
    this.previews.set(token, document);
    return `${VISUALIZATION_PREVIEW_PREFIX}${token}`;
  }

  read(pathname: string) {
    if (!pathname.startsWith(VISUALIZATION_PREVIEW_PREFIX)) return undefined;
    const token = pathname.slice(VISUALIZATION_PREVIEW_PREFIX.length);
    if (!PREVIEW_TOKEN_PATTERN.test(token)) return undefined;
    return this.previews.get(token);
  }

  clear() {
    this.previews.clear();
  }
}
