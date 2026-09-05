import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LRUCache } from 'lru-cache';
import sirv from 'sirv';
import { WebSocket, WebSocketServer } from 'ws';
import { createConnectorAuthProof, normalizeAuthDeviceId } from '../shared/auth.js';
import { verifyDeviceAuthProof, type DeviceAuthProof } from '../shared/device-auth.js';
import {
  BROWSER_PAIRING_ID_PATTERN,
  DEVICE_KEY_AUTH_CONTEXT,
  createBrowserPairingProof,
} from '../shared/pairing-auth.js';
import {
  createProtocolOffer,
  requireCurrentProtocol,
  type CurrentProtocol,
} from '../shared/protocol-contract.js';
import { DeviceRegistry } from './device-registry.js';
import {
  MAX_FRAME_BYTES,
  createId,
  parseFrame,
  publicError,
  safeSend,
  secretMatches,
} from '../shared/protocol.js';

const moduleDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultPublicDir = resolve(moduleDir, '../../dist');
const AUTH_FAILURE_LIMIT = 8;
const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
const AUTH_LOCK_MS = 15 * 60_000;
const AUTH_MAX_TRACKED_ADDRESSES = 4_096;
const AUTH_SESSION_MAX_AGE_MS = 60 * 60_000;

type JsonObject = Record<string, any>;
type AliveWebSocket = WebSocket & { isAlive?: boolean };
type StaticHandler = ReturnType<typeof sirv>;
type AuthenticatedDevice = Pick<DeviceAuthProof, 'id' | 'publicKey'>;
type SocketMeta =
  | { role: 'client'; id: string; device: AuthenticatedDevice }
  | { role: 'connector'; deviceId: string; device: AuthenticatedDevice };
type BridgeServerOptions = {
  extensionOrigins?: string[];
  connectorToken?: unknown;
  publicDir?: string;
  uiLanguage?: unknown;
  trustProxy?: boolean;
  authFailureLimit?: number;
  authFailureWindowMs?: number;
  authLockMs?: number;
  authMaxEntries?: number;
  sessionMaxAgeMs?: number;
  heartbeatIntervalMs?: number;
  clock?: () => number;
  deviceRegistryPath?: string | null;
  deviceRegistry?: DeviceRegistry;
};
type HttpContext = {
  request: IncomingMessage;
  response: ServerResponse;
  trustProxy: boolean;
  uiLanguage: string;
  staticHandler: StaticHandler;
};
type AuthLimiterOptions = {
  limit?: number;
  windowMs?: number;
  lockMs?: number;
  maxEntries?: number;
  clock?: () => number;
};
type AuthEntry = { failures: number; windowStartedAt: number; lockedUntil: number };

export function createBridgeServer(options: BridgeServerOptions = {}) {
  const extensionOrigins = options.extensionOrigins ?? (process.env.BRIDGE_EXTENSION_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (extensionOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) throw new Error('invalid_extension_origin_allowlist');
  const connectorToken = String(options.connectorToken || process.env.BRIDGE_CONNECTOR_TOKEN || '');
  if (connectorToken.length < 32) throw new Error('BRIDGE_CONNECTOR_TOKEN must contain at least 32 characters');
  const publicDir = resolve(options.publicDir || defaultPublicDir);
  const staticHandler = sirv(publicDir, {
    dev: !existsSync(publicDir),
    etag: true,
    single: true,
    setHeaders(response, pathname) {
      const cacheableAsset = /\.[^/]+$/.test(pathname)
        && !pathname.endsWith('.html');
      response.setHeader('cache-control', cacheableAsset ? 'public, max-age=3600' : 'no-store');
    },
  });
  const uiLanguage = normalizeUiLanguage(options.uiLanguage ?? process.env.CODEX_UI_LANGUAGE);
  const configuredRegistryPath = options.deviceRegistryPath !== undefined
    ? options.deviceRegistryPath
    : process.env.BRIDGE_DEVICE_REGISTRY_FILE || (
      options.connectorToken ? null : resolve('data/devices.json')
    );
  const deviceRegistry = options.deviceRegistry || new DeviceRegistry(configuredRegistryPath);
  const connectors = new Map<string, AliveWebSocket>();
  const clients = new Map<string, AliveWebSocket>();
  const socketMeta = new WeakMap<AliveWebSocket, SocketMeta>();
  const trustProxy = options.trustProxy ?? process.env.BRIDGE_TRUST_PROXY === '1';
  const sessionMaxAgeMs = positiveInteger(
    options.sessionMaxAgeMs ?? Number(process.env.BRIDGE_SESSION_MAX_AGE_MS),
    AUTH_SESSION_MAX_AGE_MS,
  );
  const heartbeatIntervalMs = positiveInteger(options.heartbeatIntervalMs, 30_000);
  const authLimiter = new AuthFailureLimiter({
    limit: options.authFailureLimit,
    windowMs: options.authFailureWindowMs,
    lockMs: options.authLockMs,
    maxEntries: options.authMaxEntries,
    clock: options.clock,
  });

  const httpServer = createServer((request, response) => {
    handleHttpRequest({
      request, response, trustProxy, uiLanguage, staticHandler,
    });
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/ws' || !originAllowed(request, extensionOrigins)) {
      if (url.pathname === '/ws') socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (rawSocket, request) => {
    const socket = rawSocket as AliveWebSocket;
    const clientAddress = getClientAddress(request, trustProxy);
    if (authLimiter.isBlocked(clientAddress)) {
      socket.close(4429, 'authentication temporarily locked');
      return;
    }
    const authTimer = setTimeout(() => socket.close(4001, 'authentication timeout'), 10_000);
    let sessionTimer: NodeJS.Timeout | undefined;
    authTimer.unref?.();
    const authChallenge = randomBytes(32).toString('hex');
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
            socket, message, connectorToken, authChallenge,
            connectors, clients, socketMeta, authTimer,
            authLimiter, clientAddress, deviceRegistry,
          });
          if (authenticated) {
            sessionTimer = setTimeout(() => socket.close(4005, 'authentication expired'), sessionMaxAgeMs);
            sessionTimer.unref?.();
            broadcastPresence(clients, connectors);
          }
          return;
        }
        if (message.type === 'ping') {
          safeSend(socket, { type: 'pong', at: Date.now() });
          return;
        }
        if (meta.role === 'client') {
          routeClientMessage({ socket, meta, message, connectors });
        } else {
          routeConnectorMessage({ message, clients, meta });
        }
      } catch (error) {
        safeSend(socket, { type: 'error', error: publicError(error) });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      const meta = socketMeta.get(socket);
      if (!meta) return;
      if (meta.role === 'client') clients.delete(meta.id);
      if (meta.role === 'connector' && connectors.get(meta.deviceId) === socket) connectors.delete(meta.deviceId);
      broadcastPresence(clients, connectors);
    });
    safeSend(socket, {
      type: 'auth.challenge', challenge: authChallenge, protocol: createProtocolOffer(),
    });
  });

  const heartbeat = setInterval(() => {
    for (const rawSocket of webSocketServer.clients) {
      const socket = rawSocket as AliveWebSocket;
      const meta = socketMeta.get(socket);
      if (meta && !deviceRegistry.isApproved(meta.role, meta.device)) {
        socket.close(4403, 'device approval revoked');
        continue;
      }
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    httpServer, webSocketServer, connectors, clients, deviceRegistry,
    async listen(port = 3300, host = '127.0.0.1') {
      await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error) => reject(error);
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
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    },
  };
}

function handleHttpRequest({ request, response, trustProxy, uiLanguage, staticHandler }: HttpContext) {
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
  staticHandler(request, response, () => {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end(headOnly ? '' : 'Not found');
  });
}

function authenticateSocket({
  socket, message, connectorToken, authChallenge,
  connectors, clients, socketMeta, authTimer, authLimiter, clientAddress, deviceRegistry,
}: {
  socket: AliveWebSocket;
  message: JsonObject;
  connectorToken: string;
  authChallenge: string;
  connectors: Map<string, AliveWebSocket>;
  clients: Map<string, AliveWebSocket>;
  socketMeta: WeakMap<AliveWebSocket, SocketMeta>;
  authTimer: NodeJS.Timeout;
  authLimiter: AuthFailureLimiter;
  clientAddress: string;
  deviceRegistry: DeviceRegistry;
}) {
  const authType = String(message.type || '');
  const role = message.role === 'connector' ? 'connector' : message.role === 'client' ? 'client' : '';
  const deviceId = normalizeAuthDeviceId(message.deviceId);
  let protocol: CurrentProtocol;
  try {
    protocol = requireCurrentProtocol(message.protocol);
  } catch {
    socket.close(4406, 'protocol version unsupported');
    return false;
  }
  const device = message.device && typeof message.device === 'object'
    ? message.device as DeviceAuthProof
    : null;
  if (!role) {
    socket.close(4406, 'device authentication required');
    return false;
  }
  let deviceAuthContext = '';
  let browserPairing: { id: string; verifier: string } | null = null;
  let authMode: 'connector-token' | 'device' | 'pairing';
  if (authType === 'auth.connector' && role === 'connector') {
    let expectedProof = '';
    try {
      expectedProof = createConnectorAuthProof(connectorToken, authChallenge, deviceId);
    } catch {
      expectedProof = '';
    }
    if (!secretMatches(message.proof, expectedProof)) {
      return rejectAuthentication(socket, authLimiter, clientAddress);
    }
    if (!device) {
      socket.close(4406, 'device authentication required');
      return false;
    }
    deviceAuthContext = String(message.proof || '');
    authMode = 'connector-token';
  } else if (!device) {
    socket.close(4406, 'device authentication required');
    return false;
  } else if (authType === 'auth.device' && role === 'client') {
    deviceAuthContext = DEVICE_KEY_AUTH_CONTEXT;
    authMode = 'device';
  } else if (authType === 'auth.enroll' && role === 'client') {
    const pairingId = String(message.pairingId || '');
    if (!BROWSER_PAIRING_ID_PATTERN.test(pairingId)) {
      return rejectAuthentication(socket, authLimiter, clientAddress);
    }
    const verifier = deviceRegistry.getBrowserPairingVerifier(pairingId);
    if (!verifier) return rejectAuthentication(socket, authLimiter, clientAddress);
    let expectedProof = '';
    try {
      expectedProof = createBrowserPairingProof({
        verifier,
        challenge: authChallenge,
        pairingId,
        deviceId: device.id,
        publicKey: device.publicKey,
      });
    } catch {
      expectedProof = '';
    }
    if (!secretMatches(message.proof, expectedProof)) {
      return rejectAuthentication(socket, authLimiter, clientAddress);
    }
    deviceAuthContext = String(message.proof || '');
    browserPairing = { id: pairingId, verifier };
    authMode = 'pairing';
  } else {
    socket.close(4406, 'authentication method unsupported');
    return false;
  }
  let deviceProofValid = false;
  try {
    deviceProofValid = verifyDeviceAuthProof(device, {
      challenge: authChallenge,
      role,
      routeDeviceId: deviceId,
      authProof: deviceAuthContext,
    });
  } catch {
    deviceProofValid = false;
  }
  if (!deviceProofValid) {
    return rejectAuthentication(socket, authLimiter, clientAddress, 4407, 'device authentication failed');
  }
  authLimiter.recordSuccess(clientAddress);
  if (browserPairing) {
    const approved = deviceRegistry.approveBrowserPairing({
      pairingId: browserPairing.id,
      verifier: browserPairing.verifier,
      device,
      label: device.label,
    });
    if (!approved) return rejectAuthentication(socket, authLimiter, clientAddress);
  } else if (!deviceRegistry.isApproved(role, device)) {
    if (authMode === 'connector-token') {
      deviceRegistry.requestPairing({
        role,
        routeDeviceId: deviceId,
        device,
        address: clientAddress,
      });
    }
    safeSend(socket, {
      type: 'auth.pairing',
      role,
      protocol,
    });
    socket.close(4403, 'device approval required');
    return false;
  }
  clearTimeout(authTimer);
  if (role === 'connector') {
    const previous = connectors.get(deviceId);
    if (previous && previous !== socket) previous.close(4004, 'connector replaced');
    connectors.set(deviceId, socket);
    socketMeta.set(socket, {
      role, deviceId, device: { id: device.id, publicKey: device.publicKey },
    });
    safeSend(socket, { type: 'auth.ok', role, deviceId, protocol, authMode });
    return true;
  }
  const id = createId('client');
  clients.set(id, socket);
  socketMeta.set(socket, {
    role, id, device: { id: device.id, publicKey: device.publicKey },
  });
  safeSend(socket, {
    type: 'auth.ok', role, clientId: id,
    devices: [...connectors.keys()].sort(),
    protocol,
    authMode,
  });
  return true;
}

function rejectAuthentication(
  socket: AliveWebSocket,
  authLimiter: AuthFailureLimiter,
  clientAddress: string,
  code = 4003,
  reason = 'authentication failed',
) {
  const locked = authLimiter.recordFailure(clientAddress);
  socket.close(locked ? 4429 : code, locked ? 'authentication temporarily locked' : reason);
  return false;
}

function routeClientMessage({ socket, meta, message, connectors }: {
  socket: AliveWebSocket;
  meta: Extract<SocketMeta, { role: 'client' }>;
  message: JsonObject;
  connectors: Map<string, AliveWebSocket>;
}) {
  const deviceId = String(message.deviceId || 'personal-pc');
  const connector = connectors.get(deviceId);
  if (isSecureClientFrame(message.type)) {
    if (!connector) {
      safeSend(socket, { type: 'channel.error', error: 'connector_offline', deviceId });
      return;
    }
    if (message.type === 'channel.offer') {
      const initiator = message.offer?.initiator;
      if (initiator?.id !== meta.device.id || initiator?.publicKey !== meta.device.publicKey) {
        safeSend(socket, { type: 'channel.error', error: 'secure_channel_identity_mismatch', deviceId });
        return;
      }
      safeSend(connector, { type: message.type, clientId: meta.id, offer: message.offer });
      return;
    }
    if (message.type === 'channel.confirm') {
      safeSend(connector, {
        type: message.type, clientId: meta.id,
        channelId: message.channelId, signature: message.signature,
      });
      return;
    }
    safeSend(connector, { type: message.type, clientId: meta.id, envelope: message.envelope });
    return;
  }
  safeSend(socket, { type: 'error', requestId: message.requestId, error: 'secure_channel_required' });
}

function routeConnectorMessage({ message, clients, meta }: {
  message: JsonObject;
  clients: Map<string, AliveWebSocket>;
  meta: Extract<SocketMeta, { role: 'connector' }>;
}) {
  if (isSecureConnectorFrame(message.type)) {
    const clientId = String(message.clientId || '');
    const client = clients.get(clientId);
    if (!client) return;
    if (message.type === 'channel.accept') {
      const responder = message.accept?.transcript?.responder;
      if (responder?.id !== meta.device.id || responder?.publicKey !== meta.device.publicKey) return;
      safeSend(client, { type: message.type, accept: message.accept, deviceId: meta.deviceId });
      return;
    }
    if (message.type === 'channel.ready' || message.type === 'channel.error') {
      safeSend(client, {
        type: message.type, channelId: message.channelId,
        error: message.error, deviceId: meta.deviceId,
      });
      return;
    }
    safeSend(client, { type: message.type, envelope: message.envelope, deviceId: meta.deviceId });
    return;
  }
}

function isSecureClientFrame(type: unknown) {
  return type === 'channel.offer' || type === 'channel.confirm' || type === 'secure';
}

function isSecureConnectorFrame(type: unknown) {
  return type === 'channel.accept' || type === 'channel.ready'
    || type === 'channel.error' || type === 'secure';
}

function broadcastPresence(
  clients: Map<string, AliveWebSocket>,
  connectors: Map<string, AliveWebSocket>,
) {
  const payload = {
    type: 'presence',
    devices: [...connectors.keys()].sort(),
  };
  for (const socket of clients.values()) safeSend(socket, payload);
}

function normalizeUiLanguage(value: unknown) {
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

function setSecurityHeaders(response: ServerResponse, request: IncomingMessage, trustProxy: boolean) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.setHeader('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
  const webSocketSource = currentWebSocketSource(request, trustProxy);
  response.setHeader('content-security-policy', `default-src 'self'; connect-src 'self'${webSocketSource ? ` ${webSocketSource}` : ''}; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
}

function currentWebSocketSource(request: IncomingMessage | undefined, trustProxy: boolean) {
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

class AuthFailureLimiter {
  limit: number;
  windowMs: number;
  lockMs: number;
  clock: () => number;
  entries: LRUCache<string, AuthEntry>;

  constructor(options: AuthLimiterOptions = {}) {
    this.limit = positiveInteger(options.limit, AUTH_FAILURE_LIMIT);
    this.windowMs = positiveInteger(options.windowMs, AUTH_FAILURE_WINDOW_MS);
    this.lockMs = positiveInteger(options.lockMs, AUTH_LOCK_MS);
    this.clock = options.clock || (() => Date.now());
    this.entries = new LRUCache({
      max: positiveInteger(options.maxEntries, AUTH_MAX_TRACKED_ADDRESSES),
    });
  }

  isBlocked(address: string) {
    const entry = this.entries.get(address);
    if (!entry) return false;
    const now = this.clock();
    if (entry.lockedUntil > now) return true;
    if (entry.lockedUntil || now - entry.windowStartedAt >= this.windowMs) this.entries.delete(address);
    return false;
  }

  recordFailure(address: string) {
    const now = this.clock();
    let entry = this.entries.get(address);
    if (!entry || entry.lockedUntil || now - entry.windowStartedAt >= this.windowMs) {
      entry = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
      this.entries.set(address, entry);
    }
    entry.failures += 1;
    if (entry.failures >= this.limit) entry.lockedUntil = now + this.lockMs;
    this.entries.set(address, entry);
    return entry.lockedUntil > now;
  }

  recordSuccess(address: string) {
    this.entries.delete(address);
  }
}

function getClientAddress(request: IncomingMessage, trustProxy: boolean) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-real-ip'] || '').trim();
    if (isIP(forwarded)) return forwarded;
  }
  return String(request.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function originAllowed(request: IncomingMessage, extensionOrigins: readonly string[] = []) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return extensionOrigins.includes(origin);
  try {
    const originUrl = new URL(origin);
    const host = String(request.headers.host || '').trim().toLocaleLowerCase();
    return (originUrl.protocol === 'https:' || originUrl.protocol === 'http:')
      && originUrl.host.toLocaleLowerCase() === host;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export const internals = {
  AuthFailureLimiter, currentWebSocketSource, getClientAddress, originAllowed,
};
