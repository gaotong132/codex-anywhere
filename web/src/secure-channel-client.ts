import type { DeviceIdentity } from '../../src/shared/device-auth';
import {
  SecureChannelCodec,
  createSecureChannelEphemeralKeyPair,
  createSecureChannelOffer,
  deriveSecureChannelKeys,
  signSecureChannelTranscript,
  verifySecureChannelAcceptance,
  type SecureChannelAcceptance,
  type SecureChannelEnvelope,
  type SecureChannelEphemeralKeyPair,
  type SecureChannelOffer,
} from '../../src/shared/secure-channel';

type JsonObject = Record<string, any>;

export class BrowserSecureChannel {
  private readonly identity: DeviceIdentity;
  private readonly routeDeviceId: string;
  private readonly send: (frame: JsonObject) => boolean;
  private readonly onFrame: (frame: JsonObject) => void;
  private readonly onReady: () => void;
  private readonly onError: () => void;
  private offer: SecureChannelOffer | null = null;
  private ephemeral: SecureChannelEphemeralKeyPair | null = null;
  private codec: SecureChannelCodec | null = null;
  private ready = false;

  constructor({
    identity,
    routeDeviceId,
    send,
    onFrame,
    onReady = () => {},
    onError = () => {},
  }: {
    identity: DeviceIdentity;
    routeDeviceId: string;
    send: (frame: JsonObject) => boolean;
    onFrame: (frame: JsonObject) => void;
    onReady?: () => void;
    onError?: () => void;
  }) {
    this.identity = identity;
    this.routeDeviceId = routeDeviceId;
    this.send = send;
    this.onFrame = onFrame;
    this.onReady = onReady;
    this.onError = onError;
  }

  start() {
    this.clear();
    this.ephemeral = createSecureChannelEphemeralKeyPair();
    this.offer = createSecureChannelOffer({
      identity: this.identity,
      routeDeviceId: this.routeDeviceId,
      ephemeralPublicKey: this.ephemeral.publicKey,
    });
    if (!this.send({
      type: 'channel.offer', deviceId: this.routeDeviceId, offer: this.offer,
    })) {
      this.clear();
      return false;
    }
    return true;
  }

  handle(frame: JsonObject) {
    if (frame.type === 'channel.accept') {
      this.accept(frame.accept as SecureChannelAcceptance);
      return true;
    }
    if (frame.type === 'channel.ready') {
      if (this.codec && frame.channelId === this.codec.channelId) {
        this.ready = true;
        this.onReady();
      } else {
        this.fail();
      }
      return true;
    }
    if (frame.type === 'channel.error') {
      this.fail();
      return true;
    }
    if (frame.type === 'secure') {
      try {
        if (!this.ready || !this.codec) throw new Error('secure_channel_not_ready');
        this.onFrame(this.codec.open(frame.envelope as SecureChannelEnvelope));
      } catch {
        this.fail();
      }
      return true;
    }
    return false;
  }

  sendFrame(frame: JsonObject) {
    if (!this.ready || !this.codec) return false;
    try {
      return this.send({
        type: 'secure', deviceId: this.routeDeviceId, envelope: this.codec.seal(frame),
      });
    } catch {
      this.fail();
      return false;
    }
  }

  isReady() {
    return this.ready;
  }

  clear() {
    this.ready = false;
    this.codec?.destroy();
    this.codec = null;
    this.offer = null;
    this.ephemeral?.secretKey.fill(0);
    this.ephemeral = null;
  }

  private accept(acceptance: SecureChannelAcceptance) {
    if (!this.offer || !this.ephemeral
      || !verifySecureChannelAcceptance(acceptance, this.offer)) {
      this.fail();
      return;
    }
    try {
      const keys = deriveSecureChannelKeys({
        side: 'initiator',
        localSecretKey: this.ephemeral.secretKey,
        peerEphemeralPublicKey: acceptance.transcript.responder.ephemeralPublicKey,
        transcript: acceptance.transcript,
      });
      this.ephemeral.secretKey.fill(0);
      this.ephemeral = null;
      this.codec = new SecureChannelCodec({
        channelId: acceptance.transcript.channelId,
        side: 'initiator',
        keys,
      });
      keys.sendKey.fill(0);
      keys.receiveKey.fill(0);
      const signature = signSecureChannelTranscript(this.identity, acceptance.transcript);
      if (!this.send({
        type: 'channel.confirm', deviceId: this.routeDeviceId,
        channelId: acceptance.transcript.channelId, signature,
      })) this.fail();
    } catch {
      this.fail();
    }
  }

  private fail() {
    this.clear();
    this.onError();
  }
}
