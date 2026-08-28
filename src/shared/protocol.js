import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const CLIENT_ACTIONS = new Set([
  'connector.status', 'sessions.list', 'session.read', 'session.turns.list',
  'attachment.upload', 'attachment.read',
  'file.download.open', 'file.download.chunk', 'file.download.close',
  'turn.start', 'turn.stop', 'approval.respond',
]);

export function createId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function parseFrame(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error('frame_too_large');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_frame');
  return value;
}

export function safeSend(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify({ version: PROTOCOL_VERSION, ...payload }));
  return true;
}

export function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function publicError(error) {
  const message = String(error?.message || error || 'unknown_error');
  if (/token|secret|password|credential/i.test(message)) return 'authentication_failed';
  return message.slice(0, 500);
}

export function requireSecureBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('bridge_url_invalid');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('bridge_url_invalid');
  if (url.username || url.password || url.search || url.hash) throw new Error('bridge_url_invalid');
  if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) {
    throw new Error('bridge_url_tls_required');
  }
  return url.href;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLocaleLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}
