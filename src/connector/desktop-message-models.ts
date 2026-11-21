import { loadSessionModelSettings, saveSessionModelSettings } from './session-model-settings.js';

type Value = Record<string, any>;
export type MessageModelFields = { model: Value; thinking: Value };

// These are explicit web choices for the public send tool. Keep them separate
// from historical app-server settings: reading a chat must never opt it in.
export class DesktopMessageModels {
  private settings;

  constructor(private fields: () => Promise<MessageModelFields>, private filePath?: string) {
    this.settings = loadSessionModelSettings(filePath);
  }

  snapshot(threadId: string) {
    const value = this.settings.get(threadId);
    return value ? { model: value.model!, thinking: value.reasoningEffort! } : undefined;
  }

  async read(threadId: string, current: Value) {
    const preference = this.snapshot(threadId);
    let fields: MessageModelFields;
    try { fields = await this.fields(); }
    catch (error) {
      if ((error as Error).message !== 'desktop_controls_unsupported') throw error;
      // Keep a previous choice visible and clearable if a future host removes
      // these fields. Never silently send with different settings.
      return { ...current, ...(preference ? { model: preference.model, reasoningEffort: preference.thinking,
        source: 'message', appliesOnSend: true } : {}), hasOverride: Boolean(preference),
        models: current.models || [], readOnly: true, fastModeSupported: false, unavailableReason: 'desktop_controls_unsupported' };
    }
    const models = (current.models || []).filter((model: Value) => accepts(fields.model, model.model))
      .map((model: Value) => {
        const efforts = (model.supportedReasoningEfforts || [])
          .filter((effort: Value) => accepts(fields.thinking, effort.reasoningEffort));
        return { ...model, supportedReasoningEfforts: efforts,
          defaultReasoningEffort: efforts.some((effort: Value) => effort.reasoningEffort === model.defaultReasoningEffort)
            ? model.defaultReasoningEffort : efforts[0]?.reasoningEffort || '' };
      }).filter((model: Value) => model.supportedReasoningEfforts.length);
    return { ...current, model: preference?.model || current.model,
      reasoningEffort: preference?.thinking || current.reasoningEffort,
      serviceTier: null, fastMode: false, fastModeSupported: false,
      source: 'message', appliesOnSend: true, hasOverride: Boolean(preference),
      readOnly: !models.length, unavailableReason: undefined, models };
  }

  async update(threadId: string, draft: Value, current: Value) {
    requireThread(threadId);
    const config = await this.read(threadId, current);
    if (config.unavailableReason) throw new Error(config.unavailableReason);
    const model = config.models.find((option: Value) => option.model === draft.model);
    if (!model) throw new Error('model_not_available');
    if (!model.supportedReasoningEfforts.some((effort: Value) => effort.reasoningEffort === draft.reasoningEffort)) {
      throw new Error('reasoning_effort_not_available');
    }
    if (draft.fastMode !== false) throw new Error('desktop_fast_mode_unsupported');
    const next = new Map(this.settings);
    next.delete(threadId);
    next.set(threadId, { model: draft.model, reasoningEffort: draft.reasoningEffort });
    saveSessionModelSettings(this.filePath, next);
    this.settings = next;
    return { ...config, model: draft.model, reasoningEffort: draft.reasoningEffort, hasOverride: true };
  }

  async reset(threadId: string, current: Value) {
    requireThread(threadId);
    let config: Value;
    try { config = await this.read(threadId, current); }
    catch { config = { ...current, readOnly: true }; }
    const next = new Map(this.settings);
    next.delete(threadId);
    saveSessionModelSettings(this.filePath, next);
    this.settings = next;
    return { ...config, model: current.model, reasoningEffort: current.reasoningEffort, hasOverride: false };
  }
}

export function accepts(field: Value, value: string) {
  return typeof value === 'string' && Boolean(value) && value.length <= 160
    && field.type === 'string' && (!Array.isArray(field.enum) || field.enum.includes(value));
}

function requireThread(threadId: string) {
  if (!threadId || threadId.length > 200 || threadId !== threadId.trim() || /[\u0000-\u001f\u007f]/.test(threadId)) {
    throw new Error('thread_id_required');
  }
}
