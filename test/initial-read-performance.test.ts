import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { NativeFrameReader } from '../src/connector/native-frame-reader.js';
import { encodeNativeFrame, MAX_FRAME_BYTES } from '../src/connector/desktop-native-pipe.js';
import { measureOperation, operationMetrics } from '../src/connector/operation-metrics.js';

test('fragmented native frames, adjacent frames and reconnects preserve bytes and bounds', () => {
  const reader = new NativeFrameReader(MAX_FRAME_BYTES);
  const expected = [{ text: '中'.repeat(800_000) }, { final: true }];
  const data = Buffer.concat(expected.map(encodeNativeFrame));
  const received: unknown[] = [];
  for (let offset = 0; offset < data.length; offset += 997) {
    reader.push(data.subarray(offset, offset + 997), body => { received.push(JSON.parse(body.toString())); return true; });
  }
  assert.deepEqual(received, expected);
  reader.push(data.subarray(0, 20), () => assert.fail('incomplete frame'));
  reader.clear();
  reader.push(encodeNativeFrame({ next: true }), body => { assert.deepEqual(JSON.parse(body.toString()), { next: true }); return true; });
  for (const length of [0, MAX_FRAME_BYTES + 1]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(length);
    assert.throws(() => reader.push(header, () => assert.fail()), /invalid frame size/);
  }
});

test('concurrent initial lists share work but subsequent lists are fresh', async () => {
  const app = new CodexAppServer(); app.ensureStarted = async () => {};
  let calls = 0, release!: (value: any) => void;
  app.rpcRaw = async <T>() => { calls++; return await new Promise<T>(resolve => { release = resolve; }); };
  const reads = [app.listSessions(), app.listSessions()];
  await Promise.resolve(); assert.equal(calls, 1);
  release({ data: [{ id: 'one', name: 'old' }] });
  assert.equal((await Promise.all(reads))[1][0].title, 'old');
  const next = app.listSessions(); await Promise.resolve(); assert.equal(calls, 2);
  release({ data: [{ id: 'one', name: 'new' }] });
  assert.equal((await next)[0].title, 'new');
});

test('catalog refresh is coalesced, stale display is immediate, strict reads still see errors', async () => {
  const app = new CodexAppServer(); app.ensureStarted = async () => {};
  let calls = 0, release!: (value: any) => void;
  app.rpcRaw = async <T>() => { calls++; return await new Promise<T>(resolve => { release = resolve; }); };
  const reads = [app.listModels(), app.listModels()];
  await Promise.resolve(); assert.equal(calls, 1);
  release({ data: [{ model: 'old', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] });
  await Promise.all(reads);
  app.modelCatalogCache!.expiresAt = 0;
  assert.equal((await app.listModels({ allowStale: true }))[0].model, 'old');
  assert.equal((await app.listModels({ allowStale: true }))[0].model, 'old');
  assert.equal(calls, 2);
  const strict = app.listModels();
  release({ data: [{ model: 'new', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] });
  assert.equal((await strict)[0].model, 'new');
  app.modelCatalogCache!.expiresAt = 0;
  app.rpcRaw = async () => { throw new Error('catalog failed'); };
  await assert.rejects(app.listModels(), /catalog failed/);
});

test('operation diagnostics are bounded and exclude error details and payloads', async () => {
  for (let i = 0; i < 140; i++) await measureOperation('model.owner', async () => null);
  await assert.rejects(measureOperation('model.catalog', async () => { throw new Error('timeout secret-path-token'); }));
  const snapshot = operationMetrics();
  assert.equal(snapshot.length, 128);
  assert.equal(snapshot.at(-1)!.outcome, 'timeout');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-path-token/);
  snapshot[0].operation = 'changed';
  assert.equal(operationMetrics()[0].operation, 'model.owner');
});
