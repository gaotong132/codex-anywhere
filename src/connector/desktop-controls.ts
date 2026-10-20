import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopUserInput, classifyDesktopError } from './desktop-user-input.js';

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
  const turns: Value[] = [...(state.turns || []), ...Object.values(state.turnHistory?.history?.entitiesByKey || {})];
  const active = turns.filter(t => t?.status === 'inProgress' && typeof t.turnId === 'string')
    .sort((a, b) => (b.turnStartedAtMs || 0) - (a.turnStartedAtMs || 0))[0];
  const status = String(state.threadRuntimeStatus?.type || 'unknown');
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
    reasoningEffort: state.latestReasoningEffort || '',
    serviceTier: state.latestThreadSettings?.serviceTier ?? state.latestServiceTier ?? 'default' };
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

  async modelConfig(threadId: string, models: Value[]) {
    // Model settings are a small native response. A long thread's full state
    // can exceed the stream frame limit without making these settings invalid.
    // Selecting a cold conversation in Web must let Desktop load its settings.
    // Only Desktop resumes it; this does not submit a message or start a turn.
    const owner = await this.input.owner(threadId, true);
    let summary: ReturnType<typeof desktopSummary>;
    try {
      summary = desktopSummary(await this.input.state.read(threadId, owner.id, 5000), owner.id);
    } catch {
      if (typeof owner.settings.model !== 'string' || !owner.settings.model) throw new Error('desktop_model_unavailable');
      return { model: owner.settings.model, reasoningEffort: owner.settings.reasoningEffort || '',
        serviceTier: null, fastMode: false, readOnly: true, models };
    }
    const tier = models.find(m => m.model === summary.model)?.serviceTiers?.find((t: Value) => t.id === summary.serviceTier);
    return { model: summary.model, reasoningEffort: summary.reasoningEffort, serviceTier: summary.serviceTier,
      fastMode: /fast|priority/i.test(`${summary.serviceTier} ${tier?.name || ''}`), models };
  }
  async updateModel(threadId: string, value: Value, models: Value[]) {
    const model = models.find(m => m.model === value.model);
    if (!model) throw new Error('model_not_available');
    if (!model.supportedReasoningEfforts.some((r: Value) => r.reasoningEffort === value.reasoningEffort)) throw new Error('reasoning_effort_not_available');
    const tier = value.fastMode === true ? model.serviceTiers.find((t: Value) => /fast|priority/i.test(`${t.id} ${t.name}`))
      : model.serviceTiers.find((t: Value) => t.id === model.defaultServiceTier) || model.serviceTiers.find((t: Value) => /default|standard/i.test(`${t.id} ${t.name}`)) || { id: 'default' };
    if (!tier) throw new Error('fast_mode_not_available');
    const before = await this.snapshot(threadId, true);
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
    const after = await this.modelConfigFresh(threadId, models).catch(() => { throw new Error('desktop_settings_unconfirmed'); });
    if (after.model !== model.model || after.reasoningEffort !== value.reasoningEffort || after.serviceTier !== tier.id) throw new Error('desktop_settings_changed');
    return after;
  }
  private async modelConfigFresh(threadId: string, models: Value[]) { await this.snapshot(threadId, true); return this.modelConfig(threadId, models); }

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
    for (let i = 0; i < 12; i++) {
      const after = await this.snapshot(threadId, true, false).catch(() => { throw new Error('desktop_stop_unconfirmed'); });
      if (after.owner !== before.owner) throw new Error('desktop_stop_unconfirmed');
      const turns: Value[] = [...(after.state.turns || []), ...Object.values(after.state.turnHistory?.history?.entitiesByKey || {})];
      if (after.summary.turnId !== expectedTurnId && turns.some(turn => turn.turnId === expectedTurnId
        && ['interrupted', 'aborted', 'cancelled'].includes(turn.status))) return { stopped: true, turnId: expectedTurnId };
      if (turns.some(turn => turn.turnId === expectedTurnId && turn.status === 'completed')) throw new Error('desktop_turn_changed');
      await delay(200);
    }
    throw new Error('desktop_stop_unconfirmed');
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
    for (let i = 0; i < 12; i++) {
      const after = await this.snapshot(threadId, true, false).catch(() => { throw new Error('desktop_approval_unconfirmed'); });
      if (after.owner !== before.owner) throw new Error('desktop_approval_unconfirmed');
      if (!(after.state.requests || []).some((r: Value) => approvalId(after.owner, r) === id)) return { approvalId: id, approved, resolved: true };
      await delay(200);
    }
    throw new Error('desktop_approval_unconfirmed');
  }
}
