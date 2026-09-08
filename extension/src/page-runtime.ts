import type { BrowserTarget } from '../../src/browser-control/contracts.js';
import { browserOperationErrorCode, type BrowserOperation } from '../../src/browser-control/operations.js';
import { runPageAgent } from './page-agent.js';
import { observeClickNavigation } from './click-navigation.js';
import { pointerClick } from './pointer-click.js';
import { captureScreenshot } from './screenshot.js';
import { zoomPage } from './page-zoom.js';
import { withinDeadline } from './deadline.js';

export async function page(target: BrowserTarget, grantId: string, operation: Parameters<typeof runPageAgent>[0]['operation'], deadline = Date.now() + 15_000, clickPhase?: Parameters<typeof runPageAgent>[0]['clickPhase']) {
  const [result] = await withinDeadline(chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] }, world: 'ISOLATED', injectImmediately: true,
    func: runPageAgent, args: [{ grantId, origin: target.origin, operation, deadline, clickPhase }] }), deadline, 'browser_operation_timeout');
  if (!result || result.documentId !== target.documentId || !result.result) throw new Error('browser_document_changed');
  if ('errorCode' in result.result) throw new Error(browserOperationErrorCode(result.result.errorCode));
  if ('denied' in result.result && result.result.denied === 'browser_child_origin_denied') throw new Error(result.result.denied);
  return result.result;
}

// Drivers operate on one exact grant. Child adoption and publishing results
// belong to the worker, after it rechecks the grant's lifetime.
export async function runPageOperation(target: BrowserTarget, grantId: string, operation: BrowserOperation,
  deadline: number, current: () => boolean) {
  const run = () => {
    if (operation.method === 'zoom') return zoomPage(target, grantId, operation.percent, deadline, current);
    if (operation.method !== 'screenshot') return page(target, grantId, operation, deadline);
    return captureScreenshot(target, grantId, Math.min(deadline, Date.now() + 15_000), current);
  };
  const observed = operation.method === 'click'
    ? await observeClickNavigation(target, deadline, current,
      () => pointerClick(target, deadline, current,
        (phase) => page(target, grantId, operation, deadline, phase)))
    : { result: await run(), targets: [] };
  const result: Record<string, unknown> = observed.result;
  if (operation.method === 'snapshot') {
    const zoom = await withinDeadline(chrome.tabs.getZoom(target.tabId), deadline, 'browser_operation_timeout');
    if (!current()) throw new Error('browser_document_changed');
    result.viewport = { ...Object(result.viewport), zoomPercent: Math.round(zoom * 100) };
    result.extensionBuild = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;
    result.browserEngine = globalThis.navigator?.userAgent?.match(/(?:Chrome|Edg)\/[\d.]+/g)?.slice(0, 2).join(' ');
  }

  return { result, targets: observed.targets };
}
