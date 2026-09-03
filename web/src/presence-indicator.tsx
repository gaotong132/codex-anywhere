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
  const usageTone = percent !== null && percent >= 92
    ? ' context-critical'
    : percent !== null && percent >= 80
      ? ' context-high'
      : '';
  return (
    <button
      type="button"
      className={`presence ${online ? 'online' : 'offline'} ${online ? executionState : ''}${usageTone}`}
      aria-live="polite"
      aria-label={label}
      title={label}
      data-context-percent={percent ?? undefined}
    >
      <svg className="presence-context-ring" viewBox="0 0 40 40" aria-hidden="true">
        <circle className="presence-context-track" cx="20" cy="20" r="18" pathLength="100" />
        {percent !== null && (
          <circle
            className="presence-context-value"
            cx="20"
            cy="20"
            r="18"
            pathLength="100"
            strokeDasharray={`${percent} ${100 - percent}`}
            transform="rotate(-90 20 20)"
          />
        )}
      </svg>
      <i aria-hidden="true" />
      {contextLabel && <span className="presence-context-popover" aria-hidden="true">{contextLabel}</span>}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}
