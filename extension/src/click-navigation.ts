import type { BrowserTarget } from '../../src/browser-control/contracts.js';

// Observe only new navigation targets from the active click's top-level page.
// Existing tabs, other pages/frames, and popups outside this operation are ignored.
// Never accept a tab ID, destination or navigation claim supplied by page messages.
export async function observeClickNavigation<T extends Record<string, unknown>>(parent: BrowserTarget, deadline: number,
  current: () => boolean, click: () => Promise<T>) {
  const targets = new Map<number, string>();
  const listener = (event: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
    if (current() && Date.now() < deadline && event.sourceTabId === parent.tabId && event.sourceFrameId === 0) {
      if (targets.size < 4) targets.set(event.tabId, event.url);
    }
  };
  chrome.webNavigation.onCreatedNavigationTarget.addListener(listener);
  try {
    const result = await click();
    if (result.clicked !== true) return { result, targets: [] };
    // Browser-process navigation notifications may follow the renderer result.
    // This short delivery window is bounded; no late adoption or click replay.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!current() || Date.now() >= deadline) throw new Error('browser_authorization_changed');
    if (targets.size) {
      const [proof] = await chrome.scripting.executeScript({
        target: { tabId: parent.tabId, documentIds: [parent.documentId] }, world: 'ISOLATED', injectImmediately: true,
        func: () => location.origin,
      });
      if (proof?.documentId !== parent.documentId || proof.result !== parent.origin || !current()) throw new Error('browser_document_changed');
    }
    return { result, targets: [...targets].map(([tabId, url]) => ({ tabId, url })) };
  } finally { chrome.webNavigation.onCreatedNavigationTarget.removeListener(listener); }
}
