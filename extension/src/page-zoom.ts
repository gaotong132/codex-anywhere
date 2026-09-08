import type { BrowserTarget } from '../../src/browser-control/contracts.js';
import { withinDeadline } from './deadline.js';

// Fixed isolated-document probe. It never returns page text or touches form data.
export function inspectZoom(input: { grantId: string; origin: string; deadline: number; invalidate: boolean }) {
  try {
    const state = (globalThis as typeof globalThis & { __anywhereBrowser?: { grantId: string; refs: Map<string, unknown>; snapshot: string } }).__anywhereBrowser;
    if (Date.now() >= input.deadline || location.origin !== input.origin || state?.grantId !== input.grantId) throw new Error('browser_document_changed');
    if (input.invalidate) { state.refs.clear(); state.snapshot = ''; }
    return { width: innerWidth, height: innerHeight, devicePixelRatio: window.devicePixelRatio };
  } catch { return { errorCode: 'browser_document_changed' }; }
}

export async function zoomPage(target: BrowserTarget, grantId: string, percent: number, deadline: number, current: () => boolean) {
  if (!Number.isInteger(percent) || percent < 50 || percent > 200) throw new Error('browser_invalid_operation');
  let started = false;
  const valid = () => { if (!current() || Date.now() >= deadline) throw new Error('browser_document_changed'); };
  const bounded = <T>(work: Promise<T>) => withinDeadline(work, deadline, 'browser_zoom_unavailable');
  const inspect = async (invalidate: boolean) => {
    valid();
    const [proof] = await bounded(chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] },
      world: 'ISOLATED', injectImmediately: true, func: inspectZoom, args: [{ grantId, origin: target.origin, deadline, invalidate }] }));
    valid();
    if (proof?.documentId !== target.documentId || !proof.result || 'errorCode' in proof.result) throw new Error('browser_document_changed');
    return proof.result;
  };
  try {
    await inspect(false);
    const settings = await bounded(chrome.tabs.getZoomSettings(target.tabId));
    if (settings.mode !== 'automatic') throw new Error('browser_zoom_unavailable');
    const previous = await bounded(chrome.tabs.getZoom(target.tabId));
    await inspect(true);
    valid(); started = true;
    // Chrome otherwise persists zoom for the entire origin, affecting other tabs.
    await bounded(chrome.tabs.setZoomSettings(target.tabId, { mode: 'automatic', scope: 'per-tab' }));
    await inspect(true);
    const isolated = await bounded(chrome.tabs.getZoomSettings(target.tabId));
    if (isolated.mode !== 'automatic' || isolated.scope !== 'per-tab') throw new Error('browser_zoom_unavailable');
    await inspect(true); valid();
    await bounded(chrome.tabs.setZoom(target.tabId, percent / 100));
    const actual = await bounded(chrome.tabs.getZoom(target.tabId));
    const finalSettings = await bounded(chrome.tabs.getZoomSettings(target.tabId));
    const viewport = await inspect(true);
    if (!Number.isFinite(actual) || Math.abs(actual * 100 - percent) > .1 || finalSettings.mode !== 'automatic' || finalSettings.scope !== 'per-tab') throw new Error('browser_zoom_unavailable');
    return { zoomPercent: Math.round(actual * 100), previousZoomPercent: Math.round(previous * 100), scope: 'per-tab',
      viewport, requiresSnapshot: true };
  } catch (error) {
    if (started) throw new Error('browser_zoom_interrupted');
    if (error instanceof Error && error.message === 'browser_document_changed') throw error;
    throw new Error('browser_zoom_unavailable');
  }
}
