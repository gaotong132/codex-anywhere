import { useEffect, useRef, useState } from 'react';
import { friendlyError } from './app-utils';
import { t } from './i18n';
import { CustomSelect } from './ui-components';
import type { ModelConfigDraft, ModelOption, SessionModelConfig } from './app-types';

function reasoningEffortLabel(value: string) {
  const labels: Record<string, [string, string]> = {
    none: ['无', 'None'], minimal: ['极低', 'Minimal'], low: ['低', 'Low'], medium: ['中', 'Medium'],
    high: ['高', 'High'], xhigh: ['极高', 'X-high'], max: ['最高', 'Max'], ultra: ['超高', 'Ultra'],
  };
  return labels[value] ? t(...labels[value]) : value;
}

function fastTierAvailable(model: ModelOption | undefined) {
  return Boolean(model?.serviceTiers.some((tier) => /(?:fast|priority)/i.test(`${tier.id} ${tier.name}`)));
}

export function ModelConfigControl({
  config, loading, disabled, onSave,
}: {
  config: SessionModelConfig | null;
  loading: boolean;
  disabled: boolean;
  onSave: (draft: ModelConfigDraft) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ModelConfigDraft | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = config?.models.find((model) => model.model === config.model);
  const draftModel = config?.models.find((model) => model.model === draft?.model);

  useEffect(() => {
    setOpen(false);
    setError('');
    setDraft(config ? {
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastMode: config.fastMode,
    } : null);
  }, [config]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const save = async () => {
    if (!draft || saving || disabled) return;
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
      setOpen(false);
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const displayModel = selectedModel?.displayName || config?.model || t('自动选择', 'Automatic');
  return (
    <div className={`model-config${open ? ' open' : ''}`} ref={rootRef}>
      <button
        className="model-config-summary"
        type="button"
        disabled={!config || loading}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={disabled ? t('会话执行中，可预选并在结束后保存', 'Preselect now and save after the task finishes') : t('配置后续轮次', 'Configure subsequent turns')}
      >
        <span className="model-config-model">{loading ? t('读取模型…', 'Loading model…') : displayModel}</span>
        <span>{config?.reasoningEffort ? reasoningEffortLabel(config.reasoningEffort) : t('默认思考', 'Default reasoning')}</span>
        <span className={config?.fastMode ? 'fast active' : 'fast'}>{config?.fastMode ? t('快速', 'Fast') : t('标准', 'Standard')}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && draft && config && (
        <div className="model-config-popover">
          <header>
            <strong>{t('后续轮次配置', 'Next-turn settings')}</strong>
            <span>{disabled ? t('当前正在执行，可预选并在结束后保存', 'Preselect now and save after the task finishes') : t('保存后用于该会话的后续消息', 'Applies to subsequent messages in this task')}</span>
          </header>
          <div className="model-config-field">
            <span>{t('模型', 'Model')}</span>
            <CustomSelect
              value={draft.model}
              disabled={saving}
              ariaLabel={t('选择模型', 'Select model')}
              options={config.models.map((model) => ({
                value: model.model,
                label: model.displayName,
                description: model.description,
              }))}
              onChange={(value) => {
                const nextModel = config.models.find((model) => model.model === value);
                if (!nextModel) return;
                const effortSupported = nextModel.supportedReasoningEfforts
                  .some((option) => option.reasoningEffort === draft.reasoningEffort);
                setDraft({
                  model: nextModel.model,
                  reasoningEffort: effortSupported ? draft.reasoningEffort : nextModel.defaultReasoningEffort,
                  fastMode: draft.fastMode && fastTierAvailable(nextModel),
                });
              }}
            />
          </div>
          <div className="model-config-field">
            <span>{t('思考强度', 'Reasoning')}</span>
            <CustomSelect
              value={draft.reasoningEffort}
              disabled={saving}
              ariaLabel={t('选择思考强度', 'Select reasoning effort')}
              options={(draftModel?.supportedReasoningEfforts || []).map((option) => ({
                value: option.reasoningEffort,
                label: reasoningEffortLabel(option.reasoningEffort),
                description: option.description,
              }))}
              onChange={(value) => setDraft({ ...draft, reasoningEffort: value })}
            />
          </div>
          <label className={`model-fast-toggle${fastTierAvailable(draftModel) ? '' : ' unavailable'}`}>
            <span><strong>{t('快速模式', 'Fast mode')}</strong><small>{fastTierAvailable(draftModel)
              ? t('使用模型支持的低延迟服务层', 'Use the model’s low-latency service tier')
              : t('当前模型不支持', 'Not available for this model')}</small></span>
            <input
              type="checkbox"
              checked={draft.fastMode}
              disabled={saving || !fastTierAvailable(draftModel)}
              onChange={(event) => setDraft({ ...draft, fastMode: event.target.checked })}
            />
            <i aria-hidden="true" />
          </label>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="button" onClick={() => setOpen(false)}>{t('取消', 'Cancel')}</button>
            <button className="primary-action" type="button" disabled={disabled || saving} onClick={() => void save()}>
              {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
