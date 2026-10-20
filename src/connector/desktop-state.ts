import { EventEmitter } from 'node:events';
import { DesktopInputPipe } from './desktop-input-pipe.js';

type ObjectValue = Record<string, any>;
type Entry = { owner: string; revision: number; state: ObjectValue | null; touched: number;
  pending?: Promise<ObjectValue>; retryAfter?: number };
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

// Immer's wire patches have array paths. Reject unsafe keys and broken sequences;
// never merge Desktop state into Connector configuration or forward raw snapshots.
export function applyDesktopPatches(state: ObjectValue, patches: unknown): ObjectValue {
  if (!Array.isArray(patches) || patches.length > 20_000) throw new Error('desktop_state_invalid_patch');
  const next = { ...state };
  const copied = new WeakSet<object>([next]);
  for (const patch of patches) {
    if (!Array.isArray(patch?.path) || !patch.path.length || !['add', 'remove', 'replace'].includes(patch.op)
      || patch.path.some((part: unknown) => (typeof part !== 'string' && typeof part !== 'number') || FORBIDDEN.has(String(part)))) throw new Error('desktop_state_invalid_patch');
    let parent: any = next;
    for (const part of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error('desktop_state_invalid_patch');
      const child = parent[part];
      if (!child || typeof child !== 'object') throw new Error('desktop_state_invalid_patch');
      if (!copied.has(child)) {
        parent[part] = Array.isArray(child) ? child.slice() : { ...child };
        copied.add(parent[part]);
      }
      parent = parent[part];
    }
    if (!parent || typeof parent !== 'object') throw new Error('desktop_state_invalid_patch');
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length || (patch.op !== 'add' && key === parent.length)) throw new Error('desktop_state_invalid_patch');
      if (patch.op === 'remove') parent.splice(key, 1);
      else if (patch.op === 'add') parent.splice(key, 0, patch.value);
      else parent[key] = patch.value;
    } else {
      if (patch.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('desktop_state_invalid_patch');
      if (patch.op === 'remove') delete parent[key]; else parent[key] = patch.value;
    }
  }
  return next;
}

export class DesktopState extends EventEmitter {
  private entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout;
  private closed = false;
  constructor(readonly pipe: DesktopInputPipe) {
    super();
    pipe.on('broadcast', message => this.receive(message));
    pipe.on('disconnected', () => {
      for (const [threadId, entry] of this.entries) { entry.state = null; entry.revision = -1; this.emit('invalidated', threadId); }
    });
    this.timer = setInterval(() => this.expire(), 15_000); this.timer.unref();
  }

  async read(threadId: string, owner: string, timeoutMs: number, fresh = false): Promise<ObjectValue> {
    if (this.closed) throw new Error('desktop_state_unavailable');
    let entry = this.entries.get(threadId);
    if (!entry || entry.owner !== owner) {
      if (entry) this.release(threadId);
      while (this.entries.size >= 4) this.release(this.entries.keys().next().value!);
      entry = { owner, revision: -1, state: null, touched: Date.now() }; this.entries.set(threadId, entry);
    }
    entry.touched = Date.now();
    if (entry.pending) return entry.pending;
    if ((entry.retryAfter || 0) > Date.now()) throw new Error('desktop_state_unavailable');
    if (entry.state && !fresh) return entry.state;
    const selected = entry;
    const reading = new Promise<ObjectValue>((resolve, reject) => {
      const done = (error?: Error, state?: ObjectValue) => {
        clearTimeout(timer); this.off('snapshot', received); this.off('invalidated', invalidated);
        error ? reject(error) : resolve(state!);
      };
      const received = (id: string) => { if (id === threadId && this.entries.get(id) === selected && selected.state) done(undefined, selected.state); };
      const invalidated = (id: string) => { if (id === threadId) done(new Error('desktop_state_unavailable')); };
      const timer = setTimeout(() => done(new Error('desktop_state_timeout')), timeoutMs); timer.unref();
      this.on('snapshot', received); this.on('invalidated', invalidated);
      void this.pipe.follow(threadId, owner, true, timeoutMs).catch(error => done(error));
    });
    selected.pending = reading.catch(error => {
      // Unreadable snapshots must not cause an immediate resubscribe loop from
      // model/approval polling. Small model settings remain independently usable.
      selected.retryAfter = Date.now() + 30_000;
      throw error;
    }).finally(() => { selected.pending = undefined; });
    return selected.pending;
  }

  private receive(message: ObjectValue) {
    const params = message.params;
    if (params?.hostId !== 'local' || typeof params.conversationId !== 'string') return;
    const id = params.conversationId, entry = this.entries.get(id);
    if (!entry || entry.owner !== message.sourceClientId) return;
    if (message.method === 'thread-stream-following-status-requested') {
      void this.pipe.follow(id, entry.owner, true, 1000).catch(() => {}); return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    const change = params.change;
    if (message.version !== 11 || !Number.isSafeInteger(change?.revision)) { this.invalidate(id, entry); return; }
    try {
      if (change.type === 'snapshot') {
        if (!change.conversationState || change.conversationState.id !== id || change.revision < entry.revision) throw new Error('invalid snapshot');
        entry.state = change.conversationState; entry.revision = change.revision;
        this.emit('snapshot', id);
      } else if (change.type === 'patches') {
        if (change.revision <= entry.revision) return;
        if (!entry.state || change.baseRevision !== entry.revision) throw new Error('revision gap');
        entry.state = applyDesktopPatches(entry.state, change.patches); entry.revision = change.revision;
        if (entry.state.id !== id) throw new Error('identity changed');
      } else throw new Error('invalid state change');
      this.emit('changed', id, entry.state, entry.owner);
    } catch { this.invalidate(id, entry); }
  }
  private invalidate(id: string, entry: Entry) {
    entry.state = null; entry.revision = -1; this.emit('invalidated', id);
    // The next read requests a fresh snapshot. Never guess/apply a missing revision.
  }
  private expire() { for (const [id, entry] of this.entries) if (Date.now() - entry.touched > 60_000) this.release(id); }
  private release(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); this.emit('invalidated', id);
    void this.pipe.follow(id, entry.owner, false, 1000).catch(() => {});
  }
  close() { this.closed = true; clearInterval(this.timer); for (const id of this.entries.keys()) this.release(id); }
}
