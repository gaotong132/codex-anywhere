import { createHash } from 'node:crypto';
import { DesktopUserInput, classifyDesktopError } from './desktop-user-input.js';
import { measureOperation } from './operation-metrics.js';
import { desktopPermissionConfig, desktopPermissionSettings, type PermissionCapabilities } from './desktop-permissions.js';

type Value = Record<string, any>;
function mutationError(error: unknown) {
  const classified = classifyDesktopError(error, true);
  return classified.message === 'desktop_delivery_unknown' ? new Error('desktop_operation_unknown') : classified;
}
const approvalMethods = {
  'item/commandExecution/requestApproval': 'thread-follower-command-approval-decision',
  'item/fileChange/requestApproval': 'thread-follower-file-approval-decision',
  'item/permissions/requestApproval': 'thread-follower-permissions-request-approval-response',
} as const;

function approvalId(owner: string, request: Value) {
  return 'desktop:' + createHash('sha256').update(JSON.stringify([owner, request.id, request.method, request.params])).digest('hex');
}
export function desktopSummary(state: Value, owner: string) {
  const status = String(state.threadRuntimeStatus?.type || 'unknown');
  let active: Value | undefined;
  if (status === 'active') {
    for (const turn of conversationTurns(state)) {
      if (turn?.status === 'inProgress' && typeof turn.turnId === 'string'
        && (!active || (turn.turnStartedAtMs || 0) > (active.turnStartedAtMs || 0))) active = turn;
    }
  }
  const turnId = status === 'active' ? active?.turnId || null : null;
  const approvals = (Array.isArray(state.requests) ? state.requests : [])
    .filter((r: Value) => Object.hasOwn(approvalMethods, r.method) && r.id != null)
    .map((r: Value) => {
      const summary = JSON.stringify(r.params ?? {}, null, 2);
      const decisions = r.params?.availableDecisions;
      const supported = !Array.isArray(decisions) || decisions.includes('accept');
      return { approvalId: approvalId(owner, r), threadId: state.id, turnId: r.params?.turnId || turnId,
        kind: r.method, source: 'desktop', actionable: supported && summary.length <= 24_000,
        summary: summary.slice(0, 24_000) };
    });
  return { threadId: state.id, status, turnId, canStop: Boolean(turnId) && state.threadGoal?.status !== 'active',
    waitingOnApproval: (state.requests || []).length > 0, approvals,
    model: state.latestCollaborationMode?.settings?.model || state.latestModel || '',
    reasoningEffort: state.latestCollaborationMode?.settings?.reasoning_effort
      ?? state.latestThreadSettings?.collaborationMode?.settings?.reasoning_effort
      ?? state.latestThreadSettings?.effort ?? state.latestReasoningEffort ?? '',
    serviceTier: state.latestThreadSettings?.serviceTier ?? state.latestServiceTier ?? 'default' };
}

function* conversationTurns(state: Value): Generator<Value> {
  yield* state.turns || [];
  const entities = state.turnHistory?.history?.entitiesByKey || {};
  for (const key in entities) if (Object.hasOwn(entities, key)) yield entities[key];
}

export class DesktopControls {
  constructor(readonly input: DesktopUserInput) {}
  async snapshot(threadId: string, fresh = false, open = true) {
    try {
      const owner = await this.input.owner(threadId, open);
      const state = await this.input.state.read(threadId, owner.id, 5000, fresh);
      return { state, owner: owner.id, summary: desktopSummary(state, owner.id) };
    } catch (error) {
      if ((error as Error).message.startsWith('desktop_state_')) throw error;
      throw classifyDesktopError(error, false);
    }
  }
  async read(threadId: string, open = false) { return (await this.snapshot(threadId, false, open)).summary; }

  async permissions(threadId: string, capabilities: PermissionCapabilities) {
    return desktopPermissionConfig((await this.snapshot(threadId, false, false)).state, capabilities);
  }

  async updatePermissions(threadId: string, value: Value, capabilities: PermissionCapabilities) {
    const before = await this.snapshot(threadId, true, false);
    if (before.summary.status === 'active' || before.state.requests?.length || before.state.threadGoal?.status === 'active') {
      throw new Error('permission_mode_turn_active');
    }
    if (before.summary.status !== 'idle') throw new Error('desktop_permissions_unavailable');
    const config = desktopPermissionConfig(before.state, capabilities);
    if (!value.settingsToken || config.settingsToken !== value.settingsToken) throw new Error('desktop_settings_changed');
    const settings = desktopPermissionSettings(value.mode, before.state, capabilities);
    try {
      const reply = await this.input.pipe.request('thread-follower-update-thread-settings', {
        conversationId: threadId, threadSettings: settings,
      }, 15000, before.owner);
      if (reply.result?.applied !== true) throw new Error('desktop_settings_changed');
    } catch (error) {
      if ((error as Error).message === 'desktop_settings_changed') throw error;
      throw mutationError(error);
    }
    // Desktop normalizes writable roots after its optimistic settings patch.
    // Read its canonical configuration once so the returned conflict token does
    // not immediately become stale. Do not assert caller-supplied roots survived.
    const after = await this.input.state.read(threadId, before.owner, 5000, true)
      .catch(() => { throw new Error('desktop_settings_unconfirmed'); });
    const confirmed = desktopPermissionConfig(after, capabilities);
    const sandbox = after.latestThreadSettings.sandboxPolicy;
    if (confirmed.mode !== value.mode || (value.mode !== 'full' && sandbox.networkAccess !== capabilities.networkAccess)) {
      throw new Error('desktop_settings_unconfirmed');
    }
    return confirmed;
  }

  private editing = new Set<string>();
  async editMessage(threadId: string, turnId: string, message: string) {
    if (this.editing.has(threadId)) throw new Error('message_edit_busy');
    this.editing.add(threadId);
    try {
      let before = await this.snapshot(threadId, true, false);
      if (before.summary.status !== 'idle' || before.state.requests?.length || before.state.threadGoal?.status === 'active') {
        throw new Error('message_edit_busy');
      }
      if (![...conversationTurns(before.state)].some(turn => turn.turnId === turnId)) {
        await this.input.pipe.request('thread-follower-load-complete-history', { conversationId: threadId }, 30_000, before.owner);
        before = await this.snapshot(threadId, true, false);
      }
      const target = [...conversationTurns(before.state)].find(turn => turn.turnId === turnId);
      if (!target?.params?.input?.some((item: Value) => item.type === 'text')) throw new Error('message_edit_unavailable');
      try {
        const reply = await this.input.pipe.request('thread-follower-edit-last-user-turn', {
          conversationId: threadId, turnId, message, allowEarlierMessages: true,
          shouldSendPermissionOverrides: false,
        }, 30_000, before.owner);
        if (reply.result?.ok !== true) throw new Error('message_edit_unconfirmed');
      } catch { throw new Error('message_edit_unconfirmed'); }
      return { threadId, delivery: 'desktop' as const };
    } finally { this.editing.delete(threadId); }
  }

  async modelConfig(threadId: string, catalog: Value[] | Promise<Value[]>) {
    // Model settings are a small native response. A long thread's full state
    // can exceed the stream frame limit without making these settings invalid.
    // Reading a Web header must never navigate Desktop to a cold conversation.
    const [owner, models] = await Promise.all([
      measureOperation('model.owner', () => this.input.owner(threadId, false, 2000)), catalog,
    ]);
    if (typeof owner.settings.model !== 'string' || !owner.settings.model) throw new Error('desktop_model_unavailable');
    // Header reads must not subscribe to or wait for the complete conversation.
    // The existing approval/status poll supplies full settings independently.
    const state = this.input.state.peek(threadId, owner.id);
    const summary = state ? desktopSummary(state, owner.id) : null;
    const reasoningEffort = owner.settings.reasoningEffort
      ?? (summary && summary.model === owner.settings.model ? summary.reasoningEffort : '');
    const current = summary && summary.model === owner.settings.model
      && summary.reasoningEffort === reasoningEffort;
    const serviceTier = current ? summary!.serviceTier : null;
    const tier = models.find(m => m.model === owner.settings.model)?.serviceTiers?.find((t: Value) => t.id === serviceTier);
    return { model: owner.settings.model, reasoningEffort, serviceTier,
      fastMode: Boolean(serviceTier && /fast|priority/i.test(`${serviceTier} ${tier?.name || ''}`)),
      source: 'desktop' as const, readOnly: !current || !models.length, models };
  }
  async updateModel(threadId: string, value: Value, models: Value[]) {
    const model = models.find(m => m.model === value.model);
    if (!model) throw new Error('model_not_available');
    if (!model.supportedReasoningEfforts.some((r: Value) => r.reasoningEffort === value.reasoningEffort)) throw new Error('reasoning_effort_not_available');
    const tier = value.fastMode === true ? model.serviceTiers.find((t: Value) => /fast|priority/i.test(`${t.id} ${t.name}`))
      : model.serviceTiers.find((t: Value) => t.id === model.defaultServiceTier) || model.serviceTiers.find((t: Value) => /default|standard/i.test(`${t.id} ${t.name}`)) || { id: 'default' };
    if (!tier) throw new Error('fast_mode_not_available');
    const before = await this.snapshot(threadId, true, false);
    if (before.summary.status === 'active') throw new Error('model_config_turn_active');
    try {
      const result = await this.input.pipe.request('thread-follower-update-thread-settings', {
        conversationId: threadId, threadSettings: { model: model.model, effort: value.reasoningEffort, serviceTier: tier.id },
        condition: { ifModelEquals: before.state.latestModel, ifEffortEquals: before.state.latestReasoningEffort },
      }, 15000, before.owner);
      if (result.result?.applied !== true) throw new Error('desktop_settings_changed');
    } catch (error) {
      if ((error as Error).message === 'desktop_settings_changed') throw error;
      throw mutationError(error);
    }
    await this.input.state.waitFor(threadId, before.owner, state => {
      const summary = desktopSummary(state, before.owner);
      return summary.model === model.model && summary.reasoningEffort === value.reasoningEffort && summary.serviceTier === tier.id;
    }).catch(() => { throw new Error('desktop_settings_unconfirmed'); });
    const after = await this.modelConfig(threadId, models);
    if (after.model !== model.model || after.reasoningEffort !== value.reasoningEffort || after.serviceTier !== tier.id) throw new Error('desktop_settings_changed');
    return after;
  }

  async stop(threadId: string, expectedTurnId: unknown) {
    if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new Error('desktop_turn_id_required');
    const before = await this.snapshot(threadId, true, false);
    if (!before.summary.canStop || before.summary.turnId !== expectedTurnId) throw new Error('desktop_turn_changed');
    try {
      const reply = await this.input.pipe.request('thread-follower-interrupt-turn', {
        conversationId: threadId, mode: 'user-stop', expectedTurnId,
      }, 15000, before.owner);
      if (reply.result?.ok !== true || reply.result?.interruptedTurnId !== expectedTurnId) throw new Error('desktop_stop_unconfirmed');
    } catch (error) { if ((error as Error).message === 'desktop_stop_unconfirmed') throw error; throw mutationError(error); }
    const after = await this.input.state.waitFor(threadId, before.owner, state =>
      [...conversationTurns(state)].some(turn => turn.turnId === expectedTurnId
        && ['interrupted', 'aborted', 'cancelled', 'completed'].includes(turn.status))
    ).catch(() => { throw new Error('desktop_stop_unconfirmed'); });
    if ([...conversationTurns(after)].some(turn => turn.turnId === expectedTurnId && turn.status === 'completed')) throw new Error('desktop_turn_changed');
    return { stopped: true, turnId: expectedTurnId };
  }

  async respond(threadId: string, id: string, approved: boolean) {
    const before = await this.snapshot(threadId, true, false);
    const request = (before.state.requests || []).find((r: Value) => approvalId(before.owner, r) === id);
    if (!request || !Object.hasOwn(approvalMethods, request.method)) throw new Error('desktop_approval_expired');
    if (!before.summary.approvals.find((r: Value) => r.approvalId === id)?.actionable) throw new Error('desktop_approval_unsupported');
    const method = approvalMethods[request.method as keyof typeof approvalMethods];
    const params: Value = { conversationId: threadId, requestId: request.id };
    if (method === 'thread-follower-permissions-request-approval-response') {
      if (approved && (!request.params?.permissions || typeof request.params.permissions !== 'object')) throw new Error('desktop_approval_unsupported');
      params.response = { permissions: approved ? request.params.permissions : {}, scope: 'turn' };
    } else {
      const decisions = request.params?.availableDecisions;
      params.decision = approved ? 'accept' : Array.isArray(decisions) && decisions.includes('cancel') ? 'cancel' : 'decline';
      if (Array.isArray(decisions) && !decisions.includes(params.decision)) throw new Error('desktop_approval_unsupported');
    }
    try {
      const reply = await this.input.pipe.request(method, params, 15000, before.owner);
      if (reply.result?.ok !== true) throw new Error('desktop_approval_unconfirmed');
    } catch (error) { if ((error as Error).message === 'desktop_approval_unconfirmed') throw error; throw mutationError(error); }
    await this.input.state.waitFor(threadId, before.owner, state =>
      !(state.requests || []).some((r: Value) => approvalId(before.owner, r) === id)
    ).catch(() => { throw new Error('desktop_approval_unconfirmed'); });
    return { approvalId: id, approved, resolved: true };
  }
}
