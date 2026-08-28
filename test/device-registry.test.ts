import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceRegistry } from '../src/server/device-registry.js';
import { createDeviceIdentity } from '../src/shared/device-auth.js';

test('device registry persists public trust records and reloads external approvals', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-devices-'));
  const filePath = join(directory, 'devices.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const identity = createDeviceIdentity();
  const serverRegistry = new DeviceRegistry(filePath);
  const operatorRegistry = new DeviceRegistry(filePath);
  const pending = serverRegistry.requestPairing({
    role: 'client',
    device: {
      id: identity.id,
      publicKey: identity.publicKey,
      signature: '0'.repeat(128),
      label: 'Trusted phone',
    },
    address: '203.0.113.10',
  });

  assert.equal(serverRegistry.isApproved('client', identity), false);
  assert.equal(operatorRegistry.approve(pending.requestId)?.id, identity.id);
  assert.equal(serverRegistry.isApproved('client', identity), true);

  const stored = await readFile(filePath, 'utf8');
  assert.doesNotMatch(stored, new RegExp(identity.privateKey));
  assert.match(stored, new RegExp(identity.publicKey));

  assert.equal(operatorRegistry.remove('client', identity.id), true);
  assert.equal(serverRegistry.isApproved('client', identity), false);
});
