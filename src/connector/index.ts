import { WebSocket } from 'ws';
import { CodexAppServer } from './codex-app-server.js';
import { CodexDesktopClient } from './codex-desktop.js';
import { readImageAttachment, saveImageAttachment } from './attachments.js';
import { loadConnectorConfig } from './config.js';
import { DownloadManager } from './file-downloads.js';
import { generatedImagesDirectory } from './generated-images.js';
import { readVisualization, visualizationsDirectory } from './visualizations.js';
import { acquireConnectorInstanceLock } from './instance-lock.js';
import { loadOrCreateConnectorDeviceIdentity } from './device-identity.js';
import { createRequestHandler } from './request-handler.js';
import { scheduleReferencedRetry } from './reconnect.js';
import { ConnectorSecureChannels } from './secure-channels.js';
import { createAuthProof } from '../shared/auth.js';
import { createDeviceAuthProof } from '../shared/device-auth.js';
import {
  requireCurrentProtocol,
} from '../shared/protocol-contract.js';
import {
  MAX_FRAME_BYTES, parseFrame, safeSend,
} from '../shared/protocol.js';

const {
  token,
  url,
  deviceId,
  codexBin,
  allowedRoots,
  networkAccess,
  allowAnyFileDownload,
} = loadConnectorConfig();
const deviceIdentity = loadOrCreateConnectorDeviceIdentity();
const instanceLock = await acquireConnectorInstanceLock();
if (!instanceLock) {
  console.log('Codex Anywhere connector is already running.');
  process.exit(0);
}
const connectorLock = instanceLock;
const codex = new CodexAppServer({
  bin: codexBin, allowedRoots, networkAccess,
});
const desktop = new CodexDesktopClient();
const downloads = new DownloadManager({
  allowedRoots: [...allowedRoots, generatedImagesDirectory(), visualizationsDirectory()],
  allowAnyFileDownload,
});
const handleRequest = createRequestHandler({
  codex,
  desktop,
  attachments: {
    save: saveImageAttachment,
    read: (payload) => readImageAttachment(payload, { localAllowedRoots: allowedRoots }),
  },
  visualizations: { read: readVisualization },
  downloads,
  deviceId,
});
const secureChannels = new ConnectorSecureChannels({
  identity: deviceIdentity,
  deviceId,
  send: (frame) => safeSend(socket, frame),
  handleRequest,
});

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let stopped = false;
codex.on('turn-event', (message) => {
  if (message.event === 'turn.ended') safeSend(socket, { type: 'push.notify', kind: 'completed' });
  if (message.event === 'approval.requested') safeSend(socket, { type: 'push.notify', kind: 'approval' });
  const frame = { type: 'event', ...message };
  secureChannels.sendEvent(frame);
});

function connect() {
  if (stopped) return;
  socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  socket.on('message', async (data) => {
    let message;
    try { message = parseFrame(data); } catch { return; }
    if (message.type === 'auth.challenge') {
      try {
        const protocol = requireCurrentProtocol(message.protocol);
        const proof = createAuthProof(token, String(message.challenge || ''), 'connector', deviceId);
        const device = createDeviceAuthProof(deviceIdentity, {
          challenge: String(message.challenge || ''),
          role: 'connector',
          routeDeviceId: deviceId,
          authProof: proof,
        }, `Connector · ${deviceId}`);
        safeSend(socket, {
          type: 'auth.response', role: 'connector', proof, deviceId, device, protocol,
        });
      } catch {
        socket?.close(4003, 'invalid authentication challenge');
      }
      return;
    }
    if (message.type === 'auth.pairing') {
      console.log('Connector device approval required. Approve the pending connector from the relay host.');
      return;
    }
    if (message.type === 'auth.ok') {
      reconnectAttempt = 0;
      return;
    }
    if (await secureChannels.handle(message)) return;
  });
  socket.on('close', scheduleReconnect);
  socket.on('error', () => {});
}

function scheduleReconnect() {
  if (stopped) return;
  secureChannels.clear();
  const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt)) + Math.floor(Math.random() * 500);
  reconnectAttempt += 1;
  scheduleReferencedRetry(connect, delay);
}

async function shutdown() {
  stopped = true;
  secureChannels.clear();
  socket?.close(1000, 'connector shutdown');
  desktop.close();
  await downloads.closeAll();
  await codex.close();
  await connectorLock.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Connecting Codex Anywhere connector to ${new URL(url).origin}`);
connect();
