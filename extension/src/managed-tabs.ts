import { browserOrigin, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { sitePattern } from './site-permission.js';

// No enumeration/adoption of ambient tabs: only the ID returned by our own
// create call can become a child. Page scripts cannot call this function.
export async function openManagedTab(url: string, parent: BrowserTarget, deadline: number, stillAuthorized: () => boolean): Promise<BrowserTarget> {
  if (browserOrigin(url) !== parent.origin) throw new Error('browser_child_origin_denied');
  if (!await chrome.permissions.contains({ origins: [sitePattern(parent.origin)] })) throw new Error('browser_child_permission_required');
  const parentTab = await chrome.tabs.get(parent.tabId);
  if (!stillAuthorized() || Date.now() >= deadline) throw new Error('browser_authorization_changed');
  const tab = await chrome.tabs.create({ url, active: false, openerTabId: parent.tabId, windowId: parentTab.windowId });
  if (tab.id === undefined) throw new Error('browser_no_tab');
  while (stillAuthorized() && Date.now() < deadline - 500) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === 'complete') {
      if (browserOrigin(current.url) !== parent.origin) throw new Error('browser_child_origin_denied');
      const [document] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: () => location.origin });
      if (!document?.documentId || document.result !== parent.origin || !stillAuthorized()) throw new Error('browser_document_changed');
      return { browserDeviceId: parent.browserDeviceId, tabId: tab.id, documentId: document.documentId, origin: parent.origin };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // A timeout never triggers another create or silently adopts a later tab.
  throw new Error('browser_operation_timeout');
}
