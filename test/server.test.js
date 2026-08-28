import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../src/server/server.js';

const TOKEN = 'test-token-that-is-longer-than-32-characters';
const nextJson = (socket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()));

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
