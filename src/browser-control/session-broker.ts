import { randomUUID } from 'node:crypto';
import { parseBrowserTarget, requireBrowserId, type BrowserTarget } from './contracts.js';
import { parseOperation, type BrowserOperation } from './operations.js';
import { browserContext } from '../shared/browser-context.js';

type Client = { clientId: string; clientDeviceId: string };
type BindOptions = { replaceExisting?: boolean; recoverOnly?: boolean };
type Grant = Client & { id: string; threadId: string; target: BrowserTarget; seenAt: number; sequence: number; active: boolean; lastToolSuccessAt?: number; rootGrantId?: string };
type Pending = { grant: Grant; operation: BrowserOperation; adopted?: boolean; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

// Consent has no TTL. Heartbeats describe transport liveness, not consent duration.
export class BrowserSessionBroker {
  private grants = new Map<string, Grant>();
  private pending = new Map<string, Pending>();
  private bindingIntents = new Map<string, object>();
  private contextualized = new Set<string>();
  constructor(readonly environmentId: string, private send: (frame: Record<string, unknown>) => boolean,
    private now = Date.now, private timeoutMs = 15_000) {}

  async validateAndBind(client: Client, threadId: unknown, targetValue: unknown, validate: (threadId: string) => Promise<unknown>, options: BindOptions = {}) {
    const target = parseBrowserTarget(targetValue);
    const id = requireBrowserId(threadId);
    if (target.browserDeviceId !== client.clientDeviceId) throw new Error('browser_device_mismatch');
    // Both a tab and a Session can be replaced while Session validation awaits.
    // A delayed click must not reclaim either from a newer authorization.
    const keys = [`tab:${client.clientDeviceId}:${target.tabId}`, `session:${id}`];
    if (this.bindingIntents.size + keys.filter((key) => !this.bindingIntents.has(key)).length > 128) throw new Error('browser_grant_limit');
    const intent = {};
    for (const key of keys) this.bindingIntents.set(key, intent);
    try {
      await validate(id);
      if (keys.some((key) => this.bindingIntents.get(key) !== intent)) throw new Error('browser_authorization_changed');
      return this.bind(client, id, target, options);
    } finally { for (const key of keys) if (this.bindingIntents.get(key) === intent) this.bindingIntents.delete(key); }
  }

  bind(client: Client, threadId: unknown, targetValue: unknown, options: BindOptions = {}) {
    const target = parseBrowserTarget(targetValue);
    if (target.browserDeviceId !== client.clientDeviceId) throw new Error('browser_device_mismatch');
    const id = requireBrowserId(threadId);
    const sessionGrants = this.forSession(id);
    const root = sessionGrants.find((grant) => !grant.rootGrantId);
    const existing = [...this.grants.values()].find((grant) => grant.clientDeviceId === client.clientDeviceId && grant.target.tabId === target.tabId);
    if (options.recoverOnly === true && (root || existing)) throw new Error('browser_restore_unavailable');
    // Manual consent may replace this device's orphaned grant. A different
    // browser must have missed the full heartbeat window, including all children
    // and newly bound (not yet active) pages. Offline alone never expires consent.
    const replaceRoot = root && options.replaceExisting === true && (root.clientDeviceId === client.clientDeviceId
      || sessionGrants.every((grant) => this.now() - grant.seenAt >= 45_000));
    if (root && !replaceRoot && (root.clientDeviceId !== client.clientDeviceId || root.target.tabId !== target.tabId)) throw new Error('browser_session_already_bound');
    if (this.grants.size >= 64 && !existing && !replaceRoot) throw new Error('browser_grant_limit');
    if (replaceRoot) this.remove(root);
    for (const grant of this.grants.values()) {
      if (grant.clientDeviceId === client.clientDeviceId && grant.target.tabId === target.tabId) this.remove(grant);
    }
    const grant: Grant = { ...client, id: randomUUID(), threadId: id, target, seenAt: this.now(), sequence: 0, active: false };
    this.grants.set(grant.id, grant);
    return { grantId: grant.id, environmentId: this.environmentId, threadId: id, target };
  }

  // Only the authenticated extension can attest to a tab it just created for a
  // live model operation. Model arguments cannot provide this authority.
  adopt(client: Client, requestId: unknown, parentGrantId: unknown, targetValue: unknown) {
    const parent = this.owned(client, parentGrantId);
    const pending = this.pending.get(String(requestId));
    if (!pending || pending.grant !== parent || pending.adopted || !['open_link', 'click'].includes(pending.operation.method)) throw new Error('browser_child_operation_required');
    const target = parseBrowserTarget(targetValue);
    if (target.browserDeviceId !== client.clientDeviceId || target.origin !== parent.target.origin) throw new Error('browser_child_origin_denied');
    if ([...this.grants.values()].some((grant) => grant.clientDeviceId === client.clientDeviceId && grant.target.tabId === target.tabId)) throw new Error('browser_child_must_be_new_tab');
    if (this.grants.size >= 64) throw new Error('browser_grant_limit');
    const grant: Grant = { ...client, id: randomUUID(), threadId: parent.threadId, target, seenAt: this.now(), sequence: 0, active: false,
      rootGrantId: parent.rootGrantId ?? parent.id };
    pending.adopted = true; this.grants.set(grant.id, grant);
    return { grantId: grant.id, environmentId: this.environmentId, threadId: grant.threadId, target };
  }

  restore(client: Client, grantId: unknown, targetValue: unknown) {
    const old = this.grants.get(String(grantId));
    const target = parseBrowserTarget(targetValue);
    if (!old || old.clientDeviceId !== client.clientDeviceId || JSON.stringify(old.target) !== JSON.stringify(target)) throw new Error('browser_restore_unavailable');
    const grant: Grant = { ...old, ...client, id: randomUUID(), sequence: 0, active: false, seenAt: this.now(), lastToolSuccessAt: undefined };
    for (const child of this.grants.values()) if (child.rootGrantId === old.id) child.rootGrantId = grant.id;
    this.remove(old); this.grants.set(grant.id, grant);
    return { grantId: grant.id, environmentId: this.environmentId, threadId: grant.threadId, target };
  }

  heartbeat(client: Client, grantId: unknown) {
    const grant = this.owned(client, grantId);
    grant.active = true;
    grant.seenAt = this.now();
    return { online: true };
  }

  revoke(client: Client, grantId: unknown) { this.remove(this.owned(client, grantId)); return {}; }

  status(threadId: unknown) {
    const grants = this.forSession(threadId);
    if (!grants.length) return { authorized: false, online: false };
    return { authorized: true, online: grants.some((grant) => this.isOnline(grant)),
      pageCount: grants.length, onlinePageCount: grants.filter((grant) => this.isOnline(grant)).length,
      ...(grants.length === 1 ? { origin: grants[0].target.origin } : {}),
      lastToolSuccessAt: Math.max(0, ...grants.map((grant) => grant.lastToolSuccessAt ?? 0)) || null };
  }

  listPages(threadId: string, turnId: string, offset = 0, limit = 10) {
    requireBrowserId(threadId); requireBrowserId(turnId);
    if (!Number.isInteger(offset) || offset < 0 || offset > 64 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('browser_invalid_request');
    const grants = this.forSession(threadId);
    return { pages: grants.slice(offset, offset + limit).map((grant) => ({ pageId: grant.id,
      origin: grant.target.origin.slice(0, 512), kind: grant.rootGrantId ? 'ai-opened' : 'authorized-root', online: this.isOnline(grant) })), total: grants.length,
      nextOffset: offset + limit < grants.length ? offset + limit : null };
  }

  // Added to this exact turn, never a second message or global Codex configuration.
  // No page content, credentials, URLs or model-supplied routing IDs in the prompt.
  withContext(threadId: string, text: unknown) {
    const grants = this.forSession(threadId);
    if (!grants.length && !this.contextualized.has(threadId)) return text;
    this.contextualized.delete(threadId); this.contextualized.add(threadId);
    if (this.contextualized.size > 64) this.contextualized.delete(this.contextualized.values().next().value!);
    return `${String(text ?? '')}\n\n${browserContext(grants.length, grants.filter((grant) => this.isOnline(grant)).length)}`;
  }

  async execute(threadId: string, turnId: string, operation: BrowserOperation, pageId?: string): Promise<unknown> {
    requireBrowserId(threadId); requireBrowserId(turnId);
    const op = parseOperation(operation);
    const grants = this.forSession(threadId);
    if (pageId !== undefined) requireBrowserId(pageId);
    if (pageId === undefined && grants.length > 1) throw new Error('browser_page_selection_required');
    const grant = pageId === undefined ? grants[0] : grants.find((entry) => entry.id === pageId);
    if (!grant && pageId !== undefined) throw new Error('browser_page_not_authorized_for_this_session');
    if (!grant) throw new Error('browser_not_authorized_for_this_session');
    if (!this.isOnline(grant)) throw new Error('browser_offline');
    if ([...this.pending.values()].some((request) => request.grant === grant)) throw new Error('browser_busy');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('browser_operation_timeout_do_not_retry_writes_blindly'));
      }, this.timeoutMs);
      this.pending.set(requestId, { grant, operation: op, resolve, reject, timer });
      if (!this.send({ type: 'event', clientId: grant.clientId, event: 'browser.operation', payload: {
        requestId, grantId: grant.id, threadId, turnId, environmentId: this.environmentId,
        target: grant.target, sequence: ++grant.sequence, deadline: this.now() + this.timeoutMs, operation: op,
      } })) this.remove(grant);
    });
  }

  result(client: Client, value: Record<string, unknown>) {
    const pending = this.pending.get(String(value.requestId));
    if (!pending) throw new Error('browser_request_expired');
    if (this.owned(client, value.grantId) !== pending.grant) throw new Error('browser_grant_mismatch');
    if (JSON.stringify(value.result ?? null).length > 24_000) throw new Error('browser_result_too_large');
    clearTimeout(pending.timer); this.pending.delete(String(value.requestId));
    if (value.ok === true) { pending.grant.lastToolSuccessAt = this.now(); pending.resolve(value.result); }
    else pending.reject(new Error(typeof value.errorCode === 'string' && ['browser_child_permission_required', 'browser_child_origin_denied', 'browser_operation_timeout'].includes(value.errorCode)
      ? value.errorCode : 'browser_operation_failed_or_authorization_changed'));
    return {};
  }

  clear() { this.bindingIntents.clear(); for (const grant of this.grants.values()) this.remove(grant); }
  private forSession(threadId: unknown) { return [...this.grants.values()].filter((grant) => grant.threadId === threadId); }
  private isOnline(grant: Grant) { return grant.active && this.now() - grant.seenAt < 45_000; }
  private owned(client: Client, grantId: unknown) {
    const grant = this.grants.get(String(grantId));
    if (!grant || grant.clientId !== client.clientId || grant.clientDeviceId !== client.clientDeviceId) throw new Error('browser_not_authorized');
    return grant;
  }
  private remove(grant: Grant) {
    this.grants.delete(grant.id);
    for (const child of this.grants.values()) if (child.rootGrantId === grant.id) this.remove(child);
    for (const [id, pending] of this.pending) if (pending.grant === grant) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error('browser_authorization_changed'));
    }
  }
}
