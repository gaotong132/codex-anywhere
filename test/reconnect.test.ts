import assert from 'node:assert/strict';
import test from 'node:test';
import { once, EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { monitorConnectorSocket, scheduleReferencedRetry } from '../src/connector/reconnect.js';

test('connector reconnect retry keeps the process alive', () => {
  const timer = scheduleReferencedRetry(() => {}, 60_000);
  try {
    assert.equal(timer.hasRef(), true);
  } finally {
    clearTimeout(timer);
  }
});

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  pings = 0;
  terminations = 0;
  ping() { this.pings++; }
  terminate() { this.terminations++; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

test('wake detects elapsed silence immediately, including connecting and closing sockets', () => {
  for (const state of [WebSocket.OPEN, WebSocket.CONNECTING, WebSocket.CLOSING]) {
    const socket = new TestSocket();
    socket.readyState = state;
    let now = 0;
    const monitor = monitorConnectorSocket(socket as unknown as WebSocket, { now: () => now });
    now = 10_000;
    monitor.check();
    now = 3_600_000; // No timer ticks while the laptop was asleep.
    monitor.check();
    monitor.check();
    assert.equal(socket.terminations, 1);
    assert.equal(socket.listenerCount('pong'), 0);
    assert.equal(socket.listenerCount('close'), 0);
  }
});

test('only inbound activity refreshes the deadline and closed monitors stay stopped', () => {
  const socket = new TestSocket();
  let now = 0;
  const monitor = monitorConnectorSocket(socket as unknown as WebSocket, { now: () => now });
  try {
    for (const event of ['pong', 'ping', 'message']) {
      now += 40_000;
      socket.emit(event);
      monitor.check();
      assert.equal(socket.terminations, 0);
    }
    now += 40_000;
    monitor.check(); // Sending another ping cannot extend the inbound deadline.
    now += 5_000;
    monitor.check();
    assert.equal(socket.terminations, 1);
    assert.equal(socket.pings, 4);
    socket.readyState = WebSocket.OPEN;
    now += 60_000;
    monitor.check();
    assert.equal(socket.terminations, 1);
  } finally { monitor.stop(); }
});

test('real half-open WebSocket is terminated and can reconnect to a responsive relay', { timeout: 10_000 }, async () => {
  const relay = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
  await once(relay, 'listening');
  const address = relay.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  let now = 0;
  let monitor: ReturnType<typeof monitorConnectorSocket> | undefined;
  try {
    let peerReady = once(relay, 'connection');
    const silent = new WebSocket(url);
    sockets.push(silent);
    await once(silent, 'open');
    const [peer] = await peerReady as [WebSocket];
    monitor = monitorConnectorSocket(silent, { now: () => now });
    const receivedPing = once(peer, 'ping');
    monitor.check();
    await receivedPing;
    assert.equal(silent.readyState, WebSocket.OPEN);
    const closed = once(silent, 'close');
    now = 60_000;
    monitor.check();
    await closed;
    assert.equal(silent.readyState, WebSocket.CLOSED);

    peerReady = once(relay, 'connection');
    const fresh = await new Promise<WebSocket>((resolve) => {
      scheduleReferencedRetry(() => resolve(new WebSocket(url)), 1);
    });
    sockets.push(fresh);
    await once(fresh, 'open');
    const [healthyPeer] = await peerReady as [WebSocket];
    healthyPeer.on('ping', (data) => healthyPeer.pong(data));
    monitor = monitorConnectorSocket(fresh, { now: () => now });
    for (let i = 0; i < 3; i++) {
      now += 40_000;
      const pong = once(fresh, 'pong');
      monitor.check();
      await pong;
      assert.equal(fresh.readyState, WebSocket.OPEN);
    }
    const closedNormally = once(fresh, 'close');
    fresh.close();
    await closedNormally;
    assert.equal(fresh.listenerCount('pong'), 0);
  } finally {
    monitor?.stop();
    for (const socket of sockets) socket.terminate();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
});
