import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type sirv from 'sirv';
import { SIDEPANEL_PATH, sidePanelTarget } from '../shared/sidepanel.js';

type StaticHandler = ReturnType<typeof sirv>;
type HttpContext = {
  extensionOrigins: readonly string[];
  request: IncomingMessage;
  response: ServerResponse;
  trustProxy: boolean;
  uiLanguage: string;
  staticHandler: StaticHandler;
};
export function handleHttpRequest({ request, response, trustProxy, uiLanguage, staticHandler, extensionOrigins }: HttpContext) {
  setSecurityHeaders(response, request, trustProxy);
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
    response.end('Method not allowed');
    return;
  }
  const headOnly = method === 'HEAD';
  let pathname;
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
    decodeURIComponent(pathname);
  } catch {
    response.writeHead(400, { 'cache-control': 'no-store' });
    response.end(headOnly ? '' : 'Bad request');
    return;
  }
  if (pathname === '/health' || pathname === '/healthz') {
    const body = JSON.stringify({ ok: true });
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    response.end(headOnly ? '' : body);
    return;
  }
  if (pathname === '/config.js') {
    serveRuntimeConfig(response, uiLanguage, headOnly);
    return;
  }
  if (pathname === SIDEPANEL_PATH) {
    const target = sidePanelTarget(new URL(request.url!, 'http://localhost'));
    if (!target || !extensionOrigins.includes(target.origin)) {
      response.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end(headOnly ? '' : 'Side panel unavailable. Allow this extension Origin in BRIDGE_EXTENSION_ORIGINS on the relay.');
      return;
    }
    setSecurityHeaders(response, request, trustProxy, target.origin);
  }
  staticHandler(request, response, () => {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end(headOnly ? '' : 'Not found');
  });
}

export function normalizeUiLanguage(value: unknown) {
  return String(value || '').trim().toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

function serveRuntimeConfig(
  response: ServerResponse,
  locale: string,
  headOnly = false,
) {
  const body = `window.__CODEX_ANYWHERE_CONFIG__ = ${JSON.stringify({
    locale,
  })};\n`;
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(headOnly ? '' : body);
}

function setSecurityHeaders(response: ServerResponse, request: IncomingMessage, trustProxy: boolean, embeddingOrigin?: string) {
  response.setHeader('x-content-type-options', 'nosniff');
  if (embeddingOrigin) response.removeHeader('x-frame-options');
  else response.setHeader('x-frame-options', 'DENY');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.setHeader('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
  const webSocketSource = currentWebSocketSource(request, trustProxy);
  response.setHeader('content-security-policy', `default-src 'self'; connect-src 'self'${webSocketSource ? ` ${webSocketSource}` : ''}; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors ${embeddingOrigin || "'none'"}`);
}

export function currentWebSocketSource(request: IncomingMessage | undefined, trustProxy: boolean) {
  if (!request) return '';
  const host = String(request.headers?.host || '').trim();
  if (!host) return '';
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    const forwardedProtocol = trustProxy
      ? String(request.headers['x-forwarded-proto'] || '').trim().toLocaleLowerCase()
      : '';
    const protocol = forwardedProtocol === 'https' || (request.socket as TLSSocket | undefined)?.encrypted ? 'wss' : 'ws';
    return `${protocol}://${parsed.host}`;
  } catch {
    return '';
  }
}
