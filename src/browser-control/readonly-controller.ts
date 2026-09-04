import {
  BrowserControlError, parseBrowserOwner, parseBrowserTarget,
  type BrowserOwner, type BrowserTarget, type SnapshotOptions,
} from './contracts.js';
import { BrowserGrantStore } from './grants.js';
import { boundedBrowserRead } from './request-deadline.js';

export type BrowserSnapshot = {
  origin: string;
  nodes: Array<{ text: string; tag: string }>;
  truncated: boolean;
};
export type BrowserSnapshotDriver = {
  currentTarget(signal: AbortSignal): Promise<BrowserTarget>;
  snapshot(target: BrowserTarget, options: SnapshotOptions, signal: AbortSignal): Promise<BrowserSnapshot>;
};

// The owner is supplied by an authenticated host adapter, never by tool arguments.
// A separate instance is required for each task/controller binding.
export class ReadonlyBrowserController {
  private readonly owner: BrowserOwner;
  private readonly target: BrowserTarget;

  constructor(owner: BrowserOwner, target: BrowserTarget, private readonly grants: BrowserGrantStore, private readonly driver: BrowserSnapshotDriver) {
    this.owner = parseBrowserOwner(owner);
    this.target = parseBrowserTarget(target);
  }

  async execute(value: unknown): Promise<BrowserSnapshot> {
    const target = this.target;
    const lease = this.grants.authorize(this.owner, target, value);
    const checkTarget = (value: BrowserTarget) => {
      const current = parseBrowserTarget(value);
      if (current.browserDeviceId !== target.browserDeviceId || current.tabId !== target.tabId
        || current.documentId !== target.documentId || current.origin !== target.origin) {
        this.grants.revoke(lease.grant.id);
        throw new BrowserControlError('browser_document_changed');
      }
    };
    const result = await boundedBrowserRead(async (signal) => {
      checkTarget(await this.driver.currentTarget(signal));
      lease.revalidate();
      const result = await this.driver.snapshot(lease.grant.target, lease.request.params, signal);
      lease.revalidate();
      checkTarget(await this.driver.currentTarget(signal));
      return result;
    }, lease.signal, lease.timeoutMs);
    lease.revalidate();
    if (!result || result.origin !== target.origin || !Array.isArray(result.nodes)
      || result.nodes.length > lease.request.params.maxNodes
      || typeof result.truncated !== 'boolean') throw new BrowserControlError('browser_invalid_snapshot');
    let chars = 0;
    const nodes = result.nodes.map((node) => {
      if (!node || typeof node.text !== 'string' || typeof node.tag !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(node.tag)) {
        throw new BrowserControlError('browser_invalid_snapshot');
      }
      chars += node.text.length;
      if (chars > lease.request.params.maxChars) throw new BrowserControlError('browser_invalid_snapshot');
      return { text: node.text, tag: node.tag };
    });
    return { origin: target.origin, nodes, truncated: result.truncated };
  }
}
