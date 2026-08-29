import assert from 'node:assert/strict';
import test from 'node:test';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { createDeviceIdentity } from '../src/shared/device-auth.js';
import {
  acceptSecureChannelOffer,
  createSecureChannelOffer,
  createSecureChannelEphemeralKeyPair,
  createSecureChannelId,
  createSecureChannelTranscript,
  deriveSecureChannelKeys,
  openSecureChannelEnvelope,
  sealSecureChannelEnvelope,
  secureChannelParticipant,
  signSecureChannelTranscript,
  verifySecureChannelAcceptance,
  verifySecureChannelOffer,
  verifySecureChannelTranscriptSignature,
  type SecureChannelEnvelope,
} from '../src/shared/secure-channel.js';

function createFixture() {
  const initiatorIdentity = createDeviceIdentity();
  const responderIdentity = createDeviceIdentity();
  const initiatorEphemeral = createSecureChannelEphemeralKeyPair();
  const responderEphemeral = createSecureChannelEphemeralKeyPair();
  const transcript = createSecureChannelTranscript({
    channelId: createSecureChannelId(),
    routeDeviceId: 'personal-pc',
    initiator: secureChannelParticipant(initiatorIdentity, initiatorEphemeral.publicKey),
    responder: secureChannelParticipant(responderIdentity, responderEphemeral.publicKey),
  });
  return {
    initiatorIdentity,
    responderIdentity,
    initiatorEphemeral,
    responderEphemeral,
    transcript,
  };
}

test('secure channel offers authenticate both endpoints without serializing private keys', () => {
  const initiatorIdentity = createDeviceIdentity();
  const responderIdentity = createDeviceIdentity();
  const initiatorEphemeral = createSecureChannelEphemeralKeyPair();
  const responderEphemeral = createSecureChannelEphemeralKeyPair();
  const offer = createSecureChannelOffer({
    identity: initiatorIdentity,
    routeDeviceId: 'personal-pc',
    ephemeralPublicKey: initiatorEphemeral.publicKey,
  });
  assert.equal(verifySecureChannelOffer(offer), true);
  assert.equal(JSON.stringify(offer).includes(initiatorIdentity.privateKey), false);

  const acceptance = acceptSecureChannelOffer({
    identity: responderIdentity,
    offer,
    ephemeralPublicKey: responderEphemeral.publicKey,
  });
  assert.equal(verifySecureChannelAcceptance(acceptance, offer), true);
  assert.equal(JSON.stringify(acceptance).includes(responderIdentity.privateKey), false);
  assert.equal(verifySecureChannelAcceptance({
    ...acceptance,
    transcript: { ...acceptance.transcript, routeDeviceId: 'other-pc' },
  }, offer), false);
});

test('secure channel transcript signatures bind identities and both ephemeral keys', () => {
  const fixture = createFixture();
  const initiatorSignature = signSecureChannelTranscript(
    fixture.initiatorIdentity,
    fixture.transcript,
  );
  const responderSignature = signSecureChannelTranscript(
    fixture.responderIdentity,
    fixture.transcript,
  );

  assert.equal(verifySecureChannelTranscriptSignature(
    fixture.initiatorIdentity,
    initiatorSignature,
    fixture.transcript,
  ), true);
  assert.equal(verifySecureChannelTranscriptSignature(
    fixture.responderIdentity,
    responderSignature,
    fixture.transcript,
  ), true);

  const attacker = createDeviceIdentity();
  assert.equal(verifySecureChannelTranscriptSignature(
    attacker,
    initiatorSignature,
    fixture.transcript,
  ), false);
  assert.throws(
    () => signSecureChannelTranscript(attacker, fixture.transcript),
    /secure_channel_identity_mismatch/,
  );
});

test('secure channel derives matching directional keys and encrypts both directions', () => {
  const fixture = createFixture();
  const initiatorKeys = deriveSecureChannelKeys({
    side: 'initiator',
    localSecretKey: fixture.initiatorEphemeral.secretKey,
    peerEphemeralPublicKey: fixture.responderEphemeral.publicKey,
    transcript: fixture.transcript,
  });
  const responderKeys = deriveSecureChannelKeys({
    side: 'responder',
    localSecretKey: fixture.responderEphemeral.secretKey,
    peerEphemeralPublicKey: fixture.initiatorEphemeral.publicKey,
    transcript: fixture.transcript,
  });
  assert.deepEqual(initiatorKeys.sendKey, responderKeys.receiveKey);
  assert.deepEqual(initiatorKeys.receiveKey, responderKeys.sendKey);

  const outbound = sealSecureChannelEnvelope({
    key: initiatorKeys.sendKey,
    channelId: fixture.transcript.channelId,
    sender: 'initiator',
    sequence: 1,
    plaintext: utf8ToBytes('hello connector'),
  });
  const inbound = openSecureChannelEnvelope({
    key: responderKeys.receiveKey,
    envelope: outbound,
    expectedChannelId: fixture.transcript.channelId,
    expectedSender: 'initiator',
  });
  assert.equal(new TextDecoder().decode(inbound), 'hello connector');

  const reply = sealSecureChannelEnvelope({
    key: responderKeys.sendKey,
    channelId: fixture.transcript.channelId,
    sender: 'responder',
    sequence: 1,
    plaintext: utf8ToBytes('hello browser'),
  });
  assert.equal(new TextDecoder().decode(openSecureChannelEnvelope({
    key: initiatorKeys.receiveKey,
    envelope: reply,
    expectedChannelId: fixture.transcript.channelId,
    expectedSender: 'responder',
  })), 'hello browser');
});

test('secure channel rejects tampering, wrong direction and wrong keys', () => {
  const fixture = createFixture();
  const initiatorKeys = deriveSecureChannelKeys({
    side: 'initiator',
    localSecretKey: fixture.initiatorEphemeral.secretKey,
    peerEphemeralPublicKey: fixture.responderEphemeral.publicKey,
    transcript: fixture.transcript,
  });
  const envelope = sealSecureChannelEnvelope({
    key: initiatorKeys.sendKey,
    channelId: fixture.transcript.channelId,
    sender: 'initiator',
    sequence: 7,
    plaintext: utf8ToBytes('protected'),
  });
  const tampered: SecureChannelEnvelope = {
    ...envelope,
    ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`,
  };

  assert.throws(() => openSecureChannelEnvelope({
    key: initiatorKeys.sendKey,
    envelope: tampered,
    expectedChannelId: fixture.transcript.channelId,
    expectedSender: 'initiator',
  }), /secure_channel_decryption_failed/);
  assert.throws(() => openSecureChannelEnvelope({
    key: initiatorKeys.sendKey,
    envelope,
    expectedChannelId: fixture.transcript.channelId,
    expectedSender: 'responder',
  }), /secure_channel_envelope_mismatch/);
  assert.throws(() => openSecureChannelEnvelope({
    key: new Uint8Array(32),
    envelope,
    expectedChannelId: fixture.transcript.channelId,
    expectedSender: 'initiator',
  }), /secure_channel_decryption_failed/);
});

test('secure channel uses a fresh extended nonce for every envelope', () => {
  const fixture = createFixture();
  const initiatorKeys = deriveSecureChannelKeys({
    side: 'initiator',
    localSecretKey: fixture.initiatorEphemeral.secretKey,
    peerEphemeralPublicKey: fixture.responderEphemeral.publicKey,
    transcript: fixture.transcript,
  });
  const first = sealSecureChannelEnvelope({
    key: initiatorKeys.sendKey,
    channelId: fixture.transcript.channelId,
    sender: 'initiator',
    sequence: 1,
    plaintext: utf8ToBytes('same message'),
  });
  const second = sealSecureChannelEnvelope({
    key: initiatorKeys.sendKey,
    channelId: fixture.transcript.channelId,
    sender: 'initiator',
    sequence: 2,
    plaintext: utf8ToBytes('same message'),
  });
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
});
