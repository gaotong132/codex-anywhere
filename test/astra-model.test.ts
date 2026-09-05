import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { ModelConfigControl } from '../web/src/model-config-control.js';
import { reasoningEffortLabel, reasoningSliderOptions, reasoningSliderValue } from '../web/src/model-reasoning.js';
import type { ModelOption } from '../web/src/app-types.js';

// Shape verified against the local Codex model/list response on 2026-09-05.
const astra: ModelOption = {
  model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Complex, demanding work',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
  defaultReasoningEffort: 'medium',
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }],
  defaultServiceTier: null, isDefault: true,
};

test('Astra slider keeps all advertised levels and preserves saved Max/Ultra selections', () => {
  assert.deepEqual(reasoningSliderOptions(astra).map((option) => option.reasoningEffort), [
    'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
  ]);
  for (const effort of ['max', 'ultra']) {
    assert.equal(reasoningSliderValue(astra, effort), effort);
    assert.notEqual(reasoningEffortLabel(effort), reasoningEffortLabel('xhigh'));
    const markup = renderToStaticMarkup(createElement(ModelConfigControl, {
      config: { model: astra.model, reasoningEffort: effort, fastMode: false, models: [astra] },
      loading: false, disabled: false, onSave: async () => {},
    }));
    assert.ok(markup.includes(astra.displayName));
    assert.ok(markup.includes(reasoningEffortLabel(effort)));
  }
  assert.notEqual(reasoningEffortLabel('max'), reasoningEffortLabel('ultra'));
});

test('switching environments or older models offers only their own advertised reasoning levels', () => {
  const older = { ...astra, model: 'gpt-5.5', defaultReasoningEffort: 'high',
    supportedReasoningEfforts: astra.supportedReasoningEfforts.slice(0, 4) };
  assert.deepEqual(reasoningSliderOptions(older).map((option) => option.reasoningEffort), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(reasoningSliderValue(older, 'ultra'), 'xhigh');
  const limited = { ...astra, supportedReasoningEfforts: astra.supportedReasoningEfforts.slice(0, 3) };
  assert.equal(reasoningSliderValue(limited, 'max'), 'medium');
  assert.deepEqual(reasoningSliderOptions(undefined), []);
});

test('Astra catalog selection, update and restarted Desktop overrides retain exact model and effort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-astra-'));
  try {
    const filePath = join(directory, 'settings.json');
    const codex = new CodexAppServer({ modelSettingsPath: filePath });
    codex.ensureStarted = async () => {};
    codex.sessionMetadata.set('astra-task', { path: '', cwd: process.cwd(), canAcceptDirectInput: true });
    const updates: Record<string, unknown>[] = [];
    codex.rpcRaw = async (method, params) => {
      if (method === 'model/list') return { data: [astra] } as any;
      if (method === 'config/read') return { config: { model: astra.model, model_reasoning_effort: 'medium' } } as any;
      if (method === 'thread/list') return { data: [{ id: 'astra-task', cwd: process.cwd() }] } as any;
      if (method === 'thread/settings/update') { updates.push(params!); return {} as any; }
      throw new Error(`unexpected method ${method}`);
    };
    const initial = await codex.readModelConfig('astra-task');
    assert.equal(initial.model, 'gpt-6-astra');
    assert.equal(initial.models.length, 1);
    for (const effort of ['max', 'ultra']) {
      const updated = await codex.updateModelConfig('astra-task', {
        model: astra.model, reasoningEffort: reasoningSliderValue(initial.models[0], effort), fastMode: true,
      });
      assert.equal(updated.reasoningEffort, effort);
      assert.deepEqual(updates.at(-1), {
        threadId: 'astra-task', model: 'gpt-6-astra', effort, serviceTier: 'priority',
      });
      const restarted = new CodexAppServer({ modelSettingsPath: filePath });
      assert.deepEqual(await restarted.getDesktopTurnOverrides('astra-task'), {
        model: 'gpt-6-astra', thinking: effort,
      });
    }
    await assert.rejects(codex.updateModelConfig('astra-task', {
      model: astra.model, reasoningEffort: 'none', fastMode: false,
    }), /reasoning_effort_not_available/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
