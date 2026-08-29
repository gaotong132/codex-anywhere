import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridgeServer, internals as serverInternals } from '../src/server/server.js';
import { createAuthProof } from '../src/shared/auth.js';
import { createDeviceAuthProof, createDeviceIdentity, type DeviceIdentity } from '../src/shared/device-auth.js';
import type { DeviceRegistry } from '../src/server/device-registry.js';
import { requireCurrentProtocol } from '../src/shared/protocol-negotiation.js';
import {
  DEVICE_KEY_AUTH_CONTEXT,
  browserPairingVerifier,
  createBrowserPairingProof,
} from '../src/shared/pairing-auth.js';

const TOKEN = 'test-token-that-is-longer-than-32-characters';
const CLIENT_TOKEN = 'client-token-that-is-longer-than-32-characters';
const CONNECTOR_TOKEN = 'connector-token-that-is-longer-than-32-characters';
const nextJson = (socket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()));

test('server requires independent client and connector credentials', () => {
  assert.throws(
    () => createBridgeServer({ clientToken: 'short', connectorToken: CONNECTOR_TOKEN }),
    /BRIDGE_CLIENT_TOKEN/,
  );
  assert.throws(
    () => createBridgeServer({ clientToken: CLIENT_TOKEN, connectorToken: 'short' }),
    /BRIDGE_CONNECTOR_TOKEN/,
  );
});

async function openSocket(url: string, options = {}) {
  const socket = new WebSocket(url, options);
  const challengeMessage = nextJson(socket);
  await once(socket, 'open');
  const challenge = await challengeMessage;
  assert.equal(challenge.type, 'auth.challenge');
  assert.match(challenge.challenge, /^[a-f0-9]{64}$/);
  assert.equal(challenge.deviceAuth, undefined);
  return {
    socket,
    challenge: challenge.challenge as string,
    protocol: challenge.protocol,
    frameVersion: challenge.version,
  };
}

async function authenticateSocket({
  url, role, token, deviceId = '', options = {}, registry, identity = createDeviceIdentity(),
}: {
  url: string;
  role: 'client' | 'connector';
  token: string;
  deviceId?: string;
  options?: ConstructorParameters<typeof WebSocket>[1];
  registry: DeviceRegistry;
  identity?: DeviceIdentity;
}) {
  if (!registry.isApproved(role, identity)) {
    const registered = registry.requestPairing({
      role,
      routeDeviceId: role === 'connector' ? deviceId : undefined,
      device: { id: identity.id, publicKey: identity.publicKey, signature: '0'.repeat(128), label: 'Test device' },
      address: '127.0.0.1',
    });
    registry.approve(registered.requestId);
  }
  const opened = await openSocket(url, options);
  const proof = createAuthProof(token, opened.challenge, role, deviceId);
  const protocol = requireCurrentProtocol(opened.protocol);
  opened.socket.send(JSON.stringify({
    type: 'auth.response',
    role,
    deviceId: role === 'connector' ? deviceId : undefined,
    proof,
    device: createDeviceAuthProof(identity, {
      challenge: opened.challenge, role, routeDeviceId: deviceId, authProof: proof,
    }, 'Test device'),
    protocol,
  }));
  return { ...opened, auth: await nextJson(opened.socket), identity };
}

test('server requires the current protocol and rejects missing protocol metadata', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const current = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry,
  });
  assert.equal(current.frameVersion, 3);
  assert.equal(current.auth.protocol.version, 3);
  assert.equal(current.auth.protocol.capabilities.includes('strict-protocol.v1'), true);
  assert.equal(current.auth.protocol.capabilities.includes('browser-pairing.v1'), true);
  assert.equal(current.auth.protocol.capabilities.includes('e2ee-channel.v1'), true);
  current.socket.close();

  const identity = createDeviceIdentity();
  const opened = await openSocket(url);
  const proof = createAuthProof(TOKEN, opened.challenge, 'client');
  const closed = once(opened.socket, 'close');
  opened.socket.send(JSON.stringify({
    type: 'auth.response', role: 'client', proof,
    device: createDeviceAuthProof(identity, {
      challenge: opened.challenge, role: 'client', authProof: proof,
    }, 'Outdated browser'),
  }));
  const [code] = await closed;
  assert.equal(code, 4406);
});

test('authenticated devices register Web Push and connectors emit only generic notification kinds', async (t) => {
  const registrations: Array<{ id: string; subscription: unknown }> = [];
  let notification: { kind: string; online: ReadonlySet<string> } | undefined;
  let notified!: () => void;
  const notificationReceived = new Promise<void>((resolve) => { notified = resolve; });
  const server = createBridgeServer({
    clientToken: CLIENT_TOKEN,
    connectorToken: CONNECTOR_TOKEN,
    pushNotifications: {
      publicKey: 'push-public-key',
      subscribe: (device, subscription) => {
        registrations.push({ id: device.id, subscription });
        return true;
      },
      unsubscribe: () => true,
      notify: async (kind, online) => {
        notification = { kind, online: online || new Set() };
        notified();
      },
    },
  });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const client = await authenticateSocket({
    url, role: 'client', token: CLIENT_TOKEN, registry: server.deviceRegistry,
  });
  client.socket.send(JSON.stringify({
    type: 'push.subscribe',
    subscription: { endpoint: 'https://push.example.test/one' },
  }));
  assert.deepEqual(await nextJson(client.socket), { type: 'push.registered', enabled: true, version: 3 });
  assert.equal(registrations[0].id, client.identity.id);

  const connector = await authenticateSocket({
    url, role: 'connector', token: CONNECTOR_TOKEN, deviceId: 'personal-pc',
    registry: server.deviceRegistry,
  });
  await nextJson(client.socket); // connector presence update
  connector.socket.send(JSON.stringify({ type: 'push.notify', kind: 'completed' }));
  await notificationReceived;
  assert.equal(notification?.kind, 'completed');
  assert.equal(notification?.online.has(client.identity.id), true);
  client.socket.close();
  connector.socket.close();
});

test('one-time pairing enrolls a browser and approved device-key auth needs no shared token', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const identity = createDeviceIdentity();
  const pairing = server.deviceRegistry.createBrowserPairing();
  const verifier = browserPairingVerifier(pairing.credential.secret);

  const enrollment = await openSocket(url);
  const enrollmentProof = createBrowserPairingProof({
    verifier,
    challenge: enrollment.challenge,
    pairingId: pairing.credential.id,
    deviceId: identity.id,
    publicKey: identity.publicKey,
  });
  enrollment.socket.send(JSON.stringify({
    type: 'auth.enroll',
    role: 'client',
    pairingId: pairing.credential.id,
    proof: enrollmentProof,
    protocol: requireCurrentProtocol(enrollment.protocol),
    device: createDeviceAuthProof(identity, {
      challenge: enrollment.challenge,
      role: 'client',
      authProof: enrollmentProof,
    }, 'Paired phone'),
  }));
  const enrolled = await nextJson(enrollment.socket);
  assert.equal(enrolled.type, 'auth.ok');
  assert.equal(enrolled.authMode, 'pairing');
  assert.equal(server.deviceRegistry.isApproved('client', identity), true);
  enrollment.socket.close();

  const deviceLogin = await openSocket(url);
  deviceLogin.socket.send(JSON.stringify({
    type: 'auth.device',
    role: 'client',
    protocol: requireCurrentProtocol(deviceLogin.protocol),
    device: createDeviceAuthProof(identity, {
      challenge: deviceLogin.challenge,
      role: 'client',
      authProof: DEVICE_KEY_AUTH_CONTEXT,
    }, 'Paired phone'),
  }));
  const authenticated = await nextJson(deviceLogin.socket);
  assert.equal(authenticated.type, 'auth.ok');
  assert.equal(authenticated.authMode, 'device');
  deviceLogin.socket.close();

  const replay = await openSocket(url);
  const replayClose = once(replay.socket, 'close');
  const replayProof = createBrowserPairingProof({
    verifier,
    challenge: replay.challenge,
    pairingId: pairing.credential.id,
    deviceId: identity.id,
    publicKey: identity.publicKey,
  });
  replay.socket.send(JSON.stringify({
    type: 'auth.enroll', role: 'client', pairingId: pairing.credential.id, proof: replayProof,
    protocol: requireCurrentProtocol(replay.protocol),
    device: createDeviceAuthProof(identity, {
      challenge: replay.challenge, role: 'client', authProof: replayProof,
    }),
  }));
  assert.equal((await replayClose)[0], 4003);
});

test('an unapproved device key cannot sign in or create a pending approval request', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const identity = createDeviceIdentity();
  const opened = await openSocket(`ws://127.0.0.1:${address.port}/ws`);
  const close = once(opened.socket, 'close');
  opened.socket.send(JSON.stringify({
    type: 'auth.device', role: 'client',
    protocol: requireCurrentProtocol(opened.protocol),
    device: createDeviceAuthProof(identity, {
      challenge: opened.challenge, role: 'client', authProof: DEVICE_KEY_AUTH_CONTEXT,
    }),
  }));
  const pairing = await nextJson(opened.socket);
  assert.equal(pairing.type, 'auth.pairing');
  assert.equal((await close)[0], 4403);
  assert.equal(server.deviceRegistry.list().pending.length, 0);
});

test('server exposes a no-store runtime UI language configuration', async (t) => {
  const server = createBridgeServer({
    clientToken: TOKEN,
    connectorToken: TOKEN,
    uiLanguage: 'en-US',
    pushNotifications: {
      publicKey: 'public-push-key',
      subscribe: () => false,
      unsubscribe: () => false,
      notify: async () => undefined,
    },
  });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/config.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  const config = await response.text();
  assert.match(config, /"locale":"en"/);
  assert.match(config, /"pushPublicKey":"public-push-key"/);
});

test('runtime UI language defaults to Chinese', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/config.js`);
  assert.match(await response.text(), /"locale":"zh-CN"/);
});

test('server rejects unsafe HTTP methods and handles HEAD without a body', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${origin}/config.js`, { method: 'POST' });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET, HEAD');

  const head = await fetch(`${origin}/config.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('malformed encoded paths return 400 without stopping the relay', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${origin}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});

test('static middleware serves assets and preserves SPA fallback caching', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'bridge-static-test-'));
  const publicDir = join(fixtureDir, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<main>Codex Anywhere</main>');
  await writeFile(join(publicDir, 'app.css'), 'body { color: white; }');
  await writeFile(join(publicDir, 'service-worker.js'), 'self.skipWaiting();');
  await writeFile(join(fixtureDir, 'private.txt'), 'must not be served');
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN, publicDir });
  const address = await server.listen(0, '127.0.0.1');
  t.after(async () => {
    await server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const fetchOnce = (path: string) => fetch(`${origin}${path}`, { headers: { connection: 'close' } });

  const page = await fetchOnce('/sessions/example');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Codex Anywhere/);

  const asset = await fetchOnce('/app.css');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/css/);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await asset.text(), /color: white/);

  const serviceWorker = await fetchOnce('/service-worker.js');
  assert.equal(serviceWorker.status, 200);
  assert.equal(serviceWorker.headers.get('cache-control'), 'no-store');

  const missingAsset = await fetchOnce('/missing.js');
  assert.equal(missingAsset.status, 404);
  await missingAsset.arrayBuffer();
  const traversalAttempt = await fetchOnce('/..%2fprivate.txt');
  assert.equal(traversalAttempt.status, 200);
  const traversalBody = await traversalAttempt.text();
  assert.match(traversalBody, /Codex Anywhere/);
  assert.doesNotMatch(traversalBody, /must not be served/);
});

test('content security policy limits WebSocket connections to the current host', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN, trustProxy: true });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/`, {
    headers: { connection: 'close', host: 'codex.example.com', 'x-forwarded-proto': 'https' },
  });
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, new RegExp(`connect-src 'self' wss:\\/\\/127\\.0\\.0\\.1:${address.port};`));
  const connectSources = policy.split(';').find((directive) => directive.trim().startsWith('connect-src'))
    .trim().split(/\s+/).slice(1);
  assert.equal(connectSources.includes('ws:'), false);
  assert.equal(connectSources.includes('wss:'), false);
  assert.match(policy, /frame-src 'self' blob:;/);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()');
  await response.arrayBuffer();
});

test('server authenticates current devices and rejects plaintext application frames', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const connectorConnection = await authenticateSocket({
    url, role: 'connector', token: TOKEN, deviceId: 'personal-pc', registry: server.deviceRegistry,
  });
  const connector = connectorConnection.socket;
  assert.equal(connectorConnection.auth.type, 'auth.ok');

  const clientConnection = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry,
  });
  const client = clientConnection.socket;
  const auth = clientConnection.auth;
  assert.equal(auth.type, 'auth.ok');
  assert.equal(auth.identityId, undefined);
  assert.deepEqual(auth.devices, ['personal-pc']);
  assert.equal(auth.secureDevices, undefined);

  client.send(JSON.stringify({ type: 'ping', at: 123 }));
  const pong = await nextJson(client);
  assert.equal(pong.type, 'pong');
  assert.equal(typeof pong.at, 'number');

  client.send(JSON.stringify({ type: 'request', requestId: 'r1', action: 'connector.status', deviceId: 'personal-pc', payload: {} }));
  const rejected = await nextJson(client);
  assert.equal(rejected.requestId, 'r1');
  assert.equal(rejected.error, 'secure_channel_required');
  connector.close();
  client.close();
});

test('server routes secure-channel control and ciphertext frames without reading their payload', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const connectorConnection = await authenticateSocket({
    url, role: 'connector', token: TOKEN, deviceId: 'personal-pc', registry: server.deviceRegistry,
  });
  const clientConnection = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry,
  });
  const offer = {
    initiator: {
      id: clientConnection.identity.id,
      publicKey: clientConnection.identity.publicKey,
      ephemeralPublicKey: 'a'.repeat(43),
    },
    opaque: 'relay-must-not-interpret-this',
  };
  clientConnection.socket.send(JSON.stringify({
    type: 'channel.offer', deviceId: 'personal-pc', offer,
  }));
  const routedOffer = await nextJson(connectorConnection.socket);
  assert.equal(routedOffer.type, 'channel.offer');
  assert.deepEqual(routedOffer.offer, offer);
  assert.ok(routedOffer.clientId);

  const accept = {
    transcript: {
      responder: {
        id: connectorConnection.identity.id,
        publicKey: connectorConnection.identity.publicKey,
      },
    },
    opaque: 'still-not-relay-readable',
  };
  connectorConnection.socket.send(JSON.stringify({
    type: 'channel.accept', clientId: routedOffer.clientId, accept,
  }));
  const routedAccept = await nextJson(clientConnection.socket);
  assert.equal(routedAccept.type, 'channel.accept');
  assert.deepEqual(routedAccept.accept, accept);
  assert.equal(routedAccept.clientId, undefined);
  assert.equal(routedAccept.deviceId, 'personal-pc');

  const encryptedRequest = { channelId: 'opaque', ciphertext: 'browser-ciphertext' };
  clientConnection.socket.send(JSON.stringify({
    type: 'secure', deviceId: 'personal-pc', envelope: encryptedRequest,
  }));
  const routedRequest = await nextJson(connectorConnection.socket);
  assert.deepEqual(routedRequest.envelope, encryptedRequest);
  assert.equal(routedRequest.clientId, routedOffer.clientId);

  const encryptedResponse = { channelId: 'opaque', ciphertext: 'connector-ciphertext' };
  connectorConnection.socket.send(JSON.stringify({
    type: 'secure', clientId: routedOffer.clientId, envelope: encryptedResponse,
  }));
  const routedResponse = await nextJson(clientConnection.socket);
  assert.deepEqual(routedResponse.envelope, encryptedResponse);
  assert.equal(routedResponse.clientId, undefined);

  connectorConnection.socket.close();
  clientConnection.socket.close();
});

test('valid tokens cannot sign in from an unapproved device', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const identity = createDeviceIdentity();
  const opened = await openSocket(url);
  const proof = createAuthProof(TOKEN, opened.challenge, 'client');
  const close = once(opened.socket, 'close');
  opened.socket.send(JSON.stringify({
    type: 'auth.response', role: 'client', proof,
    protocol: requireCurrentProtocol(opened.protocol),
    device: createDeviceAuthProof(identity, {
      challenge: opened.challenge, role: 'client', authProof: proof,
    }, 'Unapproved browser'),
  }));
  const pairing = await nextJson(opened.socket);
  assert.equal(pairing.type, 'auth.pairing');
  assert.equal(pairing.deviceId, undefined);
  assert.equal(pairing.requestId, undefined);
  assert.equal((await close)[0], 4403);
  const inventory = server.deviceRegistry.list();
  assert.equal(inventory.approved.length, 0);
  assert.equal(inventory.pending.length, 1);
  assert.equal(inventory.pending[0].label, 'Unapproved browser');
});

test('revoking a device closes its active socket on the next relay heartbeat', async (t) => {
  const server = createBridgeServer({
    clientToken: TOKEN,
    connectorToken: TOKEN,
    heartbeatIntervalMs: 20,
  });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const connection = await authenticateSocket({
    url: `ws://127.0.0.1:${address.port}/ws`,
    role: 'client',
    token: TOKEN,
    registry: server.deviceRegistry,
  });
  assert.equal(connection.auth.type, 'auth.ok');

  const closed = once(connection.socket, 'close');
  assert.equal(server.deviceRegistry.remove('client', connection.identity.id), true);
  const [code] = await closed;
  assert.equal(code, 4403);
});

test('authenticated browsers cannot query the device registry outside the secure channel', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const browser = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry,
  });
  browser.socket.send(JSON.stringify({
    type: 'request', requestId: 'list-devices', action: 'devices.list', payload: {},
  }));
  const rejected = await nextJson(browser.socket);
  assert.equal(rejected.type, 'error');
  assert.equal(rejected.error, 'secure_channel_required');
  assert.equal(rejected.data, undefined);
  browser.socket.close();
});

test('server temporarily locks repeated authentication failures per real client address', async (t) => {
  const server = createBridgeServer({
    clientToken: TOKEN,
    connectorToken: TOKEN,
    trustProxy: true,
    authFailureLimit: 2,
    authFailureWindowMs: 60_000,
    authLockMs: 60_000,
  });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  async function authenticate(token, clientAddress) {
    const identity = createDeviceIdentity();
    if (token === TOKEN) {
      const requested = server.deviceRegistry.requestPairing({
        role: 'client',
        device: { id: identity.id, publicKey: identity.publicKey, signature: '0'.repeat(128) },
        address: clientAddress,
      });
      server.deviceRegistry.approve(requested.requestId);
    }
    const { socket, challenge, protocol } = await openSocket(url, { headers: { 'x-real-ip': clientAddress } });
    const close = once(socket, 'close');
    const proof = createAuthProof(token, challenge, 'client');
    socket.send(JSON.stringify({
      type: 'auth.response', role: 'client', proof,
      protocol: requireCurrentProtocol(protocol),
      device: createDeviceAuthProof(identity, {
        challenge, role: 'client', authProof: proof,
      }),
    }));
    return { socket, close };
  }

  const first = await authenticate('wrong-one', '203.0.113.10');
  assert.equal((await first.close)[0], 4003);
  const second = await authenticate('wrong-two', '203.0.113.10');
  assert.equal((await second.close)[0], 4429);

  const lockedSocket = new WebSocket(url, { headers: { 'x-real-ip': '203.0.113.10' } });
  const lockedClose = once(lockedSocket, 'close');
  await once(lockedSocket, 'open');
  assert.equal((await lockedClose)[0], 4429);

  const otherAddress = await authenticate(TOKEN, '203.0.113.11');
  assert.equal((await nextJson(otherAddress.socket)).type, 'auth.ok');
  otherAddress.socket.close();
});

test('server rejects raw bearer tokens and captured proof replay', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const raw = await openSocket(url);
  const rawClose = once(raw.socket, 'close');
  raw.socket.send(JSON.stringify({ type: 'auth', role: 'client', token: TOKEN }));
  assert.equal((await rawClose)[0], 4406);

  const first = await openSocket(url);
  const capturedProof = createAuthProof(TOKEN, first.challenge, 'client');
  first.socket.close();

  const second = await openSocket(url);
  assert.notEqual(first.challenge, second.challenge);
  const replayClose = once(second.socket, 'close');
  second.socket.send(JSON.stringify({
    type: 'auth.response', role: 'client', proof: capturedProof,
    protocol: requireCurrentProtocol(second.protocol),
  }));
  assert.equal((await replayClose)[0], 4003);
});

test('separate role credentials prevent a client token from replacing the connector', async (t) => {
  const server = createBridgeServer({ clientToken: CLIENT_TOKEN, connectorToken: CONNECTOR_TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const connector = await authenticateSocket({
    url, role: 'connector', token: CONNECTOR_TOKEN, deviceId: 'personal-pc', registry: server.deviceRegistry,
  });
  assert.equal(connector.auth.type, 'auth.ok');

  const impostor = await openSocket(url);
  const close = once(impostor.socket, 'close');
  impostor.socket.send(JSON.stringify({
    type: 'auth.response', role: 'connector', deviceId: 'personal-pc',
    protocol: requireCurrentProtocol(impostor.protocol),
    proof: createAuthProof(CLIENT_TOKEN, impostor.challenge, 'connector', 'personal-pc'),
  }));
  assert.equal((await close)[0], 4003);
  assert.equal(server.connectors.size, 1);
  assert.equal(connector.socket.readyState, WebSocket.OPEN);

  const clientImpostor = await openSocket(url);
  const clientClose = once(clientImpostor.socket, 'close');
  clientImpostor.socket.send(JSON.stringify({
    type: 'auth.response', role: 'client',
    protocol: requireCurrentProtocol(clientImpostor.protocol),
    proof: createAuthProof(CONNECTOR_TOKEN, clientImpostor.challenge, 'client'),
  }));
  assert.equal((await clientClose)[0], 4003);
  connector.socket.close();
});

test('authenticated sockets expire and can reconnect with a fresh proof', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN, sessionMaxAgeMs: 40 });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const identity = createDeviceIdentity();
  const first = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry, identity,
  });
  const firstClose = once(first.socket, 'close');
  assert.equal((await firstClose)[0], 4005);
  const second = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry, identity,
  });
  assert.equal(second.auth.type, 'auth.ok');
  second.socket.close();
});

test('authentication failure tracking is bounded and evicts the stalest address', () => {
  const { AuthFailureLimiter } = serverInternals;
  const limiter = new AuthFailureLimiter({ maxEntries: 3, limit: 8 });
  limiter.recordFailure('203.0.113.1');
  limiter.recordFailure('203.0.113.2');
  limiter.recordFailure('203.0.113.3');
  limiter.recordFailure('203.0.113.1');
  limiter.recordFailure('203.0.113.4');
  assert.equal(limiter.entries.size, 3);
  assert.equal(limiter.entries.has('203.0.113.1'), true);
  assert.equal(limiter.entries.has('203.0.113.2'), false);
  assert.equal(limiter.entries.has('203.0.113.3'), true);
  assert.equal(limiter.entries.has('203.0.113.4'), true);
});

test('server rejects browser WebSocket connections from another origin', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: { origin: 'https://attacker.example' },
  });
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
});
