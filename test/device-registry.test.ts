import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DeviceRegistry } from '../src/server/device-registry.js';
import { resolveDeviceAdminRegistryPath, runDeviceAdmin } from '../src/server/device-admin.js';
import { createDeviceIdentity } from '../src/shared/device-auth.js';

test('device approval command uses the local registry unless a deployment path is configured', () => {
  assert.equal(resolveDeviceAdminRegistryPath(), resolve('data/devices.json'));
  assert.equal(resolveDeviceAdminRegistryPath('  custom/devices.json  '), resolve('custom/devices.json'));
});

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

test('device approval command confirms a numbered device without exposing key material', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-device-admin-'));
  const filePath = join(directory, 'devices.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new DeviceRegistry(filePath);
  const older = createDeviceIdentity();
  const newer = createDeviceIdentity();
  registry.requestPairing({
    role: 'client', device: { ...older, signature: '0'.repeat(128), label: 'Tablet' },
    address: '203.0.113.10', now: Date.now() - 1_000,
  });
  registry.requestPairing({
    role: 'client', device: { ...newer, signature: '0'.repeat(128), label: 'Phone' },
    address: '203.0.113.11', now: Date.now(),
  });
  const answers = ['1', 'yes'];
  let output = '';
  const result = await runDeviceAdmin({
    registry,
    io: {
      question: async (prompt) => { output += prompt; return answers.shift() || ''; },
      write: (text) => { output += text; },
    },
  });

  assert.equal(result, 'approved');
  assert.equal(registry.isApproved('client', newer), true);
  assert.equal(registry.isApproved('client', older), false);
  assert.match(output, /Select a device to approve/);
  assert.match(output, /Approved client: Phone/);
  assert.doesNotMatch(output, new RegExp(newer.privateKey));
  assert.doesNotMatch(output, new RegExp(newer.publicKey));
});

test('device approval command follows the configured Chinese language', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-device-admin-zh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new DeviceRegistry(join(directory, 'devices.json'));
  const identity = createDeviceIdentity();
  registry.requestPairing({
    role: 'client', device: { ...identity, signature: '0'.repeat(128), label: '我的手机' },
    address: '203.0.113.12',
  });
  let output = '';
  const result = await runDeviceAdmin({
    registry,
    language: 'zh-CN',
    io: {
      question: async (prompt) => { output += prompt; return '确认'; },
      write: (text) => { output += text; },
    },
  });

  assert.equal(result, 'approved');
  assert.match(output, /待批准设备/);
  assert.match(output, /已批准浏览器：我的手机/);
  assert.doesNotMatch(output, new RegExp(identity.publicKey));
});

test('device administration revokes an approved device without printing identity material', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-device-revoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new DeviceRegistry(join(directory, 'devices.json'));
  const identity = createDeviceIdentity();
  const pending = registry.requestPairing({
    role: 'connector', device: { ...identity, signature: '0'.repeat(128), label: 'Office PC' },
    address: '203.0.113.13',
  });
  registry.approve(pending.requestId);
  let output = '';
  const result = await runDeviceAdmin({
    registry,
    args: ['revoke', '1', '--yes'],
    io: {
      question: async (prompt) => { output += prompt; return ''; },
      write: (text) => { output += text; },
    },
  });

  assert.equal(result, 'revoked');
  assert.equal(registry.isApproved('connector', identity), false);
  assert.match(output, /Revoked connector: Office PC/);
  assert.doesNotMatch(output, new RegExp(identity.id));
  assert.doesNotMatch(output, new RegExp(identity.publicKey));
});
