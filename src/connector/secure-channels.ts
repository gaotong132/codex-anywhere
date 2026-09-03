import type { DeviceIdentity } from '../shared/device-auth.js';
import { LRUCache } from 'lru-cache';
import {
  SecureChannelCodec,
  acceptSecureChannelOffer,
  createSecureChannelEphemeralKeyPair,
  deriveSecureChannelKeys,
  verifySecureChannelTranscriptSignature,
  type SecureChannelAcceptance,
  type SecureChannelEnvelope,
  type SecureChannelOffer,
} from '../shared/secure-channel.js';

type JsonObject = Record<string, any>;
type SecureChannelState = {
  acceptance: SecureChannelAcceptance;
  codec: SecureChannelCodec;
  confirmed: boolean;
};
type CachedRequest = { fingerprint: string; response: Promise<JsonObject> };

const DEFAULT_REQUEST_RESULT_TTL_MS = 2 * 60_000;
const DOWNLOAD_REQUEST_RESULT_TTL_MS = 30 * 60_000;

const DEDUPLICATED_ACTIONS = new Set([
  'attachment.upload',
  'file.download.open', 'file.download.chunk', 'file.download.close',
  'session.rename',
  'turn.start', 'turn.steer', 'turn.stop', 'approval.respond',
]);

export class ConnectorSecureChannels {
  private readonly identity: DeviceIdentity;
  private readonly deviceId: string;
  private readonly send: (frame: JsonObject) => boolean;
  private readonly handleRequest: (frame: JsonObject & { action: string }) => Promise<JsonObject>;
  private readonly channels = new Map<string, SecureChannelState>();
  private readonly requestResults = new LRUCache<string, CachedRequest>({
    max: 64,
    ttl: DEFAULT_REQUEST_RESULT_TTL_MS,
  });

  constructor({
    identity,
    deviceId,
    send,
    handleRequest,
  }: {
    identity: DeviceIdentity;
    deviceId: string;
    send: (frame: JsonObject) => boolean;
    handleRequest: (frame: JsonObject & { action: string }) => Promise<JsonObject>;
  }) {
    this.identity = identity;
    this.deviceId = deviceId;
    this.send = send;
    this.handleRequest = handleRequest;
  }

  async handle(frame: JsonObject) {
    if (frame.type === 'channel.offer') {
      this.accept(String(frame.clientId || ''), frame.offer as SecureChannelOffer);
      return true;
    }
    if (frame.type === 'channel.confirm') {
      this.confirm(
        String(frame.clientId || ''),
        String(frame.channelId || ''),
        String(frame.signature || ''),
      );
      return true;
    }
    if (frame.type === 'secure') {
      await this.receive(String(frame.clientId || ''), frame.envelope as SecureChannelEnvelope);
      return true;
    }
    return false;
  }

  sendEvent(frame: JsonObject) {
    const clientId = String(frame.clientId || '');
    const state = this.channels.get(clientId);
    if (!state) return false;
    if (!state.confirmed) return true;
    try {
      const { clientId: _clientId, ...payload } = frame;
      this.send({ type: 'secure', clientId, envelope: state.codec.seal(payload) });
    } catch {
      this.fail(clientId, state.acceptance.transcript.channelId);
    }
    return true;
  }

  clear() {
    for (const state of this.channels.values()) state.codec.destroy();
    this.channels.clear();
  }

  private accept(clientId: string, offer: SecureChannelOffer) {
    if (!validClientId(clientId) || offer?.routeDeviceId !== this.deviceId) {
      this.fail(clientId, offer?.channelId);
      return;
    }
    try {
      const ephemeral = createSecureChannelEphemeralKeyPair();
      const acceptance = acceptSecureChannelOffer({
        identity: this.identity,
        offer,
        ephemeralPublicKey: ephemeral.publicKey,
      });
      const keys = deriveSecureChannelKeys({
        side: 'responder',
        localSecretKey: ephemeral.secretKey,
        peerEphemeralPublicKey: offer.initiator.ephemeralPublicKey,
        transcript: acceptance.transcript,
      });
      ephemeral.secretKey.fill(0);
      const previous = this.channels.get(clientId);
      previous?.codec.destroy();
      this.channels.set(clientId, {
        acceptance,
        codec: new SecureChannelCodec({
          channelId: acceptance.transcript.channelId,
          side: 'responder',
          keys,
        }),
        confirmed: false,
      });
      keys.sendKey.fill(0);
      keys.receiveKey.fill(0);
      this.send({ type: 'channel.accept', clientId, accept: acceptance });
    } catch {
      this.fail(clientId, offer?.channelId);
    }
  }

  private confirm(clientId: string, channelId: string, signature: string) {
    const state = this.channels.get(clientId);
    if (!state || state.acceptance.transcript.channelId !== channelId
      || !verifySecureChannelTranscriptSignature(
        state.acceptance.transcript.initiator,
        signature,
        state.acceptance.transcript,
      )) {
      this.fail(clientId, channelId);
      return;
    }
    state.confirmed = true;
    this.send({ type: 'channel.ready', clientId, channelId });
  }

  private async receive(clientId: string, envelope: SecureChannelEnvelope) {
    const state = this.channels.get(clientId);
    if (!state?.confirmed) {
      this.fail(clientId, envelope?.channelId);
      return;
    }
    try {
      const request = state.codec.open(envelope);
      const requestId = String(request.requestId || '');
      if (request.type !== 'request' || typeof request.action !== 'string'
        || !requestId || requestId.length > 128) {
        throw new Error('secure_channel_frame_invalid');
      }
      this.send({
        type: 'secure', clientId,
        envelope: state.codec.seal({ type: 'ack', requestId }),
      });
      const cacheKey = `${state.acceptance.transcript.initiator.id}\0${requestId}`;
      const fingerprint = JSON.stringify(request);
      let responsePromise: Promise<JsonObject>;
      if (DEDUPLICATED_ACTIONS.has(request.action)) {
        const cached = this.requestResults.get(cacheKey);
        if (cached && cached.fingerprint !== fingerprint) {
          throw new Error('secure_channel_request_conflict');
        }
        responsePromise = cached?.response
          || this.handleRequest({
            ...request,
            action: request.action,
            clientId,
            clientDeviceId: state.acceptance.transcript.initiator.id,
          });
        if (!cached) {
          this.requestResults.set(cacheKey, { fingerprint, response: responsePromise }, {
            ttl: request.action.startsWith('file.download.')
              ? DOWNLOAD_REQUEST_RESULT_TTL_MS
              : DEFAULT_REQUEST_RESULT_TTL_MS,
          });
        }
      } else {
        responsePromise = this.handleRequest({
          ...request,
          action: request.action,
          clientId,
          clientDeviceId: state.acceptance.transcript.initiator.id,
        });
      }
      const response = await responsePromise;
      // A request can finish after the browser has replaced its channel. Never
      // seal with the destroyed codec or let the stale request tear down the
      // newly established channel.
      if (this.channels.get(clientId) !== state || !state.confirmed) return;
      const { clientId: _clientId, ...payload } = response;
      this.send({ type: 'secure', clientId, envelope: state.codec.seal(payload) });
    } catch {
      this.fail(clientId, envelope?.channelId);
    }
  }

  private fail(clientId: string, channelId: unknown) {
    const failedChannelId = String(channelId || '');
    const state = this.channels.get(clientId);
    if (state && (!failedChannelId || state.acceptance.transcript.channelId === failedChannelId)) {
      state.codec.destroy();
      this.channels.delete(clientId);
    }
    if (validClientId(clientId)) {
      this.send({
        type: 'channel.error', clientId,
        channelId: failedChannelId, error: 'secure_channel_failed',
      });
    }
  }
}

function validClientId(clientId: string) {
  return clientId.length > 0 && clientId.length <= 128;
}
