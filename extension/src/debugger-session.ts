import type { BrowserTarget } from '../../src/browser-control/contracts.js';

// Repeated attach/detach resizes Chrome's viewport and closes resize-sensitive
// menus. Reuse only our own debugger for the same still-authorized document.
type Entry = { target: BrowserTarget; current: () => boolean; ready: Promise<void>;
  attached: boolean; users: number; closing?: Promise<void>; timer?: ReturnType<typeof setTimeout> };
const sessions = new Map<number, Entry>();
let observed: typeof chrome.debugger | undefined;
let cancelled: (tabId: number) => void = () => {};
export function onDebuggerCancellation(handler: typeof cancelled) { cancelled = handler; }

export async function releaseDebugger(tabId: number) {
  const entry = sessions.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.closing ??= (async () => {
    await entry.ready.catch(() => {});
    if (entry.attached) {
      entry.attached = false;
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    if (sessions.get(tabId) === entry) sessions.delete(tabId);
  })();
  await entry.closing;
}

export async function releaseAllDebuggers() {
  await Promise.all([...sessions.keys()].map(releaseDebugger));
}

export async function acquireDebugger(target: BrowserTarget, deadline: number, current: () => boolean) {
  const valid = () => { if (!current() || Date.now() >= deadline) throw new Error('browser_document_changed'); };
  valid();
  if (observed !== chrome.debugger && chrome.debugger.onDetach) {
    observed = chrome.debugger;
    chrome.debugger.onDetach.addListener((source, reason) => {
      const entry = source.tabId === undefined ? undefined : sessions.get(source.tabId);
      if (entry) {
        entry.attached = false; clearTimeout(entry.timer); sessions.delete(source.tabId!);
        if (reason === 'canceled_by_user' && !entry.closing) cancelled(source.tabId!);
      }
    });
  }
  let entry = sessions.get(target.tabId);
  if (entry && (entry.closing || !entry.current() || entry.target.documentId !== target.documentId
    || entry.target.origin !== target.origin || entry.target.browserDeviceId !== target.browserDeviceId)) {
    await releaseDebugger(target.tabId); entry = undefined; valid();
  }
  if (!entry) {
    const created: Entry = { target, current, ready: Promise.resolve(), attached: false, users: 0 };
    sessions.set(target.tabId, created);
    created.ready = Promise.resolve().then(() => chrome.debugger.attach({ tabId: target.tabId }, '1.3')).then(() => { created.attached = true; });
    entry = created;
  }
  clearTimeout(entry.timer); entry.users++;
  try { await entry.ready; }
  catch {
    entry.users--;
    if (sessions.get(target.tabId) === entry) sessions.delete(target.tabId);
    throw new Error('browser_native_click_unavailable');
  }
  const owned = entry;
  if (!current() || Date.now() >= deadline || sessions.get(target.tabId) !== owned || !owned.attached) {
    owned.users--; if (sessions.get(target.tabId) === owned) await releaseDebugger(target.tabId);
    throw new Error('browser_document_changed');
  }
  let released = false;
  return {
    current: () => current() && sessions.get(target.tabId) === owned && owned.attached && !owned.closing,
    release: () => {
      if (released) return;
      released = true; owned.users--;
      if (sessions.get(target.tabId) !== owned || owned.users) return;
      if (!owned.current()) { void releaseDebugger(target.tabId); return; }
      owned.timer = setTimeout(() => {
        if (sessions.get(target.tabId) === owned && owned.users === 0) void releaseDebugger(target.tabId);
      }, 60_000);
      (owned.timer as unknown as { unref?: () => void }).unref?.();
    },
    close: async () => {
      if (!released) { released = true; owned.users--; }
      if (sessions.get(target.tabId) === owned) await releaseDebugger(target.tabId);
    },
  };
}
