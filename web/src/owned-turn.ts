import type { OwnedTurn } from './app-types';
import type { ConversationExecutionPatch } from './conversation-execution';

// A history status describes activity, not who owns it. Only adopt the
// connector's snapshot for the selected task, and never overwrite newer events.
export function restoreOwnedTurn(
  active: OwnedTurn | null | undefined,
  selectedThreadId: string,
  ownedThreadId: string | null,
  snapshotVersion: number,
  currentVersion: number,
): ConversationExecutionPatch | null {
  if (snapshotVersion !== currentVersion) return null;
  if (active?.threadId === selectedThreadId && active.state === 'running' && active.turnId) {
    return { running: true, ownedTurnThreadId: selectedThreadId, state: 'running' };
  }
  if (active === null && ownedThreadId === selectedThreadId) {
    return { running: false, ownedTurnThreadId: null };
  }
  return null;
}
