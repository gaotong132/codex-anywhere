import {
  useEffect, useRef, useState, type CSSProperties,
} from 'react';
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
  const effortOptions = draftModel?.supportedReasoningEfforts || [];
  const effortIndex = Math.max(0, effortOptions
    .findIndex((option) => option.reasoningEffort === draft?.reasoningEffort));
  const effortProgress = effortOptions.length > 1 ? (effortIndex / (effortOptions.length - 1)) * 100 : 100;

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
        {config?.fastMode && (
          <span className="fast active" title={t('快速模式', 'Fast mode')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.2 1.8 4.7 10h4.8l-.8 8.2 6.6-9.6h-4.8l.7-6.8Z" /></svg>
          </span>
        )}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && draft && config && (
        <div className="model-config-popover">
          <div className="model-config-toolbar">
            <button
              className={`model-fast-button${draft.fastMode ? ' active' : ''}`}
              type="button"
              aria-pressed={draft.fastMode}
              aria-label={draft.fastMode ? t('关闭快速模式', 'Turn off fast mode') : t('开启快速模式', 'Turn on fast mode')}
              title={fastTierAvailable(draftModel)
                ? draft.fastMode ? t('关闭快速模式', 'Turn off fast mode') : t('开启快速模式', 'Turn on fast mode')
                : t('当前模型不支持快速模式', 'Fast mode is not available for this model')}
              disabled={saving || !fastTierAvailable(draftModel)}
              onClick={() => setDraft({ ...draft, fastMode: !draft.fastMode })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13.3 2.5-8 10h5.9l-1 9 8.5-12h-6.1l.7-7Z" /></svg>
            </button>
            <CustomSelect
              className="model-config-model-select"
              value={draft.model}
              disabled={saving}
              ariaLabel={t('选择模型', 'Select model')}
              triggerContent={(
                <>
                  <strong>{draftModel?.displayName || draft.model}</strong>
                  <em>{reasoningEffortLabel(draft.reasoningEffort)}</em>
                </>
              )}
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
          <label className="model-reasoning-slider">
            <span className="visually-hidden">{t('思考强度', 'Reasoning effort')}</span>
            <input
              type="range"
              min="0"
              max={Math.max(0, effortOptions.length - 1)}
              step="1"
              value={effortIndex}
              disabled={saving || effortOptions.length < 2}
              aria-label={t('思考强度', 'Reasoning effort')}
              aria-valuetext={reasoningEffortLabel(draft.reasoningEffort)}
              style={{ '--reasoning-progress': `${effortProgress}%` } as CSSProperties}
              onChange={(event) => {
                const nextEffort = effortOptions[Number(event.target.value)];
                if (nextEffort) setDraft({ ...draft, reasoningEffort: nextEffort.reasoningEffort });
              }}
            />
            <span className="model-reasoning-dots" aria-hidden="true">
              {effortOptions.map((option, index) => (
                <i
                  className={`${index <= effortIndex ? 'active' : ''}${index === effortIndex ? ' current' : ''}`}
                  key={option.reasoningEffort}
                />
              ))}
            </span>
          </label>
          <p className="model-config-hint">{disabled
            ? t('当前正在执行，可预选并在结束后保存', 'Preselect now and save after the task finishes')
            : t('保存后用于该会话的后续消息', 'Applies to subsequent messages in this task')}</p>
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
