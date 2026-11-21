import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopMessageModels } from '../src/connector/desktop-message-models.js';
import { connectorDesktopMessageModelSettingsPath, saveSessionModelSettings } from '../src/connector/session-model-settings.js';

const fields = async () => ({ model: { type: 'string' }, thinking: { type: 'string', enum: ['low', 'high'] } });
const current = { model: 'native', reasoningEffort: 'high', source: 'persisted', readOnly: true,
  models: [{ model: 'astra', defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [
    { reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' },
  ] }] };
const draft = { model: 'astra', reasoningEffort: 'low', fastMode: false };

test('explicit message choices survive restart, are isolated from historical settings, and can follow Desktop again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-message-models-'));
  try {
    const legacyFile = join(directory, 'settings.json');
    const file = connectorDesktopMessageModelSettingsPath('pc', { BRIDGE_SESSION_MODEL_SETTINGS_FILE: legacyFile });
    assert.notEqual(file, legacyFile);
    saveSessionModelSettings(legacyFile, new Map([['one', { model: 'historical', reasoningEffort: 'high' }]]));
    let models = new DesktopMessageModels(fields, file);
    assert.equal(models.snapshot('one'), undefined, 'existing settings never opt a chat into overrides');
    const first = await models.read('one', current);
    assert.equal(first.model, 'native'); assert.equal(first.hasOverride, false); assert.equal(first.readOnly, false);
    assert.deepEqual(first.models[0].supportedReasoningEfforts.map(value => value.reasoningEffort), ['low', 'high']);
    assert.equal(first.models[0].defaultReasoningEffort, 'low');
    assert.equal(first.fastModeSupported, false);
    await models.update('one', draft, current);
    models = new DesktopMessageModels(fields, file);
    assert.deepEqual(models.snapshot('one'), { model: 'astra', thinking: 'low' });
    assert.equal(models.snapshot('two'), undefined);
    const snapshot = models.snapshot('one')!; snapshot.model = 'mutated';
    assert.equal((await models.read('one', current)).model, 'astra');
    const reset = await models.reset('one', { ...current, model: 'new-native' });
    assert.equal(reset.model, 'new-native'); assert.equal(reset.hasOverride, false);
    assert.equal(new DesktopMessageModels(fields, file).snapshot('one'), undefined);
    assert.match(await readFile(legacyFile, 'utf8'), /historical/);
  } finally { await rm(directory, { recursive: true }); }
});

test('unsupported model, effort, fast mode and invalid chat IDs cannot replace an explicit selection', async () => {
  const models = new DesktopMessageModels(fields);
  await models.update('one', draft, current);
  for (const [value, error] of [
    [{ ...draft, model: 'unknown' }, /model_not_available/],
    [{ ...draft, reasoningEffort: 'ultra' }, /reasoning_effort_not_available/],
    [{ ...draft, fastMode: true }, /desktop_fast_mode_unsupported/],
  ] as const) await assert.rejects(models.update('one', value, current), error);
  await assert.rejects(models.update('one\nother', draft, current), /thread_id_required/);
  assert.deepEqual(models.snapshot('one'), { model: 'astra', thinking: 'low' });
  const missingCatalog = await models.read('one', { ...current, models: [] });
  assert.equal(missingCatalog.readOnly, true); assert.equal(missingCatalog.model, 'astra');
});

test('an empty native chat remains unknown until an explicit supported model is saved', async () => {
  const models = new DesktopMessageModels(fields);
  const empty = { ...current, model: '', reasoningEffort: '' };
  const reading = await models.read('empty', empty);
  assert.equal(reading.model, ''); assert.equal(reading.readOnly, false); assert.equal(reading.hasOverride, false);
  assert.equal(models.snapshot('empty'), undefined);
  await models.update('empty', draft, empty);
  assert.equal((await models.read('empty', empty)).model, 'astra');
  assert.equal((await models.reset('empty', empty)).model, '');
  const fast = await models.read('one', { ...current, serviceTier: 'priority', fastMode: true });
  assert.equal(fast.lastSavedFastMode, true);
  assert.equal(fast.fastMode, false, 'saved speed is informational on a send tool without a service tier field');
});

test('failed persistence or changed tool contracts do not report a saved selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-message-model-error-'));
  try {
    const blocker = join(directory, 'not-a-directory'); await writeFile(blocker, 'fixture');
    const models = new DesktopMessageModels(fields, join(blocker, 'settings.json'));
    await assert.rejects(models.update('one', draft, current));
    assert.equal(models.snapshot('one'), undefined);
    const unavailable = new DesktopMessageModels(async () => { throw new Error('desktop_controls_unsupported'); });
    await assert.rejects(unavailable.update('one', draft, current), /desktop_controls_unsupported/);
    assert.equal(unavailable.snapshot('one'), undefined);
  } finally { await rm(directory, { recursive: true }); }
});
