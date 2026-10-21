import type { ExecutionState, PendingApprovals } from './app-types';

export function resolvedDesktopExecution(result: PendingApprovals): ExecutionState | null {
  if (result.desktopStatusUnavailable || !result.desktopState || result.desktopState.waitingOnApproval) return null;
  const status = result.desktopState.status;
  if (['idle', 'completed', 'notLoaded'].includes(status)) return 'completed';
  if (status === 'error' || status === 'failed') return 'failed';
  if (['active', 'running', 'inProgress'].includes(status)) return 'running';
  return null;
}

/** One request at a time; transient failures must not permanently stop synchronization. */
export function createApprovalPoller({ read, apply, onError, intervalMs = 4_000 }: {
  read: () => Promise<PendingApprovals>;
  apply: (result: PendingApprovals) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let receivingDesktopState = false;
  let pushRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  const refresh = () => {
    if (stopped) return Promise.resolve();
    clearTimeout(timer);
    if (pending) return pending;
    const revision = pushRevision;
    let nextDelay = intervalMs;
    pending = Promise.resolve().then(read).then((result) => {
      if (receivingDesktopState || (!result.approvals.length && !result.externalApproval && resolvedDesktopExecution(result) === 'completed')) {
        nextDelay = Math.max(intervalMs, 15_000);
      }
      if (!stopped && revision === pushRevision) apply(result);
    }).catch((error: unknown) => {
      if (!stopped && revision === pushRevision) onError(error);
    }).finally(() => {
      pending = null;
      if (!stopped) timer = setTimeout(() => { void refresh(); }, nextDelay);
    });
    return pending;
  };
  return { refresh, push: (result: PendingApprovals) => {
    if (stopped) return;
    pushRevision++;
    receivingDesktopState = Boolean(result.desktopState && result.desktopState.status !== 'unknown');
    apply(result);
  }, stop: () => { stopped = true; clearTimeout(timer); } };
}
