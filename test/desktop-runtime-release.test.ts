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
