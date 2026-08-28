import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  CLIENT_ACTIONS,
  MAX_FRAME_BYTES,
  createId,
  parseFrame,
  publicError,
  safeSend,
  tokenMatches,
} from '../shared/protocol.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const moduleDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultPublicDir = resolve(moduleDir, '../../dist');
const AUTH_FAILURE_LIMIT = 8;
const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
const AUTH_LOCK_MS = 15 * 60_000;

export function createBridgeServer(options = {}) {
  const token = String(options.token || process.env.BRIDGE_TOKEN || '');
  if (token.length < 32) throw new Error('BRIDGE_TOKEN must contain at least 32 characters');
  const publicDir = resolve(options.publicDir || defaultPublicDir);
  const connectors = new Map();
  const clients = new Map();
  const socketMeta = new WeakMap();
  const trustProxy = options.trustProxy ?? process.env.BRIDGE_TRUST_PROXY === '1';
  const authLimiter = new AuthFailureLimiter({
    limit: options.authFailureLimit,
    windowMs: options.authFailureWindowMs,
    lockMs: options.authLockMs,
    clock: options.clock,
  });

  const httpServer = createServer((request, response) => {
    setSecurityHeaders(response);
    if (request.url === '/health' || request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    serveStatic(publicDir, request, response);
  });
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/ws' || !originAllowed(request)) {
      if (url.pathname === '/ws') socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (socket, request) => {
    const clientAddress = getClientAddress(request, trustProxy);
    if (authLimiter.isBlocked(clientAddress)) {
      socket.close(4429, 'authentication temporarily locked');
      return;
    }
    const authTimer = setTimeout(() => socket.close(4001, 'authentication timeout'), 10_000);
    authTimer.unref?.();
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (data) => {
      try {
        const message = parseFrame(data);
        const meta = socketMeta.get(socket);
        if (!meta) {
          if (authLimiter.isBlocked(clientAddress)) {
            socket.close(4429, 'authentication temporarily locked');
            return;
          }
          const authenticated = authenticateSocket({
            socket, message, token, connectors, clients, socketMeta, authTimer,
            authLimiter, clientAddress,
          });
          if (authenticated) broadcastPresence(clients, connectors);
          return;
        }
        if (message.type === 'ping') {
          safeSend(socket, { type: 'pong', at: Date.now() });
          return;
        }
        if (meta.role === 'client') routeClientMessage({ socket, meta, message, connectors });
        else routeConnectorMessage({ message, clients, meta });
      } catch (error) {
        safeSend(socket, { type: 'error', error: publicError(error) });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      const meta = socketMeta.get(socket);
      if (!meta) return;
      if (meta.role === 'client') clients.delete(meta.id);
      if (meta.role === 'connector' && connectors.get(meta.deviceId) === socket) connectors.delete(meta.deviceId);
      broadcastPresence(clients, connectors);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  return {
    httpServer, webSocketServer, connectors, clients,
    async listen(port = 3300, host = '127.0.0.1') {
      await new Promise((resolveListen, reject) => {
        const onError = (error) => reject(error);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.off('error', onError);
          resolveListen();
        });
      });
      return httpServer.address();
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of webSocketServer.clients) socket.close(1001, 'server shutdown');
      await new Promise((resolveClose) => httpServer.close(() => resolveClose()));
    },
  };
}

function authenticateSocket({
  socket, message, token, connectors, clients, socketMeta, authTimer, authLimiter, clientAddress,
}) {
  if (message.type !== 'auth' || !tokenMatches(message.token, token)) {
    const locked = authLimiter.recordFailure(clientAddress);
    socket.close(locked ? 4429 : 4003, locked ? 'authentication temporarily locked' : 'authentication failed');
    return false;
  }
  const role = message.role === 'connector' ? 'connector' : message.role === 'client' ? 'client' : '';
  if (!role) {
    const locked = authLimiter.recordFailure(clientAddress);
    socket.close(locked ? 4429 : 4003, locked ? 'authentication temporarily locked' : 'invalid role');
    return false;
  }
  authLimiter.recordSuccess(clientAddress);
  clearTimeout(authTimer);
  if (role === 'connector') {
    const deviceId = String(message.deviceId || 'personal-pc').trim().slice(0, 128);
    const previous = connectors.get(deviceId);
    if (previous && previous !== socket) previous.close(4004, 'connector replaced');
    connectors.set(deviceId, socket);
    socketMeta.set(socket, { role, deviceId });
    safeSend(socket, { type: 'auth.ok', role, deviceId });
    return true;
  }
  const id = createId('client');
  clients.set(id, socket);
  socketMeta.set(socket, { role, id });
  safeSend(socket, { type: 'auth.ok', role, clientId: id, devices: [...connectors.keys()] });
  return true;
}

function routeClientMessage({ socket, meta, message, connectors }) {
  if (message.type !== 'request' || !CLIENT_ACTIONS.has(message.action)) {
    safeSend(socket, { type: 'error', requestId: message.requestId, error: 'unsupported_action' });
    return;
  }
  const deviceId = String(message.deviceId || 'personal-pc');
  const connector = connectors.get(deviceId);
  if (!connector) {
    safeSend(socket, { type: 'response', requestId: message.requestId, ok: false, error: 'connector_offline' });
    return;
  }
  safeSend(connector, {
    type: 'request',
    requestId: String(message.requestId || createId('request')),
    action: message.action,
    payload: message.payload && typeof message.payload === 'object' ? message.payload : {},
    clientId: meta.id,
  });
}

function routeConnectorMessage({ message, clients, meta }) {
  if (message.type !== 'response' && message.type !== 'event') return;
  const client = clients.get(String(message.clientId || ''));
  if (!client) return;
  safeSend(client, { ...message, deviceId: meta.deviceId });
}

function broadcastPresence(clients, connectors) {
  const payload = { type: 'presence', devices: [...connectors.keys()] };
  for (const socket of clients.values()) safeSend(socket, payload);
}

function serveStatic(publicDir, request, response) {
  const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  const relative = requestPath === '/' ? 'index.html' : normalize(requestPath).replace(/^([/\\])+/, '');
  let filePath = resolve(join(publicDir, relative));
  const boundary = `${publicDir}${process.platform === 'win32' ? '\\' : '/'}`;
  if (!filePath.startsWith(boundary) && filePath !== publicDir) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(publicDir, 'index.html');
  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
    'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(filePath).pipe(response);
}

function setSecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

class AuthFailureLimiter {
  constructor(options = {}) {
    this.limit = positiveInteger(options.limit, AUTH_FAILURE_LIMIT);
    this.windowMs = positiveInteger(options.windowMs, AUTH_FAILURE_WINDOW_MS);
    this.lockMs = positiveInteger(options.lockMs, AUTH_LOCK_MS);
    this.clock = options.clock || (() => Date.now());
    this.entries = new Map();
  }

  isBlocked(address) {
    const entry = this.entries.get(address);
    if (!entry) return false;
    const now = this.clock();
    if (entry.lockedUntil > now) return true;
    if (entry.lockedUntil || now - entry.windowStartedAt >= this.windowMs) this.entries.delete(address);
    return false;
  }

  recordFailure(address) {
    const now = this.clock();
    let entry = this.entries.get(address);
    if (!entry || entry.lockedUntil || now - entry.windowStartedAt >= this.windowMs) {
      entry = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
      this.entries.set(address, entry);
    }
    entry.failures += 1;
    if (entry.failures >= this.limit) entry.lockedUntil = now + this.lockMs;
    this.#prune(now);
    return entry.lockedUntil > now;
  }

  recordSuccess(address) {
    this.entries.delete(address);
  }

  #prune(now) {
    if (this.entries.size < 1_000) return;
    for (const [address, entry] of this.entries) {
      if ((entry.lockedUntil && entry.lockedUntil <= now)
        || (!entry.lockedUntil && now - entry.windowStartedAt >= this.windowMs)) {
        this.entries.delete(address);
      }
    }
  }
}

function getClientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-real-ip'] || '').trim();
    if (isIP(forwarded)) return forwarded;
  }
  return String(request.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function originAllowed(request) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = String(request.headers.host || '').trim().toLocaleLowerCase();
    return (originUrl.protocol === 'https:' || originUrl.protocol === 'http:')
      && originUrl.host.toLocaleLowerCase() === host;
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const internals = { AuthFailureLimiter, getClientAddress, originAllowed };
