import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceIdentity } from '../src/shared/device-auth.js';
import {
  SecureChannelCodec,
  createSecureChannelEphemeralKeyPair,
  createSecureChannelOffer,
  deriveSecureChannelKeys,
  signSecureChannelTranscript,
  verifySecureChannelAcceptance,
} from '../src/shared/secure-channel.js';
import { ConnectorSecureChannels } from '../src/connector/secure-channels.js';

test('connector secure channel authenticates, decrypts requests, and encrypts responses and events', async () => {
  const browserIdentity = createDeviceIdentity();
  const connectorIdentity = createDeviceIdentity();
  const browserEphemeral = createSecureChannelEphemeralKeyPair();
  const offer = createSecureChannelOffer({
    identity: browserIdentity,
    routeDeviceId: 'personal-pc',
    ephemeralPublicKey: browserEphemeral.publicKey,
  });
  const sent: Record<string, any>[] = [];
  const manager = new ConnectorSecureChannels({
    identity: connectorIdentity,
    deviceId: 'personal-pc',
    send: (frame) => { sent.push(frame); return true; },
    handleRequest: async (frame) => ({
      type: 'response', clientId: frame.clientId, requestId: frame.requestId,
      ok: true, data: { echoed: frame.payload.text },
    }),
  });

  assert.equal(await manager.handle({ type: 'channel.offer', clientId: 'client-1', offer }), true);
  const acceptance = sent.shift()!.accept;
  assert.equal(verifySecureChannelAcceptance(acceptance, offer), true);
  const browserKeys = deriveSecureChannelKeys({
    side: 'initiator',
    localSecretKey: browserEphemeral.secretKey,
    peerEphemeralPublicKey: acceptance.transcript.responder.ephemeralPublicKey,
    transcript: acceptance.transcript,
  });
  const browser = new SecureChannelCodec({
    channelId: offer.channelId,
    side: 'initiator',
    keys: browserKeys,
  });
  await manager.handle({
    type: 'channel.confirm', clientId: 'client-1', channelId: offer.channelId,
    signature: signSecureChannelTranscript(browserIdentity, acceptance.transcript),
  });
  assert.deepEqual(sent.shift(), {
    type: 'channel.ready', clientId: 'client-1', channelId: offer.channelId,
  });

  await manager.handle({
    type: 'secure', clientId: 'client-1',
    envelope: browser.seal({
      type: 'request', requestId: 'r1', action: 'echo', payload: { text: 'hello' },
    }),
  });
  const response = sent.shift()!;
  assert.equal(response.type, 'secure');
  assert.deepEqual(browser.open(response.envelope), {
    type: 'response', requestId: 'r1', ok: true, data: { echoed: 'hello' },
  });

  assert.equal(manager.sendEvent({
    type: 'event', clientId: 'client-1', event: 'turn.delta', payload: { delta: 'working' },
  }), true);
  assert.deepEqual(browser.open(sent.shift()!.envelope), {
    type: 'event', event: 'turn.delta', payload: { delta: 'working' },
  });
  manager.clear();
});

test('connector secure channel rejects an offer for another route', async () => {
  const identity = createDeviceIdentity();
  const ephemeral = createSecureChannelEphemeralKeyPair();
  const sent: Record<string, any>[] = [];
  const manager = new ConnectorSecureChannels({
    identity: createDeviceIdentity(),
    deviceId: 'personal-pc',
    send: (frame) => { sent.push(frame); return true; },
    handleRequest: async () => ({}),
  });
  await manager.handle({
    type: 'channel.offer', clientId: 'client-1',
    offer: createSecureChannelOffer({
      identity, routeDeviceId: 'other-pc', ephemeralPublicKey: ephemeral.publicKey,
    }),
  });
  assert.equal(sent[0].type, 'channel.error');
  assert.equal(sent[0].error, 'secure_channel_failed');
});
