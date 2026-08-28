import { WebSocket } from 'ws';
import { delimiter } from 'node:path';
import { CodexAppServer } from './codex-app-server.js';
import { CodexDesktopClient } from './codex-desktop.js';
import { readImageAttachment, saveImageAttachment } from './attachments.js';
import { DownloadManager } from './file-downloads.js';
import { acquireConnectorInstanceLock } from './instance-lock.js';
import { createRequestHandler } from './request-handler.js';
import {
  MAX_FRAME_BYTES, normalizeBridgeUrl, parseFrame, safeSend,
} from '../shared/protocol.js';

const token = String(process.env.BRIDGE_TOKEN || '');
if (token.length < 32) throw new Error('BRIDGE_TOKEN must contain at least 32 characters');
const url = normalizeBridgeUrl(process.env.BRIDGE_URL || 'ws://127.0.0.1:3300/ws');
const deviceId = process.env.BRIDGE_DEVICE_ID || 'personal-pc';
const workspace = process.env.CODEX_WORKSPACE || process.cwd();
const allowedRoots = String(process.env.CODEX_ALLOWED_ROOTS || workspace)
  .split(delimiter).map((value) => value.trim()).filter(Boolean);
const instanceLock = await acquireConnectorInstanceLock();
if (!instanceLock) {
  console.log('Codex Anywhere connector is already running.');
  process.exit(0);
}
const connectorLock = instanceLock;
const codex = new CodexAppServer({
  bin: process.env.CODEX_BIN || 'codex', workspace, allowedRoots,
  networkAccess: process.env.CODEX_NETWORK_ACCESS === '1',
});
const desktop = new CodexDesktopClient();
const downloads = new DownloadManager({
  allowedRoots,
  allowAnyFileDownload: process.env.CODEX_ALLOW_ANY_FILE_DOWNLOAD === '1',
});
const handleRequest = createRequestHandler({
  codex,
  desktop,
  attachments: { save: saveImageAttachment, read: readImageAttachment },
  downloads,
  deviceId,
  workspace,
});

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let stopped = false;
codex.on('turn-event', (message) => safeSend(socket, { type: 'event', ...message }));

function connect() {
  if (stopped) return;
  socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
  socket.on('open', () => {
    reconnectAttempt = 0;
    safeSend(socket, { type: 'auth', role: 'connector', token, deviceId });
  });
  socket.on('message', async (data) => {
    let message;
    try { message = parseFrame(data); } catch { return; }
    if (message.type === 'request') {
      safeSend(socket, await handleRequest({ ...message, action: String(message.action || '') }));
    }
  });
  socket.on('close', scheduleReconnect);
  socket.on('error', () => {});
}

function scheduleReconnect() {
  if (stopped) return;
  const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt)) + Math.floor(Math.random() * 500);
  reconnectAttempt += 1;
  setTimeout(connect, delay).unref?.();
}

async function shutdown() {
  stopped = true;
  socket?.close(1000, 'connector shutdown');
  desktop.close();
  await downloads.closeAll();
  await codex.close();
  await connectorLock.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Connecting device ${deviceId} to ${new URL(url).origin}; workspace=${workspace}`);
connect();
