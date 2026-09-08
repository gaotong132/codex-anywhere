import type { BrowserTarget } from '../../src/browser-control/contracts.js';

// Only browser-derived points from the exact granted document reach this helper.
// No debugger command, coordinate or target is accepted as a tool argument.
export async function pointerClick(target: BrowserTarget, deadline: number, current: () => boolean,
  prepare: (phase?: 'verify' | 'consume') => Promise<Record<string, unknown>>) {
  const first = await prepare();
  if (!('clickPoint' in first)) return first; // Managed links and native select labels.
  if (!await chrome.permissions.contains({ permissions: ['debugger'] })) throw new Error('browser_native_click_permission_required');
  let point = first.clickPoint as { x: number; y: number };
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) throw new Error('browser_stale_element_read_again');
  const attachedTarget = { tabId: target.tabId };
  const valid = () => {
    if (!current() || Date.now() >= deadline) throw new Error('browser_document_changed');
  };
  const verify = async (consume = false) => {
    valid();
    const next = (await prepare(consume ? 'consume' : 'verify')).clickPoint as typeof point | undefined;
    if (!next || next.x !== point.x || next.y !== point.y) throw new Error('browser_stale_element_read_again');
    valid();
  };
  valid();
  try { await chrome.debugger.attach(attachedTarget, '1.3'); }
  catch { throw new Error('browser_native_click_unavailable'); }
  let pressed = false, started = false;
  try {
    valid();
    // Chrome's debugging notice can resize the viewport. Re-read the same ref
    // after attachment before sending any input; never reuse old coordinates.
    const attachedPoint = (await prepare('verify')).clickPoint as typeof point | undefined;
    if (!attachedPoint || !Number.isFinite(attachedPoint.x) || !Number.isFinite(attachedPoint.y)
      || attachedPoint.x < 0 || attachedPoint.y < 0) throw new Error('browser_stale_element_read_again');
    point = attachedPoint; valid();
    await chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
    await verify(); // Hover can open an overlay or replace the referenced control.
    pressed = true; started = true;
    await chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await verify(true); // Consume refs before the final event can navigate.
    pressed = false; // An uncertain release must never be replayed.
    await chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    return { clicked: true };
  } catch (failure) {
    if (started) throw new Error('browser_native_click_interrupted');
    throw failure;
  } finally {
    // Cancel an unfinished press outside the page, without clicking a replacement.
    if (pressed) await chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0 }).catch(() => {});
    await chrome.debugger.detach(attachedTarget).catch(() => {});
  }
}
