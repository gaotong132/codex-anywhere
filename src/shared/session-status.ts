export type SessionProject =
  | { status: 'assigned'; id: string; name: string }
  | { status: 'unassigned' }
  | { status: 'unavailable' };

export type SessionStatusSnapshot = {
  revision: number;
  threads: { id: string; status: string; project?: SessionProject }[];
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

  apply<T extends { id: string; status?: string; project?: SessionProject }>(sessions: T[], ownedThreadId = '', now = Date.now()): T[] {
    const rows = new Map(this.snapshot && now - this.receivedAt <= SESSION_STATUS_MAX_AGE_MS
      ? this.snapshot.threads.map(row => [row.id, row]) : []);
    let changed = false;
    const next = sessions.map(session => {
      const desktop = rows.get(session.id);
      const status = session.id === ownedThreadId ? 'active' : desktop?.status;
      const project = desktop?.project ?? session.project;
      if ((!status || status === session.status) && JSON.stringify(project) === JSON.stringify(session.project)) return session;
      changed = true;
      return { ...session, ...(status ? { status } : {}), ...(project ? { project } : {}) };
    });
    return changed ? next : sessions;
  }
}
