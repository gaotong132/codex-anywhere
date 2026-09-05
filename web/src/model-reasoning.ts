import { t } from './i18n';
import type { ModelOption } from './app-types';

export function reasoningEffortLabel(value: string) {
  const labels: Record<string, [string, string]> = {
    none: ['无', 'None'], minimal: ['轻度', 'Light'], low: ['轻度', 'Light'], medium: ['中', 'Medium'],
    high: ['高', 'High'], xhigh: ['极高', 'X-high'], max: ['最大', 'Max'], ultra: ['超强', 'Ultra'],
  };
  return labels[value] ? t(...labels[value]) : value;
}

export function reasoningSliderOptions(model: ModelOption | undefined) {
  // The selected Connector's Codex catalog owns availability and ordering,
  // including Astra Max/Ultra and capabilities of older or future models.
  return model?.supportedReasoningEfforts || [];
}

export function reasoningSliderValue(model: ModelOption | undefined, value: string) {
  const options = reasoningSliderOptions(model);
  if (options.some((option) => option.reasoningEffort === value)) return value;
  if ((value === 'max' || value === 'ultra')
    && options.some((option) => option.reasoningEffort === 'xhigh')) return 'xhigh';
  if (options.some((option) => option.reasoningEffort === model?.defaultReasoningEffort)) {
    return model!.defaultReasoningEffort;
  }
  return options[0]?.reasoningEffort || value;
}
