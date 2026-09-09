import type { TimelineItem } from './history-utils';

function milliseconds(value: number | string | null | undefined) {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  return Date.parse(String(value || ''));
}

export function startTimelineCompaction(items: TimelineItem[], turnId: string, startedAt: number | null) {
  if (!turnId || !startedAt) return items;
  const id = `compaction:${turnId}:${startedAt}`;
  if (items.some(item => item.id === id || (item.historyTurnId === turnId
    && item.compaction && milliseconds(item.completedAt) >= startedAt))) return items;
  return [...items, {
    id, kind: 'system' as const, text: '', historyTurnId: turnId, transient: true,
    compactionProgress: { startedAt, status: 'inProgress' as const },
  }];
}

export function finishTimelineCompaction(items: TimelineItem[], turnId: string, completedAt: number) {
  return items.map(item => item.historyTurnId === turnId && item.compactionProgress?.status === 'inProgress'
    ? { ...item, completedAt, compactionProgress: { ...item.compactionProgress, status: 'completed' as const } } : item);
}

export function clearPendingCompactions(items: TimelineItem[]) {
  return items.some(item => item.compactionProgress?.status === 'inProgress')
    ? items.filter(item => item.compactionProgress?.status !== 'inProgress') : items;
}

// Hydrate the live marker in place, retaining its React identity across polls.
// A later compaction in the same turn must not consume an earlier marker.
export function matchCompactionSnapshots(current: TimelineItem[], latest: TimelineItem[]) {
  const candidates = current.filter(item => item.compactionProgress)
    .sort((a, b) => a.compactionProgress!.startedAt - b.compactionProgress!.startedAt);
  const matched = new Set<string>();
  if (!candidates.length) return { latest, matched };
  return { matched, latest: latest.map(item => {
    if (!item.compaction) return item;
    const completedAt = milliseconds(item.completedAt);
    const candidate = candidates.find(previous => {
      if (matched.has(previous.id) || previous.historyTurnId !== item.historyTurnId) return false;
      if (previous.compaction) return previous.compaction.sequence === item.compaction!.sequence;
      const startedAt = previous.compactionProgress!.startedAt;
      const nextStart = candidates.find(next => next.historyTurnId === previous.historyTurnId
        && next.compactionProgress!.startedAt > startedAt)?.compactionProgress!.startedAt ?? Infinity;
      return completedAt >= startedAt && completedAt < nextStart;
    });
    if (!candidate) return item;
    matched.add(candidate.id);
    return { ...item, id: candidate.id,
      compactionProgress: { ...candidate.compactionProgress!, status: 'completed' as const } };
  }) };
}
