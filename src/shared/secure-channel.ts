import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import {
  DEVICE_ID_PATTERN,
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_SIGNATURE_PATTERN,
  signDevicePayload,
  verifyDevicePayload,
  type DeviceIdentity,
  type DevicePublicIdentity,
} from './device-auth.js';

export const SECURE_CHANNEL_PROTOCOL = 'codex-anywhere-e2ee-v1';
export const SECURE_CHANNEL_NONCE_BYTES = 24;
export const SECURE_CHANNEL_KEY_BYTES = 32;
export const SECURE_CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
export const SECURE_CHANNEL_EPHEMERAL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECURE_CHANNEL_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SECURE_CHANNEL_CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]+$/;

export type SecureChannelSide = 'initiator' | 'responder';

export type SecureChannelParticipant = DevicePublicIdentity & {
  ephemeralPublicKey: string;
};

export type SecureChannelTranscript = {
  protocol: typeof SECURE_CHANNEL_PROTOCOL;
  channelId: string;
  routeDeviceId: string;
  initiator: SecureChannelParticipant;
  responder: SecureChannelParticipant;
};

export type SecureChannelOffer = {
  protocol: typeof SECURE_CHANNEL_PROTOCOL;
  channelId: string;
  routeDeviceId: string;
  initiator: SecureChannelParticipant;
  signature: string;
};

export type SecureChannelAcceptance = {
  transcript: SecureChannelTranscript;
  signature: string;
};

export type SecureChannelEphemeralKeyPair = {
  secretKey: Uint8Array;
  publicKey: string;
};

export type SecureChannelDirectionalKeys = {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
};

export type SecureChannelEnvelope = {
  protocol: typeof SECURE_CHANNEL_PROTOCOL;
  channelId: string;
  sender: SecureChannelSide;
  sequence: number;
  nonce: string;
  ciphertext: string;
};

export function createSecureChannelId() {
  return base64urlnopad.encode(randomBytes(16));
}

export function createSecureChannelEphemeralKeyPair(): SecureChannelEphemeralKeyPair {
  const keyPair = x25519.keygen();
  return {
    secretKey: keyPair.secretKey,
    publicKey: base64urlnopad.encode(keyPair.publicKey),
  };
}

export function secureChannelParticipant(
  identity: DevicePublicIdentity,
  ephemeralPublicKey: string,
): SecureChannelParticipant {
  const participant = { id: identity.id, publicKey: identity.publicKey, ephemeralPublicKey };
  assertSecureChannelParticipant(participant);
  return participant;
}

export function createSecureChannelTranscript(input: Omit<SecureChannelTranscript, 'protocol'>) {
  const transcript: SecureChannelTranscript = {
    protocol: SECURE_CHANNEL_PROTOCOL,
    channelId: input.channelId,
    routeDeviceId: input.routeDeviceId.trim(),
    initiator: secureChannelParticipant(input.initiator, input.initiator.ephemeralPublicKey),
    responder: secureChannelParticipant(input.responder, input.responder.ephemeralPublicKey),
  };
  assertSecureChannelTranscript(transcript);
  return transcript;
}

export function createSecureChannelOffer({
  identity,
  routeDeviceId,
  ephemeralPublicKey,
  channelId = createSecureChannelId(),
}: {
  identity: DeviceIdentity;
  routeDeviceId: string;
  ephemeralPublicKey: string;
  channelId?: string;
}): SecureChannelOffer {
  const unsigned: Omit<SecureChannelOffer, 'signature'> = {
    protocol: SECURE_CHANNEL_PROTOCOL,
    channelId,
    routeDeviceId: routeDeviceId.trim(),
    initiator: secureChannelParticipant(identity, ephemeralPublicKey),
  };
  assertSecureChannelOffer(unsigned);
  return { ...unsigned, signature: signDevicePayload(identity, encodeSecureChannelOffer(unsigned)) };
}

export function verifySecureChannelOffer(offer: SecureChannelOffer) {
  try {
    assertSecureChannelOffer(offer);
    return verifyDevicePayload(offer.initiator, offer.signature, encodeSecureChannelOffer(offer));
  } catch {
    return false;
  }
}

export function acceptSecureChannelOffer({
  identity,
  offer,
  ephemeralPublicKey,
}: {
  identity: DeviceIdentity;
  offer: SecureChannelOffer;
  ephemeralPublicKey: string;
}): SecureChannelAcceptance {
  if (!verifySecureChannelOffer(offer)) throw new Error('secure_channel_offer_invalid');
  const transcript = createSecureChannelTranscript({
    channelId: offer.channelId,
    routeDeviceId: offer.routeDeviceId,
    initiator: offer.initiator,
    responder: secureChannelParticipant(identity, ephemeralPublicKey),
  });
  return { transcript, signature: signSecureChannelTranscript(identity, transcript) };
}

export function verifySecureChannelAcceptance(
  acceptance: SecureChannelAcceptance,
  offer: SecureChannelOffer,
) {
  try {
    const { transcript } = acceptance;
    assertSecureChannelTranscript(transcript);
    if (transcript.channelId !== offer.channelId
      || transcript.routeDeviceId !== offer.routeDeviceId
      || transcript.initiator.id !== offer.initiator.id
      || transcript.initiator.publicKey !== offer.initiator.publicKey
      || transcript.initiator.ephemeralPublicKey !== offer.initiator.ephemeralPublicKey) return false;
    return verifySecureChannelTranscriptSignature(
      transcript.responder,
      acceptance.signature,
      transcript,
    );
  } catch {
    return false;
  }
}

export function encodeSecureChannelTranscript(transcript: SecureChannelTranscript) {
  assertSecureChannelTranscript(transcript);
  return [
    transcript.protocol,
    transcript.channelId,
    transcript.routeDeviceId,
    transcript.initiator.id,
    transcript.initiator.publicKey,
    transcript.initiator.ephemeralPublicKey,
    transcript.responder.id,
    transcript.responder.publicKey,
    transcript.responder.ephemeralPublicKey,
  ].join('\n');
}

export function signSecureChannelTranscript(identity: DeviceIdentity, transcript: SecureChannelTranscript) {
  const participant = identity.id === transcript.initiator.id
    ? transcript.initiator
    : identity.id === transcript.responder.id
      ? transcript.responder
      : null;
  if (!participant || participant.publicKey !== identity.publicKey) {
    throw new Error('secure_channel_identity_mismatch');
  }
  return signDevicePayload(identity, encodeSecureChannelTranscript(transcript));
}

export function verifySecureChannelTranscriptSignature(
  identity: DevicePublicIdentity,
  signature: string,
  transcript: SecureChannelTranscript,
) {
  if (!DEVICE_SIGNATURE_PATTERN.test(signature)) return false;
  const participant = identity.id === transcript.initiator.id
    ? transcript.initiator
    : identity.id === transcript.responder.id
      ? transcript.responder
      : null;
  if (!participant || participant.publicKey !== identity.publicKey) return false;
  return verifyDevicePayload(identity, signature, encodeSecureChannelTranscript(transcript));
}

export function deriveSecureChannelKeys({
  side,
  localSecretKey,
  peerEphemeralPublicKey,
  transcript,
}: {
  side: SecureChannelSide;
  localSecretKey: Uint8Array;
  peerEphemeralPublicKey: string;
  transcript: SecureChannelTranscript;
}): SecureChannelDirectionalKeys {
  assertSecureChannelTranscript(transcript);
  if (localSecretKey.length !== 32
    || !SECURE_CHANNEL_EPHEMERAL_KEY_PATTERN.test(peerEphemeralPublicKey)) {
    throw new Error('secure_channel_invalid_key');
  }
  const expectedPeer = side === 'initiator'
    ? transcript.responder.ephemeralPublicKey
    : transcript.initiator.ephemeralPublicKey;
  if (peerEphemeralPublicKey !== expectedPeer) throw new Error('secure_channel_peer_mismatch');

  const sharedSecret = x25519.getSharedSecret(
    localSecretKey,
    base64urlnopad.decode(peerEphemeralPublicKey),
  );
  const transcriptBytes = utf8ToBytes(encodeSecureChannelTranscript(transcript));
  const keyMaterial = hkdf(
    sha256,
    sharedSecret,
    sha256(transcriptBytes),
    utf8ToBytes(`${SECURE_CHANNEL_PROTOCOL}\ndirectional-keys`),
    SECURE_CHANNEL_KEY_BYTES * 2,
  );
  sharedSecret.fill(0);
  const initiatorToResponder = keyMaterial.slice(0, SECURE_CHANNEL_KEY_BYTES);
  const responderToInitiator = keyMaterial.slice(SECURE_CHANNEL_KEY_BYTES);
  keyMaterial.fill(0);
  return side === 'initiator'
    ? { sendKey: initiatorToResponder, receiveKey: responderToInitiator }
    : { sendKey: responderToInitiator, receiveKey: initiatorToResponder };
}

export function sealSecureChannelEnvelope({
  key,
  channelId,
  sender,
  sequence,
  plaintext,
}: {
  key: Uint8Array;
  channelId: string;
  sender: SecureChannelSide;
  sequence: number;
  plaintext: Uint8Array;
}): SecureChannelEnvelope {
  assertSecureChannelEnvelopeMetadata({ channelId, sender, sequence });
  if (key.length !== SECURE_CHANNEL_KEY_BYTES) throw new Error('secure_channel_invalid_key');
  const nonce = randomBytes(SECURE_CHANNEL_NONCE_BYTES);
  const ciphertext = xchacha20poly1305(
    key,
    nonce,
    secureChannelEnvelopeAad(channelId, sender, sequence),
  ).encrypt(plaintext);
  return {
    protocol: SECURE_CHANNEL_PROTOCOL,
    channelId,
    sender,
    sequence,
    nonce: base64urlnopad.encode(nonce),
    ciphertext: base64urlnopad.encode(ciphertext),
  };
}

export function openSecureChannelEnvelope({
  key,
  envelope,
  expectedChannelId,
  expectedSender,
}: {
  key: Uint8Array;
  envelope: SecureChannelEnvelope;
  expectedChannelId: string;
  expectedSender: SecureChannelSide;
}) {
  assertSecureChannelEnvelope(envelope);
  if (key.length !== SECURE_CHANNEL_KEY_BYTES) throw new Error('secure_channel_invalid_key');
  if (envelope.channelId !== expectedChannelId || envelope.sender !== expectedSender) {
    throw new Error('secure_channel_envelope_mismatch');
  }
  try {
    return xchacha20poly1305(
      key,
      base64urlnopad.decode(envelope.nonce),
      secureChannelEnvelopeAad(envelope.channelId, envelope.sender, envelope.sequence),
    ).decrypt(base64urlnopad.decode(envelope.ciphertext));
  } catch {
    throw new Error('secure_channel_decryption_failed');
  }
}

function secureChannelEnvelopeAad(channelId: string, sender: SecureChannelSide, sequence: number) {
  return utf8ToBytes([SECURE_CHANNEL_PROTOCOL, channelId, sender, String(sequence)].join('\n'));
}

function encodeSecureChannelOffer(offer: Omit<SecureChannelOffer, 'signature'>) {
  return [
    offer.protocol,
    offer.channelId,
    offer.routeDeviceId,
    offer.initiator.id,
    offer.initiator.publicKey,
    offer.initiator.ephemeralPublicKey,
  ].join('\n');
}

function assertSecureChannelOffer(offer: Omit<SecureChannelOffer, 'signature'> & { signature?: string }) {
  if (offer.protocol !== SECURE_CHANNEL_PROTOCOL
    || !SECURE_CHANNEL_ID_PATTERN.test(offer.channelId)
    || !offer.routeDeviceId
    || offer.routeDeviceId.length > 128
    || (offer.signature !== undefined && !DEVICE_SIGNATURE_PATTERN.test(offer.signature))) {
    throw new Error('secure_channel_offer_invalid');
  }
  assertSecureChannelParticipant(offer.initiator);
}

function assertSecureChannelParticipant(participant: SecureChannelParticipant) {
  if (!DEVICE_ID_PATTERN.test(participant.id)
    || !DEVICE_PUBLIC_KEY_PATTERN.test(participant.publicKey)
    || !SECURE_CHANNEL_EPHEMERAL_KEY_PATTERN.test(participant.ephemeralPublicKey)) {
    throw new Error('secure_channel_invalid_participant');
  }
}

function assertSecureChannelTranscript(transcript: SecureChannelTranscript) {
  if (transcript.protocol !== SECURE_CHANNEL_PROTOCOL
    || !SECURE_CHANNEL_ID_PATTERN.test(transcript.channelId)
    || !transcript.routeDeviceId
    || transcript.routeDeviceId.length > 128) {
    throw new Error('secure_channel_invalid_transcript');
  }
  assertSecureChannelParticipant(transcript.initiator);
  assertSecureChannelParticipant(transcript.responder);
  if (transcript.initiator.id === transcript.responder.id) {
    throw new Error('secure_channel_duplicate_participant');
  }
}

function assertSecureChannelEnvelopeMetadata({
  channelId,
  sender,
  sequence,
}: Pick<SecureChannelEnvelope, 'channelId' | 'sender' | 'sequence'>) {
  if (!SECURE_CHANNEL_ID_PATTERN.test(channelId)
    || (sender !== 'initiator' && sender !== 'responder')
    || !Number.isSafeInteger(sequence)
    || sequence < 1) {
    throw new Error('secure_channel_invalid_envelope');
  }
}

function assertSecureChannelEnvelope(envelope: SecureChannelEnvelope) {
  assertSecureChannelEnvelopeMetadata(envelope);
  if (envelope.protocol !== SECURE_CHANNEL_PROTOCOL
    || !SECURE_CHANNEL_NONCE_PATTERN.test(envelope.nonce)
    || !SECURE_CHANNEL_CIPHERTEXT_PATTERN.test(envelope.ciphertext)) {
    throw new Error('secure_channel_invalid_envelope');
  }
}
