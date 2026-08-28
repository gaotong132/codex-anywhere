import { WebSocket } from 'ws';
import { delimiter } from 'node:path';
import { CodexAppServer } from './codex-app-server.js';
import { CodexDesktopClient } from './codex-desktop.js';
import { readImageAttachment, saveImageAttachment } from './attachments.js';
import { DownloadManager } from './file-downloads.js';
import { generatedImagesDirectory } from './generated-images.js';
import { acquireConnectorInstanceLock } from './instance-lock.js';
import { createRequestHandler } from './request-handler.js';
import { createAuthProof } from '../shared/auth.js';
import {
  MAX_FRAME_BYTES, normalizeBridgeUrl, parseFrame, safeSend,
} from '../shared/protocol.js';

const token = String(process.env.BRIDGE_CONNECTOR_TOKEN || '');
if (token.length < 32) throw new Error('BRIDGE_CONNECTOR_TOKEN must contain at least 32 characters');
const url = normalizeBridgeUrl(process.env.BRIDGE_URL || 'ws://127.0.0.1:3300/ws');
const deviceId = process.env.BRIDGE_DEVICE_ID || 'personal-pc';
const configuredAllowedRoots = String(process.env.CODEX_ALLOWED_ROOTS || '')
  .split(delimiter).map((value) => value.trim()).filter(Boolean);
const allowedRoots = configuredAllowedRoots.length ? configuredAllowedRoots : [process.cwd()];
const instanceLock = await acquireConnectorInstanceLock();
if (!instanceLock) {
  console.log('Codex Anywhere connector is already running.');
  process.exit(0);
}
const connectorLock = instanceLock;
const codex = new CodexAppServer({
  bin: process.env.CODEX_BIN || 'codex', allowedRoots,
  networkAccess: process.env.CODEX_NETWORK_ACCESS === '1',
});
const desktop = new CodexDesktopClient();
const downloads = new DownloadManager({
  allowedRoots: [...allowedRoots, generatedImagesDirectory()],
  allowAnyFileDownload: process.env.CODEX_ALLOW_ANY_FILE_DOWNLOAD === '1',
});
const handleRequest = createRequestHandler({
  codex,
  desktop,
  attachments: { save: saveImageAttachment, read: readImageAttachment },
  downloads,
  deviceId,
});

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let stopped = false;
codex.on('turn-event', (message) => safeSend(socket, { type: 'event', ...message }));

function connect() {
  if (stopped) return;
  socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  socket.on('message', async (data) => {
    let message;
    try { message = parseFrame(data); } catch { return; }
    if (message.type === 'auth.challenge') {
      try {
        const proof = createAuthProof(token, String(message.challenge || ''), 'connector', deviceId);
        safeSend(socket, { type: 'auth.response', role: 'connector', proof, deviceId });
      } catch {
        socket?.close(4003, 'invalid authentication challenge');
      }
      return;
    }
    if (message.type === 'auth.ok') {
      reconnectAttempt = 0;
      return;
    }
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
console.log(`Connecting device ${deviceId} to ${new URL(url).origin}`);
connect();
