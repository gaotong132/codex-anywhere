import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import {
  loadSessionModelSettings,
  saveSessionModelSettings,
} from '../src/connector/session-model-settings.js';

test('Desktop fallback reads exact saved metadata without defaults, history or resume', async t => {
  const app = new CodexAppServer();
  t.after(() => app.close());
  app.ensureStarted = async () => {};
  let thread: any = { id: 'cold', model: 'new-model-outside-catalog', reasoningEffort: 'xhigh' };
  let reads = 0;
  app.rpcRaw = async (method, params, timeout) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'cold', includeTurns: false });
    assert.equal(timeout, 5000); reads++;
    return { thread };
  };
  const config = await app.readStoredModelConfig('cold', Promise.resolve([]));
  assert.deepEqual(config, { model: 'new-model-outside-catalog', reasoningEffort: 'xhigh',
    source: 'persisted', readOnly: true, serviceTier: null, fastMode: false, models: [] });
  assert.equal(reads, 1);
  thread.reasoningEffort = null;
  assert.equal((await app.readStoredModelConfig('cold', [])).reasoningEffort, '');
  thread.id = 'other';
  await assert.rejects(app.readStoredModelConfig('cold', []), /desktop_model_unavailable/);
  thread = { id: 'cold', model: null };
  await assert.rejects(app.readStoredModelConfig('cold', []), /desktop_model_unavailable/);
  await assert.rejects(app.readStoredModelConfig('', []), /thread_id_required/);
});

test('session model settings persist in a private connector state file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-model-settings-'));
  const filePath = join(directory, 'settings.json');
  try {
    const settings = new Map([
      ['thread-1', { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', serviceTier: 'default' }],
    ]);
    saveSessionModelSettings(filePath, settings);
    settings.set('thread-2', { model: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'default' });
    saveSessionModelSettings(filePath, settings);
    assert.deepEqual(loadSessionModelSettings(filePath).get('thread-1'), {
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', serviceTier: 'default',
    });
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.sessions['thread-1'].reasoningEffort, 'xhigh');
    assert.equal(stored.sessions['thread-2'].reasoningEffort, 'high');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed persisted session settings fall back safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-bad-model-settings-'));
  const filePath = join(directory, 'settings.json');
  try {
    await writeFile(filePath, '{not-json');
    assert.equal(loadSessionModelSettings(filePath).size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Desktop model overrides survive a connector restart before the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-anywhere-model-restart-'));
  const filePath = join(directory, 'settings.json');
  try {
    const first = new CodexAppServer({ runtimeCwd: process.cwd(), modelSettingsPath: filePath });
    first.ensureStarted = async () => {};
    first.sessionMetadata.set('thread-1', {
      path: join(directory, 'rollout.jsonl'), cwd: process.cwd(), canAcceptDirectInput: false,
    });
    first.rpcRaw = async (method) => {
      if (method === 'model/list') return { data: [{
        id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'xhigh', description: '' },
        ],
        defaultReasoningEffort: 'low', serviceTiers: [{ id: 'default', name: 'Standard' }],
        defaultServiceTier: 'default', isDefault: true,
      }] };
      if (method === 'thread/settings/update') throw new Error('thread not found: thread-1');
      if (method === 'thread/resume') throw new Error('thread thread-1 already has an active writer');
      throw new Error(`unexpected method ${method}`);
    };
    await first.updateModelConfig('thread-1', {
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', fastMode: false,
    });

    const restarted = new CodexAppServer({ runtimeCwd: process.cwd(), modelSettingsPath: filePath });
    assert.deepEqual(await restarted.getDesktopTurnOverrides('thread-1'), {
      model: 'gpt-5.6-sol', thinking: 'xhigh',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
