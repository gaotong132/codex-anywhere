import type { Binding } from './page-binding.js';
import { canRetireTab, RECENT_CHILD_TABS } from './tab-lifecycle.js';
import { withinDeadline } from './deadline.js';

type Host = {
  bindings: ReadonlyMap<number, Binding>;
  busy: ReadonlySet<Binding>;
  connected(): boolean;
  generation(): number;
  persist(): Promise<void>;
  revoke(binding: Binding): Promise<void>;
};

function sameTree(a: Binding, b: Binding) {
  return a.environmentId === b.environmentId && a.threadId === b.threadId
    && (a.rootTabId ?? a.target.tabId) === (b.rootTabId ?? b.target.tabId);
}

// Only manages children already present in the grant store. Lifecycle cleanup
// never discovers ambient tabs, changes consent, or retries the source action.
export class ManagedTabLifecycle {
  readonly retiring = new Set<Binding>();
  private pruning = false;
  private pruneAgain = false;
  constructor(private host: Host) {}

  async reuse(url: string, parent: Binding, current: () => boolean, deadline: number) {
    const bounded = <T>(work: Promise<T>) => withinDeadline(work, deadline, 'browser_operation_timeout');
    for (const candidate of [...this.host.bindings.values()].reverse()) {
      if (Date.now() >= deadline) throw new Error('browser_operation_timeout');
      if (candidate.rootTabId === undefined || !sameTree(candidate, parent)
        || this.retiring.has(candidate) || (candidate !== parent && this.host.busy.has(candidate))) continue;
      try {
        const tab = await bounded(chrome.tabs.get(candidate.target.tabId));
        const parentTab = await bounded(chrome.tabs.get(parent.target.tabId));
        if (tab.url !== url || tab.pendingUrl || tab.windowId !== parentTab.windowId
          || !await bounded(canRetireTab(candidate.target, candidate.grantId))) continue;
        const latest = await bounded(chrome.tabs.get(candidate.target.tabId));
        if (latest.url !== url || latest.pendingUrl || latest.windowId !== parentTab.windowId) continue;
        if (!current()) throw new Error('browser_authorization_changed');
        if (Date.now() >= deadline) throw new Error('browser_operation_timeout');
        if (this.host.bindings.get(candidate.target.tabId) !== candidate || this.retiring.has(candidate)
          || (candidate !== parent && this.host.busy.has(candidate))) continue;
        await chrome.tabs.update(candidate.target.tabId, { active: true });
        if (!current() || this.host.bindings.get(candidate.target.tabId) !== candidate) throw new Error('browser_authorization_changed');
        candidate.lastUsedAt = Date.now();
        void this.host.persist().catch(() => {});
        return { opened: true, reused: true, pageId: candidate.grantId, origin: candidate.target.origin };
      } catch (failure) {
        if (!current() || Date.now() >= deadline || (failure instanceof Error && failure.message === 'browser_operation_timeout')) throw failure;
      }
    }
    return null;
  }

  async prune() {
    if (this.pruning) { this.pruneAgain = true; return; }
    if (!this.host.connected()) return;
    this.pruning = true;
    const expectedRevision = this.host.generation();
    try {
      const root = [...this.host.bindings.values()].find((binding) => binding.rootTabId === undefined);
      if (!root) return;
      const children = [...this.host.bindings.values()].filter((binding) => binding.rootTabId !== undefined && sameTree(binding, root));
      if (children.length <= RECENT_CHILD_TABS) return;
      const rootTab = await chrome.tabs.get(root.target.tabId);
      const ordinary: { binding: Binding; usedAt: number; sequence: number }[] = [];
      for (const child of children) {
        if (this.host.generation() !== expectedRevision || !this.host.connected()) return;
        try {
          const tab = await chrome.tabs.get(child.target.tabId);
          if (tab.windowId === rootTab.windowId && !tab.pendingUrl && !tab.pinned && !tab.audible && await canRetireTab(child.target, child.grantId)) {
            ordinary.push({ binding: child, usedAt: child.lastUsedAt || 0, sequence: child.sequence });
          }
        } catch { /* A closed or replaced tab is handled by its lifecycle event. */ }
      }
      ordinary.sort((a, b) => b.usedAt - a.usedAt);
      for (const candidate of ordinary.slice(RECENT_CHILD_TABS)) {
        const old = candidate.binding;
        if (this.host.generation() !== expectedRevision || !this.host.connected()) return;
        if (this.host.bindings.get(old.target.tabId) !== old || this.host.busy.has(old)) continue;
        this.retiring.add(old);
        try {
          if (!await canRetireTab(old.target, old.grantId)) continue;
          const tab = await chrome.tabs.get(old.target.tabId);
          if (tab.active || tab.pendingUrl || tab.pinned || tab.audible || tab.windowId !== rootTab.windowId
            || this.host.busy.has(old) || old.sequence !== candidate.sequence || (old.lastUsedAt || 0) !== candidate.usedAt || this.host.generation() !== expectedRevision
            || this.host.bindings.get(old.target.tabId) !== old) continue;
          await chrome.tabs.remove(old.target.tabId);
          await this.host.revoke(old);
        } catch { /* Failed cleanup must never fail or replay a browser operation. */ }
        finally { this.retiring.delete(old); }
      }
    } finally {
      this.pruning = false;
      if (this.pruneAgain) { this.pruneAgain = false; void this.prune().catch(() => {}); }
    }
  }
}
