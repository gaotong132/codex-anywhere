import { parseBrowserTarget, type BrowserTarget } from '../../src/browser-control/contracts.js';

// Object identity is the lifetime of a grant. Navigation/reconnection replaces
// the Binding, so work holding the old object cannot act for the new document.
export type Binding = {
  grantId: string;
  environmentId: string;
  threadId: string;
  title: string;
  pageTitle?: string;
  target: BrowserTarget;
  sequence: number;
  rootTabId?: number;
  lastUsedAt?: number;
};

export function matchesTarget(value: unknown, expected: BrowserTarget) {
  try {
    const target = parseBrowserTarget(value);
    return target.browserDeviceId === expected.browserDeviceId && target.tabId === expected.tabId
      && target.documentId === expected.documentId && target.origin === expected.origin;
  } catch { return false; }
}
