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
  app.activeTurns.set('cold', { threadId: 'cold', state: 'running' } as any);
  assert.equal((await app.readStoredPermissionConfig('cold')).mode, 'full');
  app.activeTurns.clear();
  assert.deepEqual(await app.readStoredPermissionConfig('cold'), {
    mode: 'auto', networkAccess: false, source: 'persisted', editable: true,
    settingsToken: (await readRolloutPermissionSnapshot(path)).settingsToken,
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
  assert.deepEqual(await readRolloutPermissionSnapshot(path), { mode: 'full', networkAccess: true, settingsToken: (await readRolloutPermissionSnapshot(path)).settingsToken });
  await appendFile(path, JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(1024 * 1024) } }) + '\n');
  await assert.rejects(readRolloutPermissionSnapshot(path), /desktop_permissions_unavailable/);
});

test('cold permission edits serialize, recheck the locked snapshot and always release the temporary runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cold-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout.jsonl');
  await writeFile(path, row(auto));
  const app = new CodexAppServer({ allowedRoots: [directory], allowFullAccess: true });
  app.sessionMetadata.set('cold', { cwd: directory, path, canAcceptDirectInput: true });
  let released = 0, updates = 0, race = false, writerError = false;
  t.mock.method(CodexAppServer.prototype, 'ensureStarted', async () => {});
  t.mock.method(CodexAppServer.prototype as any, 'releaseThread', async function(this: CodexAppServer) {
    assert.notEqual(this, app); released++;
  });
  t.mock.method(CodexAppServer.prototype, 'rpcRaw', async function(this: CodexAppServer, method: string, params: any) {
    assert.notEqual(this, app, 'metadata reads must not load the shared runtime');
    assert.equal(params.threadId, 'cold');
    if (method === 'thread/resume') {
      assert.equal(params.excludeTurns, true);
      if (writerError) throw new Error('writer unavailable');
      if (race) await appendFile(path, row(full));
      return { thread: { id: 'cold', cwd: directory, path, status: { type: 'idle' } } };
    }
    assert.equal(method, 'thread/settings/update'); updates++;
    assert.equal(params.approvalPolicy, 'never');
    await appendFile(path, row(full)); return {};
  });
  const token = (await app.readStoredPermissionConfig('cold')).settingsToken;
  const results = await Promise.allSettled([
    app.updateStoredPermissionConfig('cold', { mode: 'full', settingsToken: token }),
    app.updateStoredPermissionConfig('cold', { mode: 'full', settingsToken: token }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(updates, 1); assert.equal(released, 1);
  await writeFile(path, row(auto)); race = true;
  await assert.rejects(app.updateStoredPermissionConfig('cold', { mode: 'full', settingsToken: token }), /desktop_settings_changed/);
  assert.equal(updates, 1); assert.equal(released, 2);
  await writeFile(path, row(auto)); race = false; writerError = true;
  await assert.rejects(app.updateStoredPermissionConfig('cold', { mode: 'full', settingsToken: token }), /writer unavailable/);
  assert.equal(released, 3);
  app.activeTurns.set('cold', { threadId: 'cold', state: 'running' } as any);
  await assert.rejects(app.updateStoredPermissionConfig('cold', { mode: 'ask', settingsToken: token }), /permission_mode_turn_active/);
  app.activeTurns.clear(); app.allowFullAccess = false;
  await assert.rejects(app.updateStoredPermissionConfig('cold', { mode: 'full', settingsToken: token }), /full_access_not_allowed/);
  assert.equal(released, 3);
});

test('saved permission tokens survive workspace normalization but detect actual permission changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'permission-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout.jsonl');
  const entry = { path: { type: 'path', path: directory }, access: 'write' };
  const profile = { type: 'managed', file_system: { type: 'restricted', entries: [entry, entry] }, network: 'restricted' };
  const settings = { cwd: directory, approval_policy: 'on-request', approvals_reviewer: 'user', permission_profile: profile };
  await writeFile(path, row(settings));
  const before = await readRolloutPermissionSnapshot(path); assert.equal(before.mode, 'ask');
  await writeFile(path, row({ ...settings, model: 'different', active_permission_profile: { id: ':workspace' },
    permission_profile: { ...profile, file_system: { ...profile.file_system, entries: [entry] } } }));
  assert.equal((await readRolloutPermissionSnapshot(path)).settingsToken, before.settingsToken);
  await appendFile(path, row({ ...settings, approvals_reviewer: 'auto_review' }));
  assert.notEqual((await readRolloutPermissionSnapshot(path)).settingsToken, before.settingsToken);
  await appendFile(path, row({ ...settings, active_permission_profile: { id: 'restricted-custom' } }));
  assert.equal((await readRolloutPermissionSnapshot(path)).mode, 'custom');
});
