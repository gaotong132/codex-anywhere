import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopInputPipe } from '../src/connector/desktop-input-pipe.js';
import { DesktopUserInput, classifyDesktopError } from '../src/connector/desktop-user-input.js';
import { DesktopControls, desktopSummary } from '../src/connector/desktop-controls.js';
import { DesktopState, applyDesktopPatches } from '../src/connector/desktop-state.js';
import { NativeRequestError } from '../src/connector/desktop-native-pipe.js';
import { desktopPermissionConfig } from '../src/connector/desktop-permissions.js';

const models = [{ model: 'astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }],
  serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultServiceTier: null }];

test('text patches copy only changed branches and remain atomic on invalid paths', () => {
  const old = { history: { saved: [{ text: 'large unchanged history' }] }, turns: [{ items: ['a', 'b'] }] };
  const patches = [{ op: 'replace', path: ['turns', 0, 'items', 0], value: 'c' },
    { op: 'add', path: ['turns', 0, 'items', 1], value: 'd' },
    { op: 'remove', path: ['turns', 0, 'items', 2] }];
  const next = applyDesktopPatches(old, patches);
  assert.deepEqual(next.turns[0].items, ['c', 'd']);
  assert.deepEqual(old.turns[0].items, ['a', 'b']);
  assert.equal(next.history, old.history, 'history is not cloned for each streamed token');
  assert.throws(() => applyDesktopPatches(old, [...patches, { op: 'remove', path: ['missing', 'key'] }]));
  assert.deepEqual(old.turns[0].items, ['a', 'b']);
});
function initial(): Record<string, any> { return { id: 'fixture', latestModel: 'astra', latestReasoningEffort: 'high',
  latestThreadSettings: { model: 'astra', effort: 'high', serviceTier: 'default' }, requests: [], turns: [],
  threadRuntimeStatus: { type: 'idle' }, turnHistory: { history: { entitiesByKey: {} } } }; }
class FakePipe extends DesktopInputPipe {
  state = initial(); revision = 1; writes: any[] = []; owner = 'owner'; noEffect = false;
  async follow(id: string, owner: string, following: boolean) { if (following) this.emit('broadcast', {
    method: 'thread-stream-state-changed', version: 11, sourceClientId: owner,
    params: { conversationId: id, hostId: 'local', change: { type: 'snapshot', revision: this.revision++, conversationState: structuredClone(this.state) } },
  }); }
  async request(method: any, params: any, _timeout?: number, target?: string): Promise<any> {
    if (method === 'thread-owner-discovery') return { handledByClientId: this.owner };
    if (method === 'thread-follower-read-model-settings') return { result: { settings: { resumeState: 'resumed',
      model: this.state.latestModel, reasoningEffort: this.state.latestReasoningEffort } } };
    this.writes.push({ method, params, target });
    if (method === 'thread-follower-update-thread-settings') {
      if (this.noEffect) return { result: { applied: false } };
      Object.assign(this.state.latestThreadSettings, params.threadSettings);
      if (params.threadSettings.model) this.state.latestModel = params.threadSettings.model;
      if (params.threadSettings.effort) this.state.latestReasoningEffort = params.threadSettings.effort;
      if (params.threadSettings.sandboxPolicy) this.state.latestThreadSettings.activePermissionProfile = null;
      await this.follow(this.state.id, this.owner, true);
      return { result: { applied: true } };
    }
    if (method === 'thread-follower-interrupt-turn') {
      this.state.threadRuntimeStatus.type = 'idle';
      this.state.turnHistory.history.entitiesByKey['turn:' + params.expectedTurnId].status = 'interrupted';
      await this.follow(this.state.id, this.owner, true);
      return { result: { ok: true, interruptedTurnId: params.expectedTurnId } };
    }
    if (!this.noEffect) { this.state.requests = []; await this.follow(this.state.id, this.owner, true); }
    return { result: { ok: true } };
  }
}
function fixture(t: any) { const pipe = new FakePipe(), input = new DesktopUserInput(async () => assert.fail('must not open'), 1000, pipe, pipe);
  t.after(() => input.close()); return { pipe, input, controls: new DesktopControls(input) }; }

test('unreadable snapshots back off while concurrent reads share a single follow', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const pipe = new FakePipe(), state = new DesktopState(pipe);
  t.after(() => state.close());
  let calls = 0;
  pipe.follow = async () => { calls++; throw new Error('snapshot unavailable'); };
  await Promise.all([
    assert.rejects(state.read('fixture', 'owner', 100)),
    assert.rejects(state.read('fixture', 'owner', 100)),
  ]);
  assert.equal(calls, 1);
  await assert.rejects(state.read('fixture', 'owner', 100), /desktop_state_unavailable/);
  assert.equal(calls, 1);
  t.mock.timers.tick(30_001);
  await assert.rejects(state.read('fixture', 'owner', 100));
  assert.equal(calls, 2);
});

test('desktop permissions preserve other settings, require fresh identity, and enforce capability and active-turn gates', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.cwd = 'D:/project';
  Object.assign(pipe.state.latestThreadSettings, { approvalPolicy: 'never', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: { id: ':danger-full-access', extends: null } });
  const caps = { networkAccess: false, allowFullAccess: true };
  const original = await controls.permissions('fixture', caps);
  assert.equal(original.mode, 'full');
  const ask = await controls.updatePermissions('fixture', { mode: 'ask', settingsToken: original.settingsToken }, caps);
  assert.equal(ask.mode, 'ask');
  assert.equal(pipe.state.latestModel, 'astra');
  assert.equal(pipe.state.latestThreadSettings.serviceTier, 'default');
  assert.equal(pipe.state.latestThreadSettings.sandboxPolicy.networkAccess, false);
  pipe.state.latestThreadSettings.sandboxPolicy.writableRoots = ['D:/project', 'D:/native-visualizations'];
  assert.equal(desktopPermissionConfig(pipe.state, caps).settingsToken, ask.settingsToken,
    'Desktop workspace normalization does not change the Web permission selection');
  await assert.rejects(controls.updatePermissions('fixture', { mode: 'auto', settingsToken: original.settingsToken }, caps), /desktop_settings_changed/);
  await assert.rejects(controls.updatePermissions('fixture', { mode: 'full', settingsToken: ask.settingsToken }, { ...caps, allowFullAccess: false }), /full_access_not_allowed/);
  const auto = await controls.updatePermissions('fixture', { mode: 'auto', settingsToken: ask.settingsToken }, caps);
  assert.equal(auto.mode, 'auto');
  pipe.state.threadRuntimeStatus.type = 'active';
  await assert.rejects(controls.updatePermissions('fixture', { mode: 'full', settingsToken: auto.settingsToken }, caps), /permission_mode_turn_active/);
  assert.equal(pipe.writes.length, 2);
  pipe.state.latestThreadSettings.activePermissionProfile = { id: 'company-policy' };
  assert.equal(desktopPermissionConfig(pipe.state, caps).mode, 'custom');
  assert.throws(() => desktopPermissionConfig({}, caps), /desktop_permissions_unavailable/);
});

test('state waits use pushed updates, clean listeners and use at most one recovery snapshot', async t => {
  const pipe = new FakePipe(), state = new DesktopState(pipe);
  t.after(() => state.close());
  await state.read('fixture', 'owner', 100);
  let follows = 0;
  const follow = pipe.follow.bind(pipe);
  pipe.follow = async (...args) => { follows++; return follow(...args); };
  const waiting = state.waitFor('fixture', 'owner', s => s.latestModel === 'new', 50);
  pipe.state.latestModel = 'new';
  await follow('fixture', 'owner', true);
  assert.equal((await waiting).latestModel, 'new');
  assert.equal(follows, 0);
  pipe.state.latestModel = 'recovered';
  assert.equal((await state.waitFor('fixture', 'owner', s => s.latestModel === 'recovered', 1)).latestModel, 'recovered');
  assert.equal(follows, 1);
  await assert.rejects(state.waitFor('fixture', 'owner', () => false, 1), /desktop_state_unconfirmed/);
  assert.equal(follows, 2);
  assert.equal(state.listenerCount('changed'), 0);
  assert.equal(state.listenerCount('invalidated'), 0);
});

test('streamed item patches update cached text without repeatedly publishing operational summaries', async t => {
  const pipe = new FakePipe(), state = new DesktopState(pipe); t.after(() => state.close());
  pipe.state.turnHistory.history.entitiesByKey.t = { turnId: 't', status: 'inProgress', items: [{ text: 'a' }] };
  await state.read('fixture', 'owner', 100);
  let changes = 0; state.on('changed', () => changes++);
  const patch = (base: number, path: any[], value: any) => pipe.emit('broadcast', {
    method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
    params: { hostId: 'local', conversationId: 'fixture', change: { type: 'patches', baseRevision: base, revision: base + 1,
      patches: [{ op: 'replace', path, value }] } },
  });
  patch(1, ['turnHistory', 'history', 'entitiesByKey', 't', 'items', 0, 'text'], 'ab');
  assert.equal(changes, 0);
  assert.equal(state.peek('fixture', 'owner')!.turnHistory.history.entitiesByKey.t.items[0].text, 'ab');
  patch(2, ['turnHistory', 'history', 'entitiesByKey', 't', 'status'], 'completed');
  assert.equal(changes, 1);
});

test('native model/Fast update uses conditional owner settings and restores standard when catalog lists only Fast', async t => {
  const { pipe, controls } = fixture(t);
  const value = await controls.updateModel('fixture', { model: 'astra', reasoningEffort: 'low', fastMode: true }, models);
  assert.equal(value.fastMode, true); assert.equal(value.reasoningEffort, 'low');
  assert.deepEqual(pipe.writes[0].params.condition, { ifModelEquals: 'astra', ifEffortEquals: 'high' });
  assert.equal(pipe.writes[0].target, 'owner');
  const restored = await controls.updateModel('fixture', { model: 'astra', reasoningEffort: 'high', fastMode: false }, models);
  assert.equal(restored.serviceTier, 'default'); assert.equal(restored.fastMode, false);
});
test('model and effort remain readable when a long conversation snapshot is unavailable', async t => {
  const { pipe, controls } = fixture(t);
  controls.input.state.read = async () => { throw new Error('desktop_state_unavailable'); };
  const config = await controls.modelConfig('fixture', models);
  assert.equal(config.model, 'astra');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.serviceTier, null);
  assert.equal(config.readOnly, true);
  assert.equal(pipe.writes.length, 0);
  pipe.state.latestModel = '';
  await assert.rejects(controls.modelConfig('fixture', models), /desktop_model_unavailable/);
});

test('model header does not request a full snapshot and independent status unlocks full settings', async t => {
  const { pipe, controls } = fixture(t);
  let follows = 0;
  const follow = pipe.follow.bind(pipe);
  pipe.follow = async (...args) => { follows++; return follow(...args); };
  const first = await controls.modelConfig('fixture', models);
  assert.equal(first.model, 'astra'); assert.equal(first.readOnly, true);
  assert.equal(follows, 0, 'displaying the model cannot pull complete history');
  await controls.read('fixture');
  assert.equal((await controls.modelConfig('fixture', models)).readOnly, false);
  assert.equal(follows, 1);
  pipe.state.latestModel = 'other';
  const changed = await controls.modelConfig('fixture', models);
  assert.equal(changed.model, 'other'); assert.equal(changed.readOnly, true);
  assert.equal(changed.serviceTier, null, 'old snapshot settings cannot override the current owner');
});

test('a missing legacy effort can use an already available native effective setting without a new snapshot', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.latestReasoningEffort = null;
  await controls.read('fixture');
  controls.input.state.read = async () => assert.fail('header must not request a snapshot');
  assert.equal((await controls.modelConfig('fixture', models)).reasoningEffort, 'high');
  pipe.state.latestReasoningEffort = 'low';
  const changed = await controls.modelConfig('fixture', models);
  assert.equal(changed.reasoningEffort, 'low', 'explicit live setting wins over cached state');
  assert.equal(changed.readOnly, true);
});

test('model read never opens a cold Desktop thread', async t => {
  const pipe = new FakePipe();
  let opened = 0;
  const request = pipe.request.bind(pipe);
  pipe.request = async (...args: Parameters<FakePipe['request']>) => {
    if (args[0] === 'thread-owner-discovery' && !opened) {
      throw new NativeRequestError('no-client-found', true, 'desktop_host_error');
    }


    return request(...args);
  };
  const input = new DesktopUserInput(async id => {
    assert.equal(id, 'fixture');
    opened++;
  }, 1000, pipe, pipe);
  t.after(() => input.close());
  // Cold and oversized are independent conditions and may occur together.
  input.state.read = async () => { throw new Error('desktop_state_unavailable'); };
  const controls = new DesktopControls(input);
  await assert.rejects(controls.modelConfig('fixture', models), /desktop_input_not_ready/);
  assert.equal(opened, 0);
  assert.equal(pipe.writes.length, 0);
});

test('effective effort follows native collaboration and thread settings when the legacy field is empty', () => {
  const state = initial();
  state.latestReasoningEffort = null;
  state.latestThreadSettings.effort = 'high';
  assert.equal(desktopSummary(state, 'owner').reasoningEffort, 'high');
  state.latestCollaborationMode = { settings: { reasoning_effort: 'xhigh' } };
  assert.equal(desktopSummary(state, 'owner').reasoningEffort, 'xhigh');
});

test('native model changes fail on concurrent settings or an active turn', async t => {
  const { pipe, controls } = fixture(t); pipe.noEffect = true;
  await assert.rejects(controls.updateModel('fixture', { model: 'astra', reasoningEffort: 'low' }, models), /desktop_settings_changed/);
  pipe.state.threadRuntimeStatus.type = 'active';
  await assert.rejects(controls.updateModel('fixture', { model: 'astra', reasoningEffort: 'low' }, models), /model_config_turn_active/);
  assert.equal(pipe.writes.length, 1);
});
test('canonical active turn enables exact-turn stop; stale turn and active goal cannot be stopped', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.threadRuntimeStatus.type = 'active';
  pipe.state.turnHistory.history.entitiesByKey['turn:t1'] = { turnId: 't1', status: 'inProgress' };
  await assert.rejects(controls.stop('fixture', 'old'), /desktop_turn_changed/); assert.equal(pipe.writes.length, 0);
  pipe.state.threadGoal = { status: 'active' };
  await assert.rejects(controls.stop('fixture', 't1'), /desktop_turn_changed/);
  delete pipe.state.threadGoal;
  assert.deepEqual(await controls.stop('fixture', 't1'), { stopped: true, turnId: 't1' });
  assert.deepEqual(pipe.writes[0].params, { conversationId: 'fixture', mode: 'user-stop', expectedTurnId: 't1' });
});
for (const approved of [true, false]) test(`native approval ${approved} respects advertised one-time decisions`, async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.requests = [{ id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'pwd', availableDecisions: ['accept', 'cancel'] } }];
  const before = await controls.read('fixture');
  await controls.respond('fixture', before.approvals[0].approvalId, approved);
  assert.equal(pipe.writes[0].params.decision, approved ? 'accept' : 'cancel');
  await assert.rejects(controls.respond('fixture', before.approvals[0].approvalId, approved), /desktop_approval_expired/);
  assert.equal(pipe.writes.length, 1);
});
test('approval ids bind owner and immutable request contents; changed requests never receive an old decision', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.requests = [{ id: 42, method: 'item/fileChange/requestApproval', params: { file: 'a' } }];
  const id = (await controls.read('fixture')).approvals[0].approvalId;
  pipe.state.requests[0].params.file = 'b';
  await assert.rejects(controls.respond('fixture', id, true), /desktop_approval_expired/);
  pipe.state.requests[0].params.file = 'a'; pipe.owner = 'replacement';
  await assert.rejects(controls.respond('fixture', id, true), /desktop_approval_expired/);
  assert.equal(pipe.writes.length, 0);
});
test('permissions approval uses only original permission scope; oversized requests stay Desktop-only', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.requests = [{ id: 1, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } }];
  await controls.respond('fixture', (await controls.read('fixture')).approvals[0].approvalId, true);
  assert.deepEqual(pipe.writes[0].params.response, { permissions: { network: { enabled: true } }, scope: 'turn' });
  pipe.state.requests = [{ id: 2, method: 'item/fileChange/requestApproval', params: { patch: 'x'.repeat(25000) } }];
  const state = (await controls.snapshot('fixture', true)).summary;
  assert.equal(state.approvals[0].actionable, false);
  await assert.rejects(controls.respond('fixture', state.approvals[0].approvalId, true), /desktop_approval_unsupported/);
});
test('approval acknowledgement alone does not claim a still-pending request was resolved', async t => {
  const { pipe, controls } = fixture(t); pipe.noEffect = true;
  pipe.state.requests = [{ id: 1, method: 'item/fileChange/requestApproval', params: {} }];
  const id = (await controls.read('fixture')).approvals[0].approvalId;
  await assert.rejects(controls.respond('fixture', id, true), /desktop_approval_unconfirmed/);
  assert.equal(pipe.writes.length, 1);
});
test('state patches are immutable and reject prototype writes and broken paths', () => {
  const before = { values: ['a', 'b'], nested: { value: 1 } };
  assert.deepEqual(applyDesktopPatches(before, [{ op: 'remove', path: ['values', 0] }, { op: 'replace', path: ['nested', 'value'], value: 2 }]), { values: ['b'], nested: { value: 2 } });
  assert.equal(before.nested.value, 1);
  for (const path of [['__proto__', 'polluted'], ['nested', 'constructor'], ['missing', 'value']]) {
    assert.throws(() => applyDesktopPatches(before, [{ op: 'add', path, value: true }]), /desktop_state_invalid_patch/);
  }
});
test('stream validates owner and revision, invalidates gaps, and recovers through a fresh snapshot', async t => {
  const pipe = new FakePipe(), state = new DesktopState(pipe); t.after(() => state.close());
  let changes = 0; state.on('changed', () => changes++);
  await state.read('fixture', 'owner', 100);
  const patch = (owner: string, baseRevision: number, revision: number) => pipe.emit('broadcast', { method: 'thread-stream-state-changed', version: 11,
    sourceClientId: owner, params: { conversationId: 'fixture', hostId: 'local', change: { type: 'patches', baseRevision, revision,
      patches: [{ op: 'replace', path: ['latestModel'], value: 'new' }] } } });
  patch('other', 1, 2); assert.equal(changes, 1);
  patch('owner', 1, 2); assert.equal((await state.read('fixture', 'owner', 100)).latestModel, 'new');
  patch('owner', 4, 5); assert.equal((await state.read('fixture', 'owner', 100)).latestModel, 'astra');
  pipe.emit('disconnected'); assert.equal((await state.read('fixture', 'owner', 100)).id, 'fixture');
});
test('protocol rejection is definite but uncertain mutations must not be retried', () => {
  for (const reason of ['request-version-mismatch', 'no-handler-for-request']) {
    assert.equal(classifyDesktopError(new NativeRequestError(reason, true, 'desktop_host_error'), true).message, 'desktop_input_unsupported');
  }
  assert.equal(classifyDesktopError(new NativeRequestError('timeout', true), true).message, 'desktop_delivery_unknown');
  assert.equal(desktopSummary({ ...initial(), requests: [{ id: 1, method: 'unknown' }] }, 'owner').waitingOnApproval, true);
});

test('native editing uses the original owner operation once and keeps attachment input in the owner', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.turns = [{ turnId: 'original', params: { input: [{ type: 'text', text: 'old' }, { type: 'localImage', path: '/original.png' }] } }];
  const result = await controls.editMessage('fixture', 'original', 'edited');
  assert.equal(result.delivery, 'desktop');
  const writes = pipe.writes.filter(w => w.method === 'thread-follower-edit-last-user-turn');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, 'owner');
  assert.deepEqual(writes[0].params, { conversationId: 'fixture', turnId: 'original', message: 'edited', allowEarlierMessages: true, shouldSendPermissionOverrides: false });
});
test('native editing refuses active conversations before sending an edit', async t => {
  const { pipe, controls } = fixture(t);
  pipe.state.threadRuntimeStatus.type = 'active';
  await assert.rejects(controls.editMessage('fixture', 'original', 'edited'), /message_edit_busy/);
  assert.equal(pipe.writes.some(w => w.method === 'thread-follower-edit-last-user-turn'), false);
});
