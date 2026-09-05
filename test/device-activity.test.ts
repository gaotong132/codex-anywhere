import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ACTIVITY_STALE_MS, DeviceActivity, activityForDevice, deviceActivityPath, readDeviceActivity } from '../src/server/device-activity.js';
import { DeviceRegistry } from '../src/server/device-registry.js';
import { runDeviceAdmin } from '../src/server/device-admin.js';
import { createDeviceIdentity } from '../src/shared/device-auth.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-activity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new DeviceRegistry(join(directory, 'devices.json'));
  const identity = createDeviceIdentity();
  const pending = registry.requestPairing({ role: 'client', device: { ...identity, signature: '0'.repeat(128), label: 'My browser' }, address: '127.0.0.1' });
  registry.approve(pending.requestId);
  const path = deviceActivityPath(registry.filePath)!;
  let now = Date.now();
  const activity = new DeviceActivity(path, () => registry.listApproved(), () => now);
  return { registry, identity, path, activity, now: () => now, advance: (ms: number) => { now += ms; } };
}

test('activity aggregates multiple connections, records heartbeats and keeps trust records unchanged', async (t) => {
  const h = await fixture(t);
  const trust = await readFile(h.registry.filePath!, 'utf8');
  const first = {}, second = {}, unauthenticated = {};
  h.activity.seen(unauthenticated); h.activity.flush();
  assert.deepEqual(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()), {
    status: 'offline', connections: 0, lastConnectedAt: null, lastSeenAt: null,
  });
  h.activity.connected(first, 'client', h.identity.id);
  h.advance(1000); h.activity.connected(second, 'client', h.identity.id);
  h.advance(5000); h.activity.seen(first); h.activity.flush();
  assert.deepEqual(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()), {
    status: 'online', connections: 2, lastConnectedAt: h.now() - 5000, lastSeenAt: h.now(),
  });
  h.activity.disconnected(first);
  assert.equal(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()).connections, 1);
  const seenAt = h.now(); h.advance(5000); h.activity.disconnected(second);
  const offline = activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now());
  assert.equal(offline.status, 'offline'); assert.equal(offline.connections, 0); assert.equal(offline.lastSeenAt, seenAt);
  assert.equal(await readFile(h.registry.filePath!, 'utf8'), trust);
  const text = await readFile(h.path, 'utf8');
  assert.doesNotMatch(text, new RegExp(`${h.identity.publicKey}|${h.identity.privateKey}`));
  assert.doesNotMatch(text, /My browser|127\.0\.0\.1/);
  if (process.platform !== 'win32') assert.equal((await stat(h.path)).mode & 0o777, 0o600);
});

test('activity survives restarts without reviving connections; crashes become unknown and shutdown is offline', async (t) => {
  const h = await fixture(t);
  h.activity.connected({}, 'client', h.identity.id);
  const seenAt = h.now();
  h.advance(ACTIVITY_STALE_MS + 1);
  assert.equal(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()).status, 'unknown');
  assert.equal(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()).connections, null);
  const restarted = new DeviceActivity(h.path, () => h.registry.listApproved(), h.now);
  restarted.flush();
  assert.equal(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()).status, 'offline');
  assert.equal(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()).lastSeenAt, seenAt);
  restarted.connected({}, 'client', h.identity.id); restarted.stop(); h.advance(ACTIVITY_STALE_MS * 2);
  assert.equal(activityForDevice(readDeviceActivity(h.path), 'client', h.identity.id, h.now()).status, 'offline');
});

test('external approvals and revocations survive activity writes and revoked observations are pruned', async (t) => {
  const h = await fixture(t);
  const socket = {}; h.activity.connected(socket, 'client', h.identity.id);
  const operator = new DeviceRegistry(h.registry.filePath);
  const other = createDeviceIdentity();
  const pending = operator.requestPairing({ role: 'connector', device: { ...other, signature: '0'.repeat(128), label: 'PC' }, address: '127.0.0.1' });
  operator.approve(pending.requestId); operator.remove('client', h.identity.id);
  const trust = await readFile(h.registry.filePath!, 'utf8');
  h.activity.seen(socket); h.activity.flush();
  assert.equal(await readFile(h.registry.filePath!, 'utf8'), trust);
  assert.deepEqual(readDeviceActivity(h.path)!.devices.map((device) => device.id), [other.id]);
});

test('missing or invalid snapshots report unknown instead of inventing online history', async (t) => {
  const h = await fixture(t);
  assert.equal(readDeviceActivity(h.path), null);
  assert.equal(activityForDevice(null, 'client', h.identity.id).status, 'unknown');
  h.activity.connected({}, 'client', h.identity.id);
  const good = readDeviceActivity(h.path)!;
  for (const invalid of [{}, { ...good, version: 2 }, { ...good, updatedAt: 'today' },
    { ...good, devices: [{ ...good.devices[0], connections: -1 }] },
    { ...good, devices: [{ ...good.devices[0], lastSeenAt: 9e16 }] }]) {
    await writeFile(h.path, JSON.stringify(invalid));
    assert.equal(readDeviceActivity(h.path), null);
  }
  assert.equal(activityForDevice({ ...good, updatedAt: h.now() + 1000 }, 'client', h.identity.id, h.now()).status, 'unknown');
});

test('admin text and JSON show activity without key material, including stale and empty reports', async (t) => {
  const h = await fixture(t); h.activity.connected({}, 'client', h.identity.id);
  const run = async (args: string[], language = 'zh-CN') => {
    let output = '';
    await runDeviceAdmin({ registry: h.registry, args, language,
      io: { write: (text) => { output += text; }, question: async () => assert.fail('listing must not prompt') } });
    assert.doesNotMatch(output, new RegExp(`${h.identity.publicKey}|${h.identity.privateKey}`));
    return output;
  };
  const text = await run(['list-approved']);
  assert.match(text, /在线 · 连接数 1/); assert.match(text, /最后在线/); assert.match(text, /UTC/);
  const json = JSON.parse(await run(['list-approved', '--json']));
  assert.equal(json.activityAvailable, true); assert.equal(json.devices[0].connections, 1);
  assert.equal(json.devices[0].id, h.identity.id); assert.equal(json.devices[0].publicKey, undefined);
  const snapshot = readDeviceActivity(h.path)!;
  await writeFile(h.path, JSON.stringify({ ...snapshot, updatedAt: Date.now() - ACTIVITY_STALE_MS - 1000 }));
  const stale = JSON.parse(await run(['list-approved', '--json']));
  assert.equal(stale.devices[0].status, 'unknown'); assert.equal(stale.devices[0].connections, null);
  assert.equal(stale.devices[0].lastSeenAt, snapshot.devices[0].lastSeenAt);
  assert.match(await run(['list-approved'], 'en'), /snapshot is missing or stale/);
  h.registry.remove('client', h.identity.id);
  assert.deepEqual(JSON.parse(await run(['list-approved', '--json'])).devices, []);
});
