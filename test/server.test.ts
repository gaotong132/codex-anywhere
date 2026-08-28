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

const TOKEN = 'test-token-that-is-longer-than-32-characters';
const CLIENT_TOKEN = 'client-token-that-is-longer-than-32-characters';
const CONNECTOR_TOKEN = 'connector-token-that-is-longer-than-32-characters';
const nextJson = (socket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()));
async function nextResponse(socket: WebSocket, requestId: string) {
  while (true) {
    const message = await nextJson(socket);
    if (message.type === 'response' && message.requestId === requestId) return message;
  }
}

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
  return { socket, challenge: challenge.challenge as string };
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
  opened.socket.send(JSON.stringify({
    type: 'auth.response',
    role,
    deviceId: role === 'connector' ? deviceId : undefined,
    proof,
    device: createDeviceAuthProof(identity, {
      challenge: opened.challenge, role, routeDeviceId: deviceId, authProof: proof,
    }, 'Test device'),
  }));
  return { ...opened, auth: await nextJson(opened.socket), identity };
}

test('server exposes a no-store runtime UI language configuration', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN, uiLanguage: 'en-US' });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/config.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(await response.text(), /"locale":"en"/);
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
  await response.arrayBuffer();
});

test('server authenticates and relays client requests to connector', async (t) => {
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
  assert.deepEqual(auth.devices, ['personal-pc']);

  client.send(JSON.stringify({ type: 'ping', at: 123 }));
  const pong = await nextJson(client);
  assert.equal(pong.type, 'pong');
  assert.equal(typeof pong.at, 'number');

  client.send(JSON.stringify({ type: 'request', requestId: 'r1', action: 'connector.status', deviceId: 'personal-pc', payload: {} }));
  const forwarded = await nextJson(connector);
  assert.equal(forwarded.action, 'connector.status');
  assert.equal(forwarded.requestId, 'r1');
  assert.ok(forwarded.clientId);

  connector.send(JSON.stringify({ type: 'response', clientId: forwarded.clientId, requestId: 'r1', ok: true, data: { online: true } }));
  const response = await nextJson(client);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { online: true });
  connector.close();
  client.close();
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
    device: createDeviceAuthProof(identity, {
      challenge: opened.challenge, role: 'client', authProof: proof,
    }, 'Unapproved browser'),
  }));
  const pairing = await nextJson(opened.socket);
  assert.equal(pairing.type, 'auth.pairing');
  assert.equal(pairing.deviceId, identity.id);
  assert.equal((await close)[0], 4403);
  const inventory = server.deviceRegistry.list();
  assert.equal(inventory.approved.length, 0);
  assert.equal(inventory.pending.length, 1);
  assert.equal(inventory.pending[0].label, 'Unapproved browser');
});

test('a trusted browser can approve another signed device and revoke it later', async (t) => {
  const server = createBridgeServer({ clientToken: TOKEN, connectorToken: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const admin = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry,
  });
  const candidateIdentity = createDeviceIdentity();
  const candidate = await openSocket(url);
  const candidateProof = createAuthProof(TOKEN, candidate.challenge, 'client');
  const candidateClose = once(candidate.socket, 'close');
  candidate.socket.send(JSON.stringify({
    type: 'auth.response', role: 'client', proof: candidateProof,
    device: createDeviceAuthProof(candidateIdentity, {
      challenge: candidate.challenge, role: 'client', authProof: candidateProof,
    }, 'Second browser'),
  }));
  const pairing = await nextJson(candidate.socket);
  assert.equal(pairing.type, 'auth.pairing');
  await candidateClose;

  admin.socket.send(JSON.stringify({
    type: 'request', requestId: 'list-devices', action: 'devices.list', payload: {},
  }));
  const listed = await nextResponse(admin.socket, 'list-devices');
  assert.equal(listed.ok, true);
  assert.equal(listed.data.currentDeviceId, admin.identity.id);
  assert.equal(listed.data.pending[0].id, candidateIdentity.id);

  admin.socket.send(JSON.stringify({
    type: 'request', requestId: 'approve-device', action: 'devices.approve',
    payload: { requestId: pairing.requestId },
  }));
  const approved = await nextResponse(admin.socket, 'approve-device');
  assert.equal(approved.ok, true);
  assert.equal(server.deviceRegistry.isApproved('client', candidateIdentity), true);

  const connected = await authenticateSocket({
    url, role: 'client', token: TOKEN, registry: server.deviceRegistry, identity: candidateIdentity,
  });
  assert.equal(connected.auth.type, 'auth.ok');
  const revokedClose = once(connected.socket, 'close');
  admin.socket.send(JSON.stringify({
    type: 'request', requestId: 'remove-device', action: 'devices.remove',
    payload: { role: 'client', deviceId: candidateIdentity.id },
  }));
  const removed = await nextResponse(admin.socket, 'remove-device');
  assert.equal(removed.ok, true);
  assert.equal((await revokedClose)[0], 4408);
  assert.equal(server.deviceRegistry.isApproved('client', candidateIdentity), false);
  admin.socket.close();
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
    const { socket, challenge } = await openSocket(url, { headers: { 'x-real-ip': clientAddress } });
    const close = once(socket, 'close');
    const proof = createAuthProof(token, challenge, 'client');
    socket.send(JSON.stringify({
      type: 'auth.response', role: 'client', proof,
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

test('server rejects legacy raw tokens without locking upgrades and rejects captured proof replay', async (t) => {
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
  second.socket.send(JSON.stringify({ type: 'auth.response', role: 'client', proof: capturedProof }));
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
    proof: createAuthProof(CLIENT_TOKEN, impostor.challenge, 'connector', 'personal-pc'),
  }));
  assert.equal((await close)[0], 4003);
  assert.equal(server.connectors.size, 1);
  assert.equal(connector.socket.readyState, WebSocket.OPEN);

  const clientImpostor = await openSocket(url);
  const clientClose = once(clientImpostor.socket, 'close');
  clientImpostor.socket.send(JSON.stringify({
    type: 'auth.response', role: 'client',
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
