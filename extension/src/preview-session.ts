import { BrowserControlError, MAX_BROWSER_REQUEST_MS, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { BrowserGrantStore, type BrowserGrant } from '../../src/browser-control/grants.js';
import { ReadonlyBrowserController, type BrowserSnapshotDriver } from '../../src/browser-control/readonly-controller.js';
import { boundedBrowserRead } from '../../src/browser-control/request-deadline.js';

const owner = Object.freeze({ environmentId: 'local-preview', threadId: 'local-preview', controllerId: 'extension-popup' });

// One explicit local popup grant. This is not an authenticated remote owner.
export class LocalPreviewSession {
  private readonly grants: BrowserGrantStore;
  private current: BrowserGrant | null = null;
  private pending: { abort: AbortController; tabId: number | null } | null = null;
  private sequence = 0;

  constructor(private readonly driver: {
    resolveActiveTarget(signal: AbortSignal, selectTab: (tabId: number) => void): Promise<BrowserTarget>;
    forTarget(target: BrowserTarget): BrowserSnapshotDriver;
  }, private readonly now = Date.now) {
    this.grants = new BrowserGrantStore({ createId: () => crypto.randomUUID(), maxGrants: 1, now });
  }

  stop(): void {
    this.pending?.abort.abort();
    this.pending = null;
    this.grants.close();
    this.current = null;
    this.sequence = 0;
  }

  invalidateTab(tabId: number): void {
    if (this.current?.target.tabId === tabId || this.pending?.tabId === tabId) this.stop();
  }

  status() {
    if (this.current && this.now() >= this.current.expiresAt) this.stop();
    return { origin: this.current?.target.origin ?? null, expiresAt: this.current?.expiresAt ?? null };
  }

  async grant() {
    this.stop();
    const pending = { abort: new AbortController(), tabId: null as number | null };
    this.pending = pending;
    try {
      const target = await boundedBrowserRead((signal) => this.driver.resolveActiveTarget(signal, (tabId) => {
        if (this.pending !== pending || signal.aborted) throw new BrowserControlError('browser_not_authorized');
        pending.tabId = tabId;
      }), pending.abort.signal, MAX_BROWSER_REQUEST_MS);
      if (this.pending !== pending || pending.abort.signal.aborted) throw new BrowserControlError('browser_not_authorized');
      this.current = this.grants.issue(owner, target);
      return this.status();
    } finally {
      if (this.pending === pending) this.pending = null;
      pending.abort.abort();
    }
  }

  async snapshot() {
    this.status();
    const grant = this.current;
    if (!grant) throw new BrowserControlError('browser_not_authorized');
    try {
      return await new ReadonlyBrowserController(owner, grant.target, this.grants, this.driver.forTarget(grant.target)).execute({
        version: 1, requestId: crypto.randomUUID(), grantId: grant.id, sequence: ++this.sequence,
        deadline: Math.min(this.now() + MAX_BROWSER_REQUEST_MS, grant.expiresAt), method: 'browser.snapshot', params: {},
      });
    } catch (error) {
      // A late failure from a replaced request must not revoke its successor.
      if (this.current === grant) this.stop();
      throw error;
    }
  }
}
