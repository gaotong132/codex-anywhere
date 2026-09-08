import type { BrowserTarget } from '../../src/browser-control/contracts.js';
import { acquireDebugger } from './debugger-session.js';
import { withinDeadline } from './deadline.js';

// Only browser-derived points from the exact granted document reach this helper.
// No debugger command, coordinate or target is accepted as a tool argument.
export async function pointerClick(target: BrowserTarget, deadline: number, current: () => boolean,
  prepare: (phase?: 'verify' | 'arm' | 'hover' | 'consume' | 'end') => Promise<Record<string, unknown>>) {
  const bounded = <T>(work: Promise<T>) => withinDeadline(work, deadline, 'browser_native_click_unavailable');
  const first = await bounded(prepare());
  if (!('clickPoint' in first)) return first; // Managed links and native select labels.
  if (!await bounded(chrome.permissions.contains({ permissions: ['debugger'] }))) throw new Error('browser_native_click_permission_required');
  let point = first.clickPoint as { x: number; y: number };
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) throw new Error('browser_stale_element_read_again');
  const attachedTarget = { tabId: target.tabId };
  let lease: Awaited<ReturnType<typeof acquireDebugger>> | undefined;
  const valid = () => {
    if (!current() || (lease && !lease.current()) || Date.now() >= deadline) throw new Error('browser_document_changed');
  };
  const verify = async (consume = false) => {
    valid();
    const result = await bounded(prepare(consume ? 'consume' : 'hover'));
    const next = result.clickPoint as typeof point | undefined;
    if (!next || next.x !== point.x || next.y !== point.y) throw new Error('browser_stale_element_read_again');
    valid();
    return result.pointerMismatch !== true;
  };
  valid();
  lease = await withinDeadline(acquireDebugger(target, deadline, current), deadline, 'browser_native_click_unavailable', late => late.close());
  let pressed = false, started = false, completed = false;
  try {
    valid();
    // Chrome's debugging notice can resize the viewport. Re-read the same ref
    // after attachment before sending any input; never reuse old coordinates.
    const attachedPoint = (await bounded(prepare('arm'))).clickPoint as typeof point | undefined;
    if (!attachedPoint || !Number.isFinite(attachedPoint.x) || !Number.isFinite(attachedPoint.y)
      || attachedPoint.x < 0 || attachedPoint.y < 0) throw new Error('browser_stale_element_read_again');
    point = attachedPoint; valid();
    await bounded(chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 }));
    if (!await verify()) return { clicked: false, reason: 'native_pointer_mismatch',
      nextStep: 'No mouse press was sent. Read a fresh snapshot for pointer evidence and fix the browser driver before retrying.' };
    pressed = true; started = true;
    await bounded(chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }));
    await verify(true); // Consume refs before the final event can navigate.
    pressed = false; // An uncertain release must never be replayed.
    await bounded(chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }));
    completed = true; return { clicked: true };
  } catch (failure) {
    if (started) throw new Error('browser_native_click_interrupted');
    throw failure;
  } finally {
    const cleanupDeadline = Date.now() + 1000;
    const cleanup = <T>(work: Promise<T>) => withinDeadline(work, cleanupDeadline, 'browser_native_click_unavailable').catch(() => {});
    await cleanup(prepare('end'));
    // Cancel an unfinished press outside the page, without clicking a replacement.
    if (pressed) await cleanup(chrome.debugger.sendCommand(attachedTarget, 'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0 }));
    if (completed) lease.release(); else await cleanup(lease.close());
  }
}
