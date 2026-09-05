import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';

for (const desktop of [false, true]) test(`runtime release after a completed turn: Desktop=${desktop}`, async () => {
  const codex = new CodexAppServer({ releaseRuntimeAfterTurn: desktop });
  let kills = 0;
  const child = Object.assign(new EventEmitter(), { kill() { kills++; queueMicrotask(() => child.emit('close', 0)); } });
  codex.child = child as any;
  codex.activeTurn = { threadId: 'fixture', turnId: 'turn', cwd: process.cwd(), state: 'running' };
  codex.rpcRaw = async () => ({ status: 'unsubscribed' }) as any;
  codex.handleNotification('turn/completed', { turn: { status: 'completed' } });
  await codex.prepareDesktopTurn();
  assert.equal(kills, desktop ? 1 : 0);
  assert.equal(codex.child, desktop ? null : child);
});

test('release never kills a replacement runtime or a new active turn', async () => {
  for (const replacement of [true, false]) {
    const codex = new CodexAppServer({ releaseRuntimeAfterTurn: true }); let kills = 0;
    const child = Object.assign(new EventEmitter(), { kill() { kills++; } });
    codex.child = child as any;
    codex.activeTurn = { threadId: 'fixture', turnId: 'turn', cwd: process.cwd(), state: 'running' };
    let done!: () => void;
    codex.rpcRaw = async () => { await new Promise<void>(resolve => { done = resolve; }); return {} as any; };
    codex.handleNotification('turn/completed', { turn: { status: 'completed' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    if (replacement) codex.child = Object.assign(new EventEmitter(), { kill() { kills++; } }) as any;
    else codex.activeTurn = { threadId: 'next', turnId: 'next-turn', cwd: process.cwd(), state: 'running' };
    done(); await codex.prepareDesktopTurn(); assert.equal(kills, 0);
  }
});

test('Desktop release drains an existing read and queues its next RPC and new requests on the replacement', async () => {
  const codex = new CodexAppServer({ releaseRuntimeAfterTurn: true });
  let kills = 0, starts = 0;
  const oldChild = Object.assign(new EventEmitter(), {
    stdin: { writable: true }, kill() { kills++; queueMicrotask(() => oldChild.emit('close', 0)); },
  });
  const newChild = Object.assign(new EventEmitter(), { stdin: { writable: true } });
  codex.child = oldChild as any;
  codex.startProcess = async () => { starts++; codex.child = newChild as any; };
  const writes: { id: number; method: string; child: unknown }[] = [];
  codex.writeRpc = (message) => {
    writes.push({ id: message.id, method: message.method, child: codex.child });
    if (message.method === 'thread/read') return;
    const result = message.method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : { data: [] };
    queueMicrotask(() => codex.handleLine(JSON.stringify({ id: message.id, result })));
  };
  codex.activeTurn = { threadId: 'fixture', turnId: 'turn', cwd: process.cwd(), state: 'running' };
  const reading = codex.readSession('fixture');
  await new Promise<void>((resolve) => setImmediate(resolve));
  codex.handleNotification('turn/completed', { turn: { status: 'completed' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const listing = codex.listSessions();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(kills, 0, 'the pending read must survive turn completion');
  assert.deepEqual(writes.map(({ method }) => method), ['thread/read', 'thread/unsubscribe']);
  codex.handleLine(JSON.stringify({ id: writes[0].id, result: { thread: { id: 'fixture', cwd: process.cwd() } } }));
  const [session, sessions] = await Promise.all([reading, listing, codex.prepareDesktopTurn()]);
  assert.equal(session.id, 'fixture');
  assert.deepEqual(sessions, []);
  assert.equal(kills, 1);
  assert.equal(starts, 1, 'queued calls share a single initialized replacement');
  assert.ok(writes.filter(({ method }) => ['thread/list', 'thread/turns/list'].includes(method))
    .every(({ child }) => child === newChild));
  assert.equal(codex.pending.size, 0);
});

test('an RPC timeout still permits Desktop runtime release', async () => {
  const codex = new CodexAppServer({ releaseRuntimeAfterTurn: true });
  let kills = 0;
  const child = Object.assign(new EventEmitter(), { kill() { kills++; queueMicrotask(() => child.emit('close', 0)); } });
  codex.child = child as any;
  codex.writeRpc = (message) => {
    if (message.method === 'thread/unsubscribe') queueMicrotask(() => codex.handleLine(JSON.stringify({ id: message.id, result: {} })));
  };
  const timedOut = assert.rejects(codex.rpcRaw('thread/read', {}, 30), /RPC timeout: thread\/read/);
  codex.activeTurn = { threadId: 'fixture', turnId: 'turn', cwd: process.cwd(), state: 'running' };
  codex.handleNotification('turn/completed', { turn: { status: 'completed' } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await Promise.all([timedOut, codex.prepareDesktopTurn()]);
    assert.equal(kills, 1);
    assert.equal(codex.pending.size, 0);
  } finally { clearTimeout(keepAlive); }
});
