export type SessionStatusSnapshot = {
  revision: number;
  threads: { id: string; status: string }[];
};

export const SESSION_STATUS_MAX_AGE_MS = 15_000;

// Scoped to one secure channel. A delayed list response must not undo a newer
// pushed status. Unchanged revisions do not extend the lifetime of cached data.
export class SessionStatusOverlay {
  private snapshot: SessionStatusSnapshot | null = null;
  private receivedAt = 0;

  accept(snapshot: SessionStatusSnapshot | null | undefined, now = Date.now()) {
    if (!snapshot || !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision <= (this.snapshot?.revision ?? -1) || !Array.isArray(snapshot.threads)) return false;
    this.snapshot = snapshot;
    this.receivedAt = now;
    return true;
  }

  apply<T extends { id: string; status?: string }>(sessions: T[], ownedThreadId = '', now = Date.now()): T[] {
    const statuses = new Map(this.snapshot && now - this.receivedAt <= SESSION_STATUS_MAX_AGE_MS
      ? this.snapshot.threads.map(row => [row.id, row.status]) : []);
    let changed = false;
    const next = sessions.map(session => {
      const status = session.id === ownedThreadId ? 'active' : statuses.get(session.id);
      if (!status || status === session.status) return session;
      changed = true;
      return { ...session, status };
    });
    return changed ? next : sessions;
  }
}
