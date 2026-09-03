import type { CSSProperties } from 'react';
import type { ContextUsage } from '../../src/shared/context-compaction';
import type { ExecutionState } from './app-types';
import { presenceLabel } from './app-utils';
import { t } from './i18n';

type PresenceIndicatorProps = {
  online: boolean;
  executionState: ExecutionState;
  statusText: string;
  contextUsage: ContextUsage | null;
};

const CONTEXT_RING_COLOR_STOPS = [
  { percent: 0, color: [99, 160, 255] },
  { percent: 65, color: [99, 160, 255] },
  { percent: 80, color: [224, 160, 94] },
  { percent: 92, color: [239, 102, 114] },
  { percent: 100, color: [239, 102, 114] },
] as const;

export function contextRingTone(percent: number) {
  const bounded = Math.min(100, Math.max(0, percent));
  const upperIndex = CONTEXT_RING_COLOR_STOPS.findIndex((stop) => stop.percent >= bounded);
  const upper = CONTEXT_RING_COLOR_STOPS[Math.max(0, upperIndex)];
  const lower = CONTEXT_RING_COLOR_STOPS[Math.max(0, upperIndex - 1)];
  const span = upper.percent - lower.percent;
  const progress = span ? (bounded - lower.percent) / span : 0;
  const color = lower.color.map((channel, index) => (
    Math.round(channel + (upper.color[index] - channel) * progress)
  ));
  const hex = `#${color.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  return { color: hex, glow: `rgba(${color.join(', ')}, .42)` };
}

export function contextUsagePresentation(usage: ContextUsage | null) {
  const percent = usage?.tokens !== undefined && usage.contextWindow
    ? Math.min(100, Math.max(0, Math.round(usage.tokens / usage.contextWindow * 100)))
    : null;
  const detail = usage?.tokens !== undefined && usage.contextWindow
    ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} Token`
    : usage?.tokens !== undefined
      ? `${usage.tokens.toLocaleString()} Token`
      : '';
  return { percent, detail };
}

export function PresenceIndicator({
  online,
  executionState,
  statusText,
  contextUsage,
}: PresenceIndicatorProps) {
  const stateLabel = presenceLabel(online, executionState, statusText);
  const { percent, detail } = contextUsagePresentation(contextUsage);
  const contextLabel = detail
    ? t(`上下文 ${percent === null ? '' : `${percent}% · `}${detail}`, `Context ${percent === null ? '' : `${percent}% · `}${detail}`)
    : '';
  const label = [stateLabel, contextLabel].filter(Boolean).join(' · ');
  const ringTone = percent === null ? null : contextRingTone(percent);
  const ringStyle = ringTone ? {
    '--context-ring-color': ringTone.color,
    '--context-ring-glow': ringTone.glow,
  } as CSSProperties : undefined;
  return (
    <button
      type="button"
      className={`presence ${online ? 'online' : 'offline'} ${online ? executionState : ''}`}
      style={ringStyle}
      aria-live="polite"
      aria-label={label}
      title={label}
      data-context-percent={percent ?? undefined}
    >
      <svg className="presence-context-ring" viewBox="0 0 30 30" aria-hidden="true">
        <circle className="presence-context-track" cx="15" cy="15" r="12.5" pathLength="100" />
        {percent !== null && (
          <circle
            className="presence-context-value"
            cx="15"
            cy="15"
            r="12.5"
            pathLength="100"
            strokeDasharray={`${percent} ${100 - percent}`}
            transform="rotate(-90 15 15)"
          />
        )}
      </svg>
      <i aria-hidden="true" />
      {contextLabel && <span className="presence-context-popover" aria-hidden="true">{contextLabel}</span>}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}
