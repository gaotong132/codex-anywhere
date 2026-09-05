import { browserOrigin, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { sitePattern } from './site-permission.js';

// No enumeration/adoption of ambient tabs: only the ID returned by our own
// create call can become a child. Page scripts cannot call this function.
export async function openManagedTab(url: string, parent: BrowserTarget, deadline: number, stillAuthorized: () => boolean): Promise<
  { target: BrowserTarget } | { authorizationRequired: true; origin: string }
> {
  const destinationOrigin = browserOrigin(url);
  const canManage = destinationOrigin === parent.origin && await chrome.permissions.contains({ origins: [sitePattern(parent.origin)] });
  const parentTab = await chrome.tabs.get(parent.tabId);
  if (!stillAuthorized() || Date.now() >= deadline) throw new Error('browser_authorization_changed');
  const tab = await chrome.tabs.create({ url, active: !canManage, openerTabId: parent.tabId, windowId: parentTab.windowId });
  if (tab.id === undefined) throw new Error('browser_no_tab');
  if (!stillAuthorized()) throw new Error('browser_authorization_changed');
  // Opening a user-requested link does not grant access to its destination.
  // Leave the new tab visible for the user's site consent; never inject it.
  if (!canManage) return { authorizationRequired: true, origin: destinationOrigin };
  while (stillAuthorized() && Date.now() < deadline - 500) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === 'complete') {
      const currentOrigin = browserOrigin(current.url);
      if (currentOrigin !== parent.origin || !await chrome.permissions.contains({ origins: [sitePattern(parent.origin)] })) {
        await chrome.tabs.update(tab.id, { active: true });
        return { authorizationRequired: true, origin: currentOrigin };
      }
      const [document] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: () => location.origin });
      if (!document?.documentId || document.result !== parent.origin || !stillAuthorized()) throw new Error('browser_document_changed');
      return { target: { browserDeviceId: parent.browserDeviceId, tabId: tab.id, documentId: document.documentId, origin: parent.origin } };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // A timeout never triggers another create or silently adopts a later tab.
  throw new Error('browser_operation_timeout');
}
