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
  const encryptedResponse = toBrowser.shift()!;
  assert.equal(encryptedResponse.type, 'secure');
  assert.equal(encryptedResponse.data, undefined);
  browser.handle(encryptedResponse);
  assert.deepEqual(received, [{
    type: 'response', requestId: 'r1', ok: true, data: { sessions: [] },
  }]);
});
