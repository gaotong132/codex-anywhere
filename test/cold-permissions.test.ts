import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { readRolloutPermissionSnapshot } from '../src/connector/rollout-tail.js';

const row = (settings: Record<string, unknown>) => JSON.stringify({ type: 'turn_context', payload: settings }) + '\n';
const auto = { approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_policy: { type: 'workspace-write', network_access: false } };
const full = { approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' } };

test('cold permission reads use exact cached metadata, no runtime, stale mode cache or history scan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cold-permissions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout.jsonl');
  const profile = { type: 'managed', file_system: { type: 'restricted' }, network: 'restricted' };
  await writeFile(path, row({ ...auto, permission_profile: profile }) + JSON.stringify({ type: 'event_msg', payload: {
    type: 'thread_settings_applied', thread_settings: { approval_policy: 'on-request', approvals_reviewer: 'auto_review', permission_profile: profile },
  } }) + '\n');
  assert.equal((await readRolloutPermissionSnapshot(path)).mode, 'auto');
  await writeFile(path, row(auto));
  const app = new CodexAppServer({ allowedRoots: [directory] });
  app.sessionMetadata.set('cold', { cwd: directory, path, canAcceptDirectInput: true });
  app.sessionPermissionModes.set('cold', 'full');
  app.ensureStarted = async () => assert.fail('cached metadata must not start a runtime');
  app.rpcRaw = async () => assert.fail('cached metadata must not issue RPC');
  app.activeTurn = { threadId: 'cold', state: 'running' } as any;
  assert.equal((await app.readStoredPermissionConfig('cold')).mode, 'full');
  app.activeTurn = null;
  assert.deepEqual(await app.readStoredPermissionConfig('cold'), {
    mode: 'auto', networkAccess: false, source: 'persisted', editable: false,
  });
  await appendFile(path, row(full));
  assert.equal((await app.readStoredPermissionConfig('cold')).mode, 'full');
  await assert.rejects(app.readStoredPermissionConfig(''), /thread_id_required/);
  await writeFile(path, '');
  await assert.rejects(app.readStoredPermissionConfig('cold'), /desktop_permissions_unavailable/);
});

test('missing or moved permission metadata uses one targeted read, never lists or resumes a thread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cold-permissions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout.jsonl');
  await writeFile(path, row(full));
  const app = new CodexAppServer({ allowedRoots: [directory] });
  app.ensureStarted = async () => {};
  app.sessionMetadata.set('cold', { cwd: directory, path: join(directory, 'moved.jsonl'), canAcceptDirectInput: true });
  let reads = 0;
  app.rpcRaw = async (method, params, timeout) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'cold', includeTurns: false });
    assert.equal(timeout, 5000); reads++;
    return { thread: { id: 'cold', cwd: directory, path } };
  };
  assert.equal((await app.readStoredPermissionConfig('cold')).mode, 'full');
  assert.equal((await app.readStoredPermissionConfig('cold')).mode, 'full');
  assert.equal(reads, 1);
  app.sessionMetadata.clear();
  app.rpcRaw = async () => ({ thread: { id: 'other', cwd: directory, path } });
  await assert.rejects(app.readStoredPermissionConfig('cold'), /desktop_permissions_unavailable/);
});

test('permission snapshots preserve custom settings, respect latest records and bound disk reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cold-permissions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout.jsonl');
  await writeFile(path, row(auto) + row({ ...full, permission_profile: { type: 'named', name: 'restricted' } }));
  assert.equal((await readRolloutPermissionSnapshot(path)).mode, 'custom');
  await writeFile(path, row({ ...auto, approval_policy: 'never' }));
  assert.equal((await readRolloutPermissionSnapshot(path)).mode, 'custom');
  await writeFile(path, row(auto) + JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { ...full } } }) + '\n');
  assert.deepEqual(await readRolloutPermissionSnapshot(path), { mode: 'full', networkAccess: true });
  await appendFile(path, JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(1024 * 1024) } }) + '\n');
  await assert.rejects(readRolloutPermissionSnapshot(path), /desktop_permissions_unavailable/);
});
