import { browserOrigin, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { sitePattern } from './site-permission.js';

// No enumeration/adoption of ambient tabs. Creation returns the only eligible ID.
export async function openManagedTab(url: string, parent: BrowserTarget, deadline: number, stillAuthorized: () => boolean): Promise<
  { target: BrowserTarget } | { authorizationRequired: true; origin: string }
> {
  const destinationOrigin = browserOrigin(url);
  const canManage = destinationOrigin === parent.origin && await chrome.permissions.contains({ origins: [sitePattern(parent.origin)] });
  const parentTab = await chrome.tabs.get(parent.tabId);
  if (!stillAuthorized() || Date.now() >= deadline) throw new Error('browser_authorization_changed');
  // Follow the requested navigation in its existing window so the user can see
  // the page being operated on; activation does not grant control of the site.
  const tab = await chrome.tabs.create({ url, active: true, openerTabId: parent.tabId, windowId: parentTab.windowId });
  if (tab.id === undefined) throw new Error('browser_no_tab');
  if (!stillAuthorized()) throw new Error('browser_authorization_changed');
  // Opening a user-requested link does not grant access to its destination.
  // Leave the new tab visible for the user's site consent; never inject it.
  if (!canManage) return { authorizationRequired: true, origin: destinationOrigin };
  return inspectCreatedTab(tab.id, parent, deadline, stillAuthorized);
}

// Caller must attest to tabs.create or a new-target browser event from its live
// click operation. This helper does not discover or choose an existing tab.
export async function inspectCreatedTab(tabId: number, parent: BrowserTarget, deadline: number, stillAuthorized: () => boolean): Promise<
  { target: BrowserTarget } | { authorizationRequired: true; origin: string }
> {
  while (stillAuthorized() && Date.now() < deadline - 500) {
    const current = await chrome.tabs.get(tabId);
    // A parsed page can stay "loading" while an image or telemetry request stalls.
    // Wait for an interactive document, not every optional subresource.
    if (current.url && /^https?:/.test(current.url)) {
      const currentOrigin = browserOrigin(current.url);
      if (currentOrigin !== parent.origin || !await chrome.permissions.contains({ origins: [sitePattern(parent.origin)] })) {
        await chrome.tabs.update(tabId, { active: true });
        return { authorizationRequired: true, origin: currentOrigin };
      }
      const [proof] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', injectImmediately: true,
        func: () => ({ origin: location.origin, readyState: document.readyState }) });
      if (!proof?.documentId || proof.result?.origin !== parent.origin || !stillAuthorized()) throw new Error('browser_document_changed');
      if (proof.result.readyState === 'interactive' || proof.result.readyState === 'complete') {
        return { target: { browserDeviceId: parent.browserDeviceId, tabId, documentId: proof.documentId, origin: parent.origin } };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // A timeout never triggers another create or silently adopts a later tab.
  throw new Error('browser_operation_timeout');
}
