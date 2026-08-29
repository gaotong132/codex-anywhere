import { historyItems, type Turn } from './history-utils';
import { normalizeTurnProgress, type TurnProgress } from '../../src/shared/turn-progress';

export type AwaySummary = {
  status: 'running' | 'completed' | 'failed';
  newReplies: number;
  artifacts: number;
  durationMs?: number;
  progress: TurnProgress;
};

function epochMillis(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildAwaySummary(
  turns: Turn[],
  rawProgress: unknown,
  lastVisitedAt = 0,
): AwaySummary | null {
  const latest = turns[0];
  if (!latest) return null;
  const items = historyItems(turns);
  const newestAt = Math.max(
    epochMillis(latest.completedAt),
    epochMillis(latest.startedAt),
    ...items.map((item) => epochMillis(item.completedAt)),
  );
  if (lastVisitedAt && newestAt && newestAt <= lastVisitedAt) return null;

  const freshItems = items.filter((item) => {
    const completedAt = epochMillis(item.completedAt);
    return !lastVisitedAt || !completedAt || completedAt > lastVisitedAt;
  });
  const newReplies = freshItems.filter((item) => item.kind === 'assistant' && item.text.trim()).length;
  const artifacts = freshItems.filter((item) => item.attachment || item.visualization).length;
  const startedAt = epochMillis(latest.startedAt);
  const completedAt = epochMillis(latest.completedAt);
  const durationMs = startedAt && completedAt && completedAt >= startedAt
    ? completedAt - startedAt : undefined;
  const status = latest.status === 'inProgress'
    ? 'running'
    : latest.status === 'failed'
      ? 'failed'
      : 'completed';
  return {
    status,
    newReplies,
    artifacts,
    ...(durationMs !== undefined ? { durationMs } : {}),
    progress: normalizeTurnProgress(rawProgress),
  };
}

export function formatAwayDuration(durationMs?: number) {
  if (!durationMs || durationMs < 1_000) return '';
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
