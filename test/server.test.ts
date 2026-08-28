import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBridgeServer, internals as serverInternals } from '../src/server/server.js';

const TOKEN = 'test-token-that-is-longer-than-32-characters';
const nextJson = (socket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()));

test('server exposes a no-store runtime UI language configuration', async (t) => {
  const server = createBridgeServer({ token: TOKEN, uiLanguage: 'en-US' });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/config.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(await response.text(), /"locale":"en"/);
});

test('runtime UI language defaults to Chinese', async (t) => {
  const server = createBridgeServer({ token: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/config.js`);
  assert.match(await response.text(), /"locale":"zh-CN"/);
});

test('server rejects unsafe HTTP methods and handles HEAD without a body', async (t) => {
  const server = createBridgeServer({ token: TOKEN });
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
  const server = createBridgeServer({ token: TOKEN });
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
  const server = createBridgeServer({ token: TOKEN, publicDir });
  const address = await server.listen(0, '127.0.0.1');
  t.after(async () => {
    await server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/sessions/example`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Codex Anywhere/);

  const asset = await fetch(`${origin}/app.css`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/css/);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await asset.text(), /color: white/);

  assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
  const traversalAttempt = await fetch(`${origin}/..%2fprivate.txt`);
  assert.equal(traversalAttempt.status, 200);
  const traversalBody = await traversalAttempt.text();
  assert.match(traversalBody, /Codex Anywhere/);
  assert.doesNotMatch(traversalBody, /must not be served/);
});

test('content security policy limits WebSocket connections to the current host', async (t) => {
  const server = createBridgeServer({ token: TOKEN, trustProxy: true });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/`, {
    headers: { host: 'codex.example.com', 'x-forwarded-proto': 'https' },
  });
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, new RegExp(`connect-src 'self' wss:\\/\\/127\\.0\\.0\\.1:${address.port};`));
  const connectSources = policy.split(';').find((directive) => directive.trim().startsWith('connect-src'))
    .trim().split(/\s+/).slice(1);
  assert.equal(connectSources.includes('ws:'), false);
  assert.equal(connectSources.includes('wss:'), false);
});

test('server authenticates and relays client requests to connector', async (t) => {
  const server = createBridgeServer({ token: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const connector = new WebSocket(url);
  await once(connector, 'open');
  connector.send(JSON.stringify({ type: 'auth', role: 'connector', token: TOKEN, deviceId: 'personal-pc' }));
  assert.equal((await nextJson(connector)).type, 'auth.ok');

  const client = new WebSocket(url);
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'auth', role: 'client', token: TOKEN }));
  const auth = await nextJson(client);
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

test('server rejects a wrong token', async (t) => {
  const server = createBridgeServer({ token: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', role: 'client', token: 'wrong' }));
  const [code] = await once(socket, 'close');
  assert.equal(code, 4003);
});

test('server temporarily locks repeated authentication failures per real client address', async (t) => {
  const server = createBridgeServer({
    token: TOKEN,
    trustProxy: true,
    authFailureLimit: 2,
    authFailureWindowMs: 60_000,
    authLockMs: 60_000,
  });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  async function authenticate(token, clientAddress) {
    const socket = new WebSocket(url, { headers: { 'x-real-ip': clientAddress } });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'auth', role: 'client', token }));
    return { socket, close: once(socket, 'close') };
  }

  const first = await authenticate('wrong-one', '203.0.113.10');
  assert.equal((await first.close)[0], 4003);
  const second = await authenticate('wrong-two', '203.0.113.10');
  assert.equal((await second.close)[0], 4429);

  const locked = await authenticate(TOKEN, '203.0.113.10');
  assert.equal((await locked.close)[0], 4429);

  const otherAddress = await authenticate(TOKEN, '203.0.113.11');
  assert.equal((await nextJson(otherAddress.socket)).type, 'auth.ok');
  otherAddress.socket.close();
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
  const server = createBridgeServer({ token: TOKEN });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: { origin: 'https://attacker.example' },
  });
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
});
