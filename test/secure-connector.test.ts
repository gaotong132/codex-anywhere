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
  const acknowledgement = sent.shift()!;
  assert.deepEqual(browser.open(acknowledgement.envelope), { type: 'ack', requestId: 'r1' });
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

test('connector deduplicates replayed mutating requests for the same browser identity', async () => {
  const browserIdentity = createDeviceIdentity();
  const connectorIdentity = createDeviceIdentity();
  const sent: Record<string, any>[] = [];
  let calls = 0;
  const manager = new ConnectorSecureChannels({
    identity: connectorIdentity,
    deviceId: 'personal-pc',
    send: (frame) => { sent.push(frame); return true; },
    handleRequest: async (frame) => {
      calls += 1;
      return {
        type: 'response', clientId: frame.clientId, requestId: frame.requestId,
        ok: true, data: { threadId: 'thread-1' },
      };
    },
  });

  async function connect(clientId: string) {
    const ephemeral = createSecureChannelEphemeralKeyPair();
    const offer = createSecureChannelOffer({
      identity: browserIdentity,
      routeDeviceId: 'personal-pc',
      ephemeralPublicKey: ephemeral.publicKey,
    });
    await manager.handle({ type: 'channel.offer', clientId, offer });
    const acceptance = sent.shift()!.accept;
    const keys = deriveSecureChannelKeys({
      side: 'initiator',
      localSecretKey: ephemeral.secretKey,
      peerEphemeralPublicKey: acceptance.transcript.responder.ephemeralPublicKey,
      transcript: acceptance.transcript,
    });
    const codec = new SecureChannelCodec({ channelId: offer.channelId, side: 'initiator', keys });
    await manager.handle({
      type: 'channel.confirm', clientId, channelId: offer.channelId,
      signature: signSecureChannelTranscript(browserIdentity, acceptance.transcript),
    });
    sent.shift();
    return codec;
  }

  const request = {
    type: 'request', requestId: 'same-request', action: 'turn.start', payload: { text: 'once' },
  };
  const first = await connect('client-1');
  await manager.handle({ type: 'secure', clientId: 'client-1', envelope: first.seal(request) });
  first.open(sent.shift()!.envelope);
  assert.equal(first.open(sent.shift()!.envelope).ok, true);

  manager.clear();
  const second = await connect('client-2');
  await manager.handle({ type: 'secure', clientId: 'client-2', envelope: second.seal(request) });
  second.open(sent.shift()!.envelope);
  assert.equal(second.open(sent.shift()!.envelope).ok, true);
  assert.equal(calls, 1);
});

test('connector forwards the stable browser identity separately from reconnect-scoped routing', async () => {
  const browserIdentity = createDeviceIdentity();
  const connectorIdentity = createDeviceIdentity();
  const sent: Record<string, any>[] = [];
  let handled: Record<string, any> | undefined;
  const manager = new ConnectorSecureChannels({
    identity: connectorIdentity,
    deviceId: 'personal-pc',
    send: (frame) => { sent.push(frame); return true; },
    handleRequest: async (frame) => {
      handled = frame;
      return {
        type: 'response', clientId: frame.clientId, requestId: frame.requestId,
        ok: true, data: {},
      };
    },
  });
  const ephemeral = createSecureChannelEphemeralKeyPair();
  const offer = createSecureChannelOffer({
    identity: browserIdentity,
    routeDeviceId: 'personal-pc',
    ephemeralPublicKey: ephemeral.publicKey,
  });
  await manager.handle({ type: 'channel.offer', clientId: 'client-after-reconnect', offer });
  const acceptance = sent.shift()!.accept;
  const keys = deriveSecureChannelKeys({
    side: 'initiator',
    localSecretKey: ephemeral.secretKey,
    peerEphemeralPublicKey: acceptance.transcript.responder.ephemeralPublicKey,
    transcript: acceptance.transcript,
  });
  const browser = new SecureChannelCodec({ channelId: offer.channelId, side: 'initiator', keys });
  await manager.handle({
    type: 'channel.confirm', clientId: 'client-after-reconnect', channelId: offer.channelId,
    signature: signSecureChannelTranscript(browserIdentity, acceptance.transcript),
  });
  sent.shift();
  await manager.handle({
    type: 'secure', clientId: 'client-after-reconnect',
    envelope: browser.seal({
      type: 'request', requestId: 'download-1', action: 'file.download.chunk', payload: {},
    }),
  });
  assert.equal(handled?.clientId, 'client-after-reconnect');
  assert.equal(handled?.clientDeviceId, browserIdentity.id);
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

test('a response from a replaced channel cannot tear down the current channel', async () => {
  const browserIdentity = createDeviceIdentity();
  const sent: Record<string, any>[] = [];
  let finishRequest: (() => void) | undefined;
  const manager = new ConnectorSecureChannels({
    identity: createDeviceIdentity(),
    deviceId: 'personal-pc',
    send: (frame) => { sent.push(frame); return true; },
    handleRequest: (frame) => new Promise((resolve) => {
      finishRequest = () => resolve({
        type: 'response', clientId: frame.clientId, requestId: frame.requestId,
        ok: true, data: {},
      });
    }),
  });

  async function connect() {
    const ephemeral = createSecureChannelEphemeralKeyPair();
    const offer = createSecureChannelOffer({
      identity: browserIdentity,
      routeDeviceId: 'personal-pc',
      ephemeralPublicKey: ephemeral.publicKey,
    });
    await manager.handle({ type: 'channel.offer', clientId: 'client-1', offer });
    const acceptance = sent.shift()!.accept;
    const keys = deriveSecureChannelKeys({
      side: 'initiator',
      localSecretKey: ephemeral.secretKey,
      peerEphemeralPublicKey: acceptance.transcript.responder.ephemeralPublicKey,
      transcript: acceptance.transcript,
    });
    const codec = new SecureChannelCodec({ channelId: offer.channelId, side: 'initiator', keys });
    await manager.handle({
      type: 'channel.confirm', clientId: 'client-1', channelId: offer.channelId,
      signature: signSecureChannelTranscript(browserIdentity, acceptance.transcript),
    });
    sent.shift();
    return codec;
  }

  const first = await connect();
  const oldRequest = manager.handle({
    type: 'secure', clientId: 'client-1',
    envelope: first.seal({ type: 'request', requestId: 'slow', action: 'echo', payload: {} }),
  });
  assert.deepEqual(first.open(sent.shift()!.envelope), { type: 'ack', requestId: 'slow' });

  const current = await connect();
  finishRequest?.();
  await oldRequest;
  assert.equal(sent.length, 0);
  assert.equal(manager.sendEvent({
    type: 'event', clientId: 'client-1', event: 'turn.delta', payload: { delta: 'current' },
  }), true);
  assert.deepEqual(current.open(sent.shift()!.envelope), {
    type: 'event', event: 'turn.delta', payload: { delta: 'current' },
  });
});
