import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../src/server/server.js';
import { createDeviceAuthProof, createDeviceIdentity } from '../src/shared/device-auth.js';
import { browserLinkContext } from '../src/shared/browser-link.js';
import { DEVICE_KEY_AUTH_CONTEXT } from '../src/shared/pairing-auth.js';
import { requireCurrentProtocol } from '../src/shared/protocol-contract.js';

const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
const nextFrame = (socket: WebSocket) => once(socket, 'message').then(([data]) => JSON.parse(String(data)));

test('association binds Web approval to the live challenge, extension Origin and plugin key; revocation persists', async (t) => {
  const server = createBridgeServer({ connectorToken: 'test-browser-link-connector-token-123456',
    extensionOrigins: [extensionOrigin, otherOrigin], authFailureLimit: 100 });
  const address = await server.listen(0, '127.0.0.1');
  const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach((s) => s.terminate()); await server.close(); });
  const web = createDeviceIdentity();
  const ext = createDeviceIdentity();
  const pending = server.deviceRegistry.requestPairing({ role: 'client', address: 'fixture',
    device: { id: web.id, publicKey: web.publicKey, signature: '0'.repeat(128) } });
  server.deviceRegistry.approve(pending.requestId);
  const open = async (origin: string | undefined = extensionOrigin) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, origin ? { origin } : {});
    sockets.push(socket);
    const challenge = await nextFrame(socket);
    return { socket, challenge: challenge.challenge as string, protocol: requireCurrentProtocol(challenge.protocol) };
  };
  const first = await open();
  const sponsor = createDeviceAuthProof(web, { challenge: first.challenge, role: 'client',
    authProof: browserLinkContext(extensionOrigin, ext) });
  const linked = nextFrame(first.socket);
  first.socket.send(JSON.stringify({ type: 'auth.link', role: 'client', sponsor, protocol: first.protocol,
    device: createDeviceAuthProof(ext, { challenge: first.challenge, role: 'client', authProof: DEVICE_KEY_AUTH_CONTEXT }) }));
  assert.equal((await linked).authMode, 'linked');
  assert.equal(server.deviceRegistry.isApproved('client', ext), true);
  assert.equal(server.deviceRegistry.listApproved().find((d) => d.id === ext.id)?.linkedFrom?.id, web.id);
  first.socket.close();

  // A linked plugin can reconnect normally without another sponsor or pairing.
  const reconnect = await open();
  const reconnected = nextFrame(reconnect.socket);
  reconnect.socket.send(JSON.stringify({ type: 'auth.device', role: 'client', protocol: reconnect.protocol,
    device: createDeviceAuthProof(ext, { challenge: reconnect.challenge, role: 'client', authProof: DEVICE_KEY_AUTH_CONTEXT }) }));
  assert.equal((await reconnected).authMode, 'device');
  reconnect.socket.close();

  for (const variant of ['replay', 'origin', 'key', 'unapproved', 'nested', 'no-extension-origin']) {
    const attempt = await open(variant === 'no-extension-origin' ? '' : extensionOrigin);
    const target = createDeviceIdentity();
    const signer = variant === 'unapproved' ? createDeviceIdentity() : variant === 'nested' ? ext : web;
    const proof = variant === 'replay' ? sponsor : createDeviceAuthProof(signer, {
      challenge: attempt.challenge, role: 'client',
      authProof: browserLinkContext(variant === 'origin' ? otherOrigin : extensionOrigin, variant === 'key' ? ext : target),
    });
    const closed = once(attempt.socket, 'close');
    attempt.socket.send(JSON.stringify({ type: 'auth.link', role: 'client', sponsor: proof, protocol: attempt.protocol,
      device: createDeviceAuthProof(target, { challenge: attempt.challenge, role: 'client', authProof: DEVICE_KEY_AUTH_CONTEXT }) }));
    assert.equal((await closed)[0], 4003, variant);
    assert.equal(server.deviceRegistry.isApproved('client', target), false);
  }
  // Removing a plugin must not immediately re-enroll it through the open chat.
  server.deviceRegistry.remove('client', ext.id);
  assert.equal(server.deviceRegistry.approveLinkedBrowser(ext, web), false);
  const other = createDeviceIdentity();
  assert.equal(server.deviceRegistry.approveLinkedBrowser(other, web), true);
  server.deviceRegistry.remove('client', web.id);
  assert.equal(server.deviceRegistry.isApproved('client', other), false);
  assert.equal(server.deviceRegistry.approveLinkedBrowser(other, web), false);
});
