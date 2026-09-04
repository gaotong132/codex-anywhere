import { browserOrigin, type BrowserTarget } from '../../src/browser-control/contracts.js';
import { LocalPreviewSession } from './preview-session.js';
import { collectLocalSnapshot } from './snapshot.js';

async function targetForTab(tabId: number, signal: AbortSignal): Promise<BrowserTarget> {
  if (signal.aborted) throw new Error('browser_not_authorized');
  const tab = await chrome.tabs.get(tabId);
  browserOrigin(tab.url);
  if (signal.aborted) throw new Error('browser_not_authorized');
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: 'ISOLATED',
    func: () => location.origin,
  });
  if (signal.aborted || !result?.documentId || result.result !== browserOrigin(tab.url)) throw new Error('browser_document_changed');
  return { browserDeviceId: 'local-preview-browser', tabId, documentId: result.documentId, origin: result.result };
}

// Local-only: no Relay, remote pairing or Codex is connected in this preview.
const session = new LocalPreviewSession({
  resolveActiveTarget: async (signal, selectTab) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('browser_no_tab');
    selectTab(tab.id);
    return targetForTab(tab.id, signal);
  },
  forTarget: (approved) => ({
    currentTarget: (signal) => targetForTab(approved.tabId, signal),
    snapshot: async (target, options, signal) => {
      if (signal.aborted) throw new Error('browser_not_authorized');
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: target.tabId, documentIds: [target.documentId] },
        world: 'ISOLATED', func: collectLocalSnapshot, args: [options],
      });
      if (signal.aborted || !result || result.documentId !== target.documentId || !result.result) throw new Error('browser_document_changed');
      return result.result;
    },
  }),
});

let badgeUpdate = Promise.resolve();
function refreshBadge() {
  badgeUpdate = badgeUpdate.catch(() => {}).then(async () => {
    await chrome.action.setBadgeBackgroundColor({ color: '#3974de' });
    await chrome.action.setBadgeText({ text: session.status().origin ? 'READ' : '' });
  });
  void badgeUpdate.catch(() => {});
}

// Accept only our packaged popup, never a content script or a website.
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const run = async () => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).length !== 1 || !('type' in message)) throw new Error('browser_invalid_request');
    if (message.type === 'stop') { session.stop(); return session.status(); }
    if (message.type === 'status') return session.status();
    if (message.type === 'grant') return session.grant();
    if (message.type === 'snapshot') return session.snapshot();
    throw new Error('browser_method_not_supported');
  };
  void run().then((result) => respond({ ok: true, result })).catch(() => {
    // Raw browser errors may contain URLs or page text; never log or display them.
    respond({ ok: false, error: '当前页面不可读取、已改变或授权已失效。请在普通网页上重新授权。' });
  }).finally(refreshBadge);
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => { session.invalidateTab(tabId); refreshBadge(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined || change.status === 'loading') { session.invalidateTab(tabId); refreshBadge(); }
});
// Worker restart is fail-closed; no grants or page content are restored from disk.
refreshBadge();
