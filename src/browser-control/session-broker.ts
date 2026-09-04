import { randomUUID } from 'node:crypto';
import { parseBrowserTarget, requireBrowserId, type BrowserTarget } from './contracts.js';
import { parseOperation, type BrowserOperation } from './operations.js';

type Client = { clientId: string; clientDeviceId: string };
type Grant = Client & { id: string; threadId: string; target: BrowserTarget; seenAt: number; sequence: number; active: boolean };
type Pending = { grant: Grant; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

// Consent has no TTL. Heartbeats describe transport liveness, not consent duration.
export class BrowserSessionBroker {
  private grants = new Map<string, Grant>();
  private pending = new Map<string, Pending>();
  private bindingIntents = new Map<string, object>();
  constructor(readonly environmentId: string, private send: (frame: Record<string, unknown>) => boolean,
    private now = Date.now, private timeoutMs = 15_000) {}

  async validateAndBind(client: Client, threadId: unknown, targetValue: unknown, validate: (threadId: string) => Promise<unknown>) {
    const target = parseBrowserTarget(targetValue);
    const id = requireBrowserId(threadId);
    if (target.browserDeviceId !== client.clientDeviceId) throw new Error('browser_device_mismatch');
    const key = `${client.clientDeviceId}:${target.tabId}`;
    if (this.bindingIntents.size >= 64 && !this.bindingIntents.has(key)) throw new Error('browser_grant_limit');
    const intent = {};
    this.bindingIntents.set(key, intent);
    try {
      await validate(id);
      if (this.bindingIntents.get(key) !== intent) throw new Error('browser_authorization_changed');
      return this.bind(client, id, target);
    } finally { if (this.bindingIntents.get(key) === intent) this.bindingIntents.delete(key); }
  }

  bind(client: Client, threadId: unknown, targetValue: unknown) {
    const target = parseBrowserTarget(targetValue);
    if (target.browserDeviceId !== client.clientDeviceId) throw new Error('browser_device_mismatch');
    const id = requireBrowserId(threadId);
    const existing = [...this.grants.values()].find((grant) => grant.threadId === id);
    if (existing && (existing.clientDeviceId !== client.clientDeviceId || existing.target.tabId !== target.tabId)) {
      throw new Error('browser_session_already_bound');
    }
    if (this.grants.size >= 64 && !existing) throw new Error('browser_grant_limit');
    for (const grant of this.grants.values()) {
      if (grant.clientDeviceId === client.clientDeviceId && grant.target.tabId === target.tabId) this.remove(grant);
    }
    const grant: Grant = { ...client, id: randomUUID(), threadId: id, target, seenAt: this.now(), sequence: 0, active: false };
    this.grants.set(grant.id, grant);
    return { grantId: grant.id, environmentId: this.environmentId, threadId: id, target };
  }

  heartbeat(client: Client, grantId: unknown) {
    const grant = this.owned(client, grantId);
    grant.active = true;
    grant.seenAt = this.now();
    return { online: true };
  }

  revoke(client: Client, grantId: unknown) { this.remove(this.owned(client, grantId)); return {}; }

  status(threadId: unknown) {
    const grant = [...this.grants.values()].find((entry) => entry.threadId === threadId);
    return grant ? { authorized: true, online: grant.active && this.now() - grant.seenAt < 45_000, origin: grant.target.origin } : { authorized: false, online: false };
  }

  async execute(threadId: string, turnId: string, operation: BrowserOperation): Promise<unknown> {
    requireBrowserId(threadId); requireBrowserId(turnId);
    const op = parseOperation(operation);
    const grant = [...this.grants.values()].find((entry) => entry.threadId === threadId);
    if (!grant) throw new Error('browser_not_authorized_for_this_session');
    if (!grant.active || this.now() - grant.seenAt >= 45_000) throw new Error('browser_offline');
    if ([...this.pending.values()].some((request) => request.grant === grant)) throw new Error('browser_busy');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('browser_operation_timeout_do_not_retry_writes_blindly'));
      }, this.timeoutMs);
      this.pending.set(requestId, { grant, resolve, reject, timer });
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
    if (value.ok === true) pending.resolve(value.result);
    else pending.reject(new Error('browser_operation_failed_or_authorization_changed'));
    return {};
  }

  clear() { this.bindingIntents.clear(); for (const grant of this.grants.values()) this.remove(grant); }
  private owned(client: Client, grantId: unknown) {
    const grant = this.grants.get(String(grantId));
    if (!grant || grant.clientId !== client.clientId || grant.clientDeviceId !== client.clientDeviceId) throw new Error('browser_not_authorized');
    return grant;
  }
  private remove(grant: Grant) {
    this.grants.delete(grant.id);
    for (const [id, pending] of this.pending) if (pending.grant === grant) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error('browser_authorization_changed'));
    }
  }
}
