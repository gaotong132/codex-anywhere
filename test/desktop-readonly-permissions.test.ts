import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionModeControl } from '../web/src/permission-mode-control.js';

test('Desktop permission metadata outside execution roots is readable without authorizing a cold writer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-readonly-permissions-'));
  t.after(() => rm(directory, { recursive: true }));
  const filePath = join(directory, 'rollout.jsonl');
  await writeFile(filePath, JSON.stringify({ type: 'turn_context', payload: {
    approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_policy: { type: 'workspace-write', writable_roots: [directory], network_access: false },
  } }) + '\n');
  const codex = new CodexAppServer({ runtimeCwd: directory, allowedRoots: [join(directory, 'allowed')], allowFullAccess: true });
  codex.ensureStarted = async () => {};
  codex.sessionMetadata.set('outside', { cwd: directory, path: filePath, canAcceptDirectInput: false });
  codex.rpcRaw = async () => { throw new Error('metadata cannot resume or mutate a thread'); };
  const config = await codex.readStoredPermissionConfig('outside', { readOnly: true });
  assert.equal(config.mode, 'ask'); assert.equal(config.editable, false);
  assert.equal(config.settingsToken, undefined); assert.equal(config.source, 'persisted');
  await assert.rejects(codex.readStoredPermissionConfig('outside'), /workspace_outside_allowed_root/);
  await assert.rejects(codex.updateStoredPermissionConfig('outside', { mode: 'auto', settingsToken: 'any' }), /workspace_outside_allowed_root/);
});

test('unknown Desktop permission metadata is labelled unknown instead of inventing a permission mode', () => {
  const html = renderToStaticMarkup(createElement(PermissionModeControl, {
    config: { mode: 'custom', modeKnown: false, editable: false, source: 'persisted',
      unavailableReason: 'desktop_controls_unsupported', networkAccess: false, allowFullAccess: false },
    loading: false, disabled: false, onChange: async () => {},
  }));
  assert.match(html, /权限未知/);
  assert.doesNotMatch(html, /自定义权限/);
});
