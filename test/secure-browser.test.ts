import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorSecureChannels } from '../src/connector/secure-channels.js';
import { createDeviceIdentity } from '../src/shared/device-auth.js';
import { BrowserSecureChannel } from '../web/src/secure-channel-client.js';

test('browser and connector secure-channel controllers exchange only encrypted application frames', async () => {
  const toConnector: Record<string, any>[] = [];
  const toBrowser: Record<string, any>[] = [];
  const received: Record<string, any>[] = [];
  const connector = new ConnectorSecureChannels({
    identity: createDeviceIdentity(),
    deviceId: 'personal-pc',
    send: (frame) => { toBrowser.push(frame); return true; },
    handleRequest: async (frame) => ({
      type: 'response', clientId: frame.clientId, requestId: frame.requestId,
      ok: true, data: { sessions: [] },
    }),
  });
  const browser = new BrowserSecureChannel({
    identity: createDeviceIdentity(),
    routeDeviceId: 'personal-pc',
    send: (frame) => { toConnector.push(frame); return true; },
    onFrame: (frame) => received.push(frame),
  });

  assert.equal(browser.start(), true);
  const offer = toConnector.shift()!;
  assert.equal(offer.type, 'channel.offer');
  await connector.handle({ ...offer, clientId: 'client-1' });
  assert.equal(browser.handle(toBrowser.shift()!), true);
  await connector.handle({ ...toConnector.shift()!, clientId: 'client-1' });
  assert.equal(browser.handle(toBrowser.shift()!), true);
  assert.equal(browser.isReady(), true);

  assert.equal(browser.sendFrame({
    type: 'request', requestId: 'r1', action: 'sessions.list', payload: {},
  }), true);
  const encryptedRequest = toConnector.shift()!;
  assert.equal(encryptedRequest.type, 'secure');
  assert.equal(encryptedRequest.action, undefined);
  assert.equal(encryptedRequest.requestId, undefined);
  await connector.handle({ ...encryptedRequest, clientId: 'client-1' });
  const encryptedAck = toBrowser.shift()!;
  browser.handle(encryptedAck);
  assert.deepEqual(received.shift(), { type: 'ack', requestId: 'r1' });
  const encryptedResponse = toBrowser.shift()!;
  assert.equal(encryptedResponse.type, 'secure');
  assert.equal(encryptedResponse.data, undefined);
  browser.handle(encryptedResponse);
  assert.deepEqual(received, [{
    type: 'response', requestId: 'r1', ok: true, data: { sessions: [] },
  }]);
});

test('browser ignores delayed frames from a channel it already replaced', async () => {
  const toConnector: Record<string, any>[] = [];
  const toBrowser: Record<string, any>[] = [];
  let errors = 0;
  const connector = new ConnectorSecureChannels({
    identity: createDeviceIdentity(),
    deviceId: 'personal-pc',
    send: (frame) => { toBrowser.push(frame); return true; },
    handleRequest: async () => ({}),
  });
  const browser = new BrowserSecureChannel({
    identity: createDeviceIdentity(),
    routeDeviceId: 'personal-pc',
    send: (frame) => { toConnector.push(frame); return true; },
    onFrame: () => {},
    onError: () => { errors += 1; },
  });

  browser.start();
  const staleOffer = toConnector.shift()!;
  browser.start();
  const currentOffer = toConnector.shift()!;
  browser.handle({
    type: 'channel.error', channelId: staleOffer.offer.channelId, error: 'secure_channel_failed',
  });

  await connector.handle({ ...currentOffer, clientId: 'client-1' });
  browser.handle(toBrowser.shift()!);
  await connector.handle({ ...toConnector.shift()!, clientId: 'client-1' });
  browser.handle(toBrowser.shift()!);
  assert.equal(browser.isReady(), true);

  browser.handle({
    type: 'secure',
    envelope: { channelId: staleOffer.offer.channelId },
  });
  assert.equal(browser.isReady(), true);
  assert.equal(errors, 0);
});
