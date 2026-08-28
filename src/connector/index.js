import { WebSocket } from 'ws';
import { delimiter } from 'node:path';
import { CodexAppServer } from './codex-app-server.js';
import { CodexDesktopClient, mergeDesktopSessionStatuses } from './codex-desktop.js';
import { readImageAttachment, saveImageAttachment } from './attachments.js';
import { DownloadManager } from './file-downloads.js';
import { acquireConnectorInstanceLock } from './instance-lock.js';
import {
  MAX_FRAME_BYTES, parseFrame, publicError, requireSecureBridgeUrl, safeSend,
} from '../shared/protocol.js';

const token = String(process.env.BRIDGE_TOKEN || '');
if (token.length < 32) throw new Error('BRIDGE_TOKEN must contain at least 32 characters');
const url = requireSecureBridgeUrl(process.env.BRIDGE_URL || 'ws://127.0.0.1:3300/ws');
const deviceId = process.env.BRIDGE_DEVICE_ID || 'personal-pc';
const workspace = process.env.CODEX_WORKSPACE || process.cwd();
const allowedRoots = String(process.env.CODEX_ALLOWED_ROOTS || workspace)
  .split(delimiter).map((value) => value.trim()).filter(Boolean);
const instanceLock = await acquireConnectorInstanceLock();
if (!instanceLock) {
  console.log('Codex Anywhere connector is already running.');
  process.exit(0);
}
const codex = new CodexAppServer({
  bin: process.env.CODEX_BIN || 'codex', workspace, allowedRoots,
  networkAccess: process.env.CODEX_NETWORK_ACCESS === '1',
});
const desktop = new CodexDesktopClient();
const downloads = new DownloadManager({
  allowedRoots,
  allowAnyFileDownload: process.env.CODEX_ALLOW_ANY_FILE_DOWNLOAD === '1',
});

let socket;
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
    if (message.type === 'request') await handleRequest(message);
  });
  socket.on('close', scheduleReconnect);
  socket.on('error', () => {});
}

async function handleRequest(message) {
  const { action, payload = {}, requestId, clientId } = message;
  try {
    let data;
    if (action === 'connector.status') data = { deviceId, workspace, codexOnline: Boolean(codex.child), activeTurn: Boolean(codex.activeTurn) };
    else if (action === 'sessions.list') {
      const sessions = await codex.listSessions({ cwd: payload.cwd });
      let desktopThreads = [];
      try {
        desktopThreads = await desktop.listThreads({ callerThreadId: sessions[0]?.id, limit: 50 });
      } catch { /* app-server status remains the fallback when Desktop is unavailable */ }
      data = { sessions: mergeDesktopSessionStatuses(sessions, desktopThreads) };
    }
    else if (action === 'session.read') data = await codex.readSession(String(payload.threadId || ''));
    else if (action === 'session.turns.list') data = await codex.listSessionTurns(String(payload.threadId || ''), {
      cursor: payload.cursor, limit: payload.limit, mode: payload.mode,
    });
    else if (action === 'attachment.upload') data = await saveImageAttachment(payload);
    else if (action === 'attachment.read') data = await readImageAttachment(payload);
    else if (action === 'file.download.open') data = await downloads.open(payload, clientId);
    else if (action === 'file.download.chunk') data = await downloads.read(payload, clientId);
    else if (action === 'file.download.close') data = await downloads.close(payload, clientId);
    else if (action === 'turn.start') {
      const threadId = String(payload.threadId || '').trim();
      if (!threadId) {
        data = { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
      } else {
        try {
          data = await desktop.sendMessage({
            threadId,
            text: payload.text,
            requestId,
            callerThreadId: codex.getControllerThreadId(threadId),
          });
        } catch (error) {
          if (String(error?.message || error) !== 'desktop_app_unavailable') throw error;
          if (await codex.isLargeSession(threadId)) throw new Error('desktop_required_for_large_session');
          data = { ...await codex.startTurn({ ...payload, clientId, requestId }), delivery: 'appServer' };
        }
      }
    }
    else if (action === 'turn.stop') data = await codex.stopTurn();
    else if (action === 'approval.respond') data = await codex.respondApproval(payload.approvalId, payload.approved === true);
    else throw new Error('unsupported_action');
    safeSend(socket, { type: 'response', clientId, requestId, ok: true, data });
  } catch (error) {
    safeSend(socket, { type: 'response', clientId, requestId, ok: false, error: publicError(error) });
  }
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
  await instanceLock.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Connecting device ${deviceId} to ${new URL(url).origin}; workspace=${workspace}`);
connect();
