import type { HistoryPage } from './app-types';
import type { BridgeRequest } from './bridge-request-manager';
import { attachLatestAssistantFileChanges, historyItems, mergeHistorySnapshot } from './history-utils';

export async function loadHistoryPage(
  request: BridgeRequest, threadId: string, cursor: string | null, limit: number,
) {
  const [page, live] = await Promise.all([
    request<HistoryPage>('session.turns.list', { threadId, cursor, limit, mode: 'conversation' }),
    cursor ? Promise.resolve(null) : request<HistoryPage>(
      'session.turns.list', { threadId, limit: 2, mode: 'live' }, { timeoutMs: 5_000 },
    ).catch(() => null),
  ]);
  const current = attachLatestAssistantFileChanges(historyItems(page.turns), page.turnProgress);
  const snapshot = live?.turns.length ? live : null;
  if (!snapshot) return { page, snapshot, items: current };
  const latest = attachLatestAssistantFileChanges(historyItems(snapshot.turns), snapshot.turnProgress);
  const turnIds = new Set(latest.map((item) => item.historyTurnId).filter((id): id is string => Boolean(id)));
  // A bounded live tail can omit the user's input or a final answer that the
  // summary already has. Retain those messages when adding process details.
  const missing = current.filter((item) => turnIds.has(item.historyTurnId || '')
    && (item.kind === 'user' || item.kind === 'assistant')
    && !latest.some((other) => other.historyTurnId === item.historyTurnId && other.kind === item.kind
      && other.text === item.text && other.attachment?.path === item.attachment?.path));
  const combined: typeof latest = [];
  for (let index = 0; index < latest.length; index++) {
    const item = latest[index];
    if (latest[index - 1]?.historyTurnId !== item.historyTurnId) {
      combined.push(...missing.filter((saved) => saved.historyTurnId === item.historyTurnId && saved.kind === 'user'));
    }
    combined.push(item);
    if (latest[index + 1]?.historyTurnId !== item.historyTurnId) {
      combined.push(...missing.filter((saved) => saved.historyTurnId === item.historyTurnId && saved.kind === 'assistant'));
    }
  }
  // Parallel reads can straddle completion. Do not turn an already completed
  // summary back into a running task just because the live read finished first.
  const newest = page.turns[0];
  const liveId = snapshot.activityId || snapshot.turns[0]?.id;
  const completed = newest?.id === liveId && /^(completed|failed)$/.test(newest.status || '')
    && snapshot.turns[0]?.status === 'inProgress';
  const summaryHasNewerTurn = newest?.id !== liveId && page.turns.some((turn) => turn.id === liveId);
  return {
    page, snapshot: summaryHasNewerTurn ? page
      : completed ? { ...snapshot, compactionStartedAt: null, turns: [{ ...snapshot.turns[0], status: newest.status }] } : snapshot,
    items: mergeHistorySnapshot(current, combined, turnIds),
  };
}
