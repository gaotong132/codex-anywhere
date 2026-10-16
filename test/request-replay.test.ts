import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestReplayCache } from '../src/connector/request-replay.js';

test('pending mutation identity outlives TTL and completed-result eviction', async () => {
  const cache = new RequestReplayCache<number>(2, 2);
  let finish!: (value: number) => void;
  const first = cache.run('first', 'same', 1, () => new Promise(resolve => { finish = resolve; }));
  for (let index = 0; index < 5; index++) await cache.run(`other-${index}`, 'other', 1, async () => index);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cache.run('first', 'same', 1, async () => -1), first);
  assert.throws(() => cache.run('first', 'changed', 1, async () => -1), /request_conflict/);
  finish(7);
  assert.equal(await first, 7);
});

test('capacity rejects new work while permitting replay and releases slots after settlement', async () => {
  const cache = new RequestReplayCache<number>(1, 2);
  let finish!: (value: number) => void;
  const first = cache.run('first', 'same', 60_000, () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => cache.run('second', 'second', 60_000, async () => 2), /connector_request_limit/);
  assert.equal(cache.run('first', 'same', 60_000, async () => -1), first);
  await Promise.resolve();
  finish(1);
  await first;
  assert.equal(await cache.run('second', 'second', 60_000, async () => 2), 2);
  assert.equal(cache.run('first', 'same', 60_000, async () => -1), first);
  assert.throws(() => cache.run('first', 'changed', 60_000, async () => -1), /request_conflict/);
});

test('a failed mutation is not executed again and does not leak an active slot', async () => {
  const cache = new RequestReplayCache<number>(1, 2);
  let calls = 0;
  const fail = async () => { calls++; throw new Error('failed'); };
  await assert.rejects(cache.run('failure', 'same', 60_000, fail), /failed/);
  await assert.rejects(cache.run('failure', 'same', 60_000, fail), /failed/);
  assert.equal(calls, 1);
  assert.equal(await cache.run('next', 'next', 60_000, async () => 2), 2);
});
