import {
  BrowserControlError, MAX_BROWSER_GRANT_MS, MAX_BROWSER_REQUEST_MS,
  parseBrowserOwner, parseBrowserReadRequest, parseBrowserTarget, requireBrowserId, requireInteger,
  type BrowserOwner, type BrowserTarget, type BrowserReadRequest,
} from './contracts.js';

export type BrowserGrant = Readonly<{
  id: string;
  owner: BrowserOwner;
  target: BrowserTarget;
  expiresAt: number;
}>;
type GrantState = { grant: BrowserGrant; lastSequence: number; abort: AbortController };

// Kept at the enforcing endpoint. Recreating this store (e.g. extension worker restart)
// invalidates all grants; approval is never silently restored from disk.
export class BrowserGrantStore {
  private readonly entries = new Map<string, GrantState>();

  constructor(private readonly options: {
    now?: () => number;
    createId: () => string;
    maxGrants?: number;
  }) {
    requireInteger(options.maxGrants ?? 8, 1, 64);
  }

  private now() { return (this.options.now ?? Date.now)(); }

  // Call only after a trusted local user approval. This is deliberately not an RPC method.
  issue(owner: BrowserOwner, target: BrowserTarget, ttlMs = MAX_BROWSER_GRANT_MS): BrowserGrant {
    this.expire();
    const checkedOwner = parseBrowserOwner(owner);
    const checkedTarget = parseBrowserTarget(target);
    requireInteger(ttlMs, 1, MAX_BROWSER_GRANT_MS);
    for (const { grant } of this.entries.values()) {
      if (grant.target.browserDeviceId === checkedTarget.browserDeviceId && grant.target.tabId === checkedTarget.tabId) {
        throw new BrowserControlError('browser_tab_already_granted');
      }
    }
    if (this.entries.size >= (this.options.maxGrants ?? 8)) throw new BrowserControlError('browser_grant_limit');
    const id = requireBrowserId(this.options.createId());
    if (this.entries.has(id)) throw new BrowserControlError('browser_duplicate_grant');
    const grant = Object.freeze({ id, owner: checkedOwner, target: checkedTarget, expiresAt: this.now() + ttlMs });
    this.entries.set(id, { grant, lastSequence: 0, abort: new AbortController() });
    return grant;
  }

  authorize(owner: BrowserOwner, currentTarget: BrowserTarget, value: unknown): {
    request: BrowserReadRequest; grant: BrowserGrant; signal: AbortSignal; timeoutMs: number; revalidate: () => void;
  } {
    this.expire();
    const checkedOwner = parseBrowserOwner(owner);
    const target = parseBrowserTarget(currentTarget);
    const request = parseBrowserReadRequest(value);
    const state = this.entries.get(request.grantId);
    if (!state || !sameOwner(checkedOwner, state.grant.owner) || !sameTarget(target, state.grant.target)) {
      throw new BrowserControlError('browser_not_authorized');
    }
    const now = this.now();
    if (request.deadline <= now || request.deadline > now + MAX_BROWSER_REQUEST_MS
      || request.deadline > state.grant.expiresAt) throw new BrowserControlError('browser_request_expired');
    if (request.sequence !== state.lastSequence + 1) throw new BrowserControlError('browser_request_out_of_order');
    state.lastSequence = request.sequence;
    return {
      request, grant: state.grant, signal: state.abort.signal, timeoutMs: request.deadline - now,
      revalidate: () => {
        this.expire();
        if (this.entries.get(request.grantId) !== state || state.abort.signal.aborted) {
          throw new BrowserControlError('browser_not_authorized');
        }
        if (this.now() >= request.deadline) throw new BrowserControlError('browser_request_expired');
      },
    };
  }

  revoke(grantId: string): void {
    const state = this.entries.get(grantId);
    if (!state) return;
    this.entries.delete(grantId);
    state.abort.abort();
  }

  revokeTab(browserDeviceId: string, tabId: number): void {
    for (const { grant } of this.entries.values()) {
      if (grant.target.browserDeviceId === browserDeviceId && grant.target.tabId === tabId) this.revoke(grant.id);
    }
  }

  revokeOwner(owner: BrowserOwner): void {
    for (const { grant } of this.entries.values()) if (sameOwner(grant.owner, owner)) this.revoke(grant.id);
  }

  close(): void { for (const id of this.entries.keys()) this.revoke(id); }

  private expire(): void {
    const now = this.now();
    for (const { grant } of this.entries.values()) if (grant.expiresAt <= now) this.revoke(grant.id);
  }
}

function sameOwner(a: BrowserOwner, b: BrowserOwner) {
  return a.environmentId === b.environmentId && a.threadId === b.threadId && a.controllerId === b.controllerId;
}

function sameTarget(a: BrowserTarget, b: BrowserTarget) {
  return a.browserDeviceId === b.browserDeviceId && a.tabId === b.tabId
    && a.documentId === b.documentId && a.origin === b.origin;
}
