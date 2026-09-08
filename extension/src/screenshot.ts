import type { BrowserTarget } from '../../src/browser-control/contracts.js';
import { acquireDebugger } from './debugger-session.js';
import { parseScreenshot, SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_EDGE, type BrowserScreenshot } from '../../src/browser-control/screenshot.js';

type Region = { x: number; y: number; width: number; height: number };
type View = { width: number; height: number; x: number; y: number; dpr: number; regions: Region[] };

function bounded<T>(work: Promise<T>, deadline: number, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { finished = true; reject(new Error('browser_screenshot_unavailable')); }, Math.max(0, deadline - Date.now()));
    work.then(value => {
      if (finished) { late?.(value); return; }
      finished = true; clearTimeout(timer); resolve(value);
    }, error => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
  });
}

// Serialized into the exact authorized ISOLATED document. Form values never
// leave the page. Observe changes until the image has been masked and validated.
export function inspectScreenshot(input: { grantId: string; origin: string; token: string; deadline: number; phase: 'begin' | 'check' | 'end' }) {
  try {
    const scope = globalThis as typeof globalThis & { __anywhereBrowser?: { grantId: string };
      __anywhereScreenshot?: { token: string; changed: boolean; cleanup(): void } };
    if (input.phase === 'end') {
      if (scope.__anywhereScreenshot?.token === input.token) { scope.__anywhereScreenshot.cleanup(); delete scope.__anywhereScreenshot; }
      return { ended: true };
    }
    if (Date.now() >= input.deadline || location.origin !== input.origin || scope.__anywhereBrowser?.grantId !== input.grantId) throw new Error('browser_document_changed');
    if (input.phase === 'check' && (scope.__anywhereScreenshot?.token !== input.token || scope.__anywhereScreenshot.changed)) throw new Error('browser_screenshot_changed');
    const viewport = window.visualViewport;
    if (viewport && (viewport.scale !== 1 || viewport.offsetLeft !== 0 || viewport.offsetTop !== 0)) throw new Error('browser_screenshot_unavailable');
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216)) throw new Error('browser_screenshot_too_large');
    const regions: Region[] = [];
    const elements = document.querySelectorAll('*');
    if (elements.length > 20_000) throw new Error('browser_screenshot_unavailable');
    for (const element of elements) {
      const hint = ['type', 'name', 'id', 'autocomplete', 'aria-label'].map(key => element.getAttribute(key) || '').join(' ');
      if (!element.matches('input,textarea,select,[contenteditable],iframe,object,embed,[data-anywhere-private]') && !element.shadowRoot
        && !/password|passwd|secret|token|credit|cc-|card.?number|one-time-code|otp|cvv|cvc|social.?security/i.test(hint)) continue;
      for (const rect of element.getClientRects()) {
        const x = Math.max(0, Math.floor(rect.left) - 8), y = Math.max(0, Math.floor(rect.top) - 8);
        const right = Math.min(width, Math.ceil(rect.right) + 8), bottom = Math.min(height, Math.ceil(rect.bottom) + 8);
        if (rect.width > 0 && rect.height > 0 && right > x && bottom > y) regions.push({ x, y, width: right - x, height: bottom - y });
        if (regions.length > 20_000) throw new Error('browser_screenshot_unavailable');
      }
    }
    if (input.phase === 'begin') {
      scope.__anywhereScreenshot?.cleanup();
      const guard = { token: input.token, changed: false, cleanup: () => {} };
      const changed = () => { guard.changed = true; };
      const observer = new MutationObserver(changed);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const events = ['scroll', 'resize', 'input', 'change'];
      for (const event of events) window.addEventListener(event, changed, true);
      const expiry = setTimeout(() => { changed(); guard.cleanup(); }, Math.max(0, Math.min(15_000, input.deadline - Date.now())));
      guard.cleanup = () => { clearTimeout(expiry); observer.disconnect(); for (const event of events) window.removeEventListener(event, changed, true); };
      scope.__anywhereScreenshot = guard;
    }
    return { width, height, x: window.scrollX, y: window.scrollY, dpr: window.devicePixelRatio, regions };
  } catch (error) {
    return { errorCode: error instanceof Error && /^browser_[a-z_]+$/.test(error.message) ? error.message : 'browser_screenshot_unavailable' };
  }
}

export async function captureScreenshot(target: BrowserTarget, grantId: string, deadline: number, current: () => boolean): Promise<BrowserScreenshot> {
  if (!await bounded(chrome.permissions.contains({ permissions: ['debugger'] }), deadline)) throw new Error('browser_screenshot_permission_required');
  const token = crypto.randomUUID();
  const attached = { tabId: target.tabId };
  let lease: Awaited<ReturnType<typeof acquireDebugger>> | undefined;
  const valid = () => { if (!current() || (lease && !lease.current()) || Date.now() >= deadline) throw new Error('browser_document_changed'); };
  const inspect = async (phase: 'begin' | 'check' | 'end') => {
    const [proof] = await bounded(chrome.scripting.executeScript({ target: { tabId: target.tabId, documentIds: [target.documentId] },
      world: 'ISOLATED', injectImmediately: true, func: inspectScreenshot, args: [{ grantId, origin: target.origin, token, deadline, phase }] }),
      phase === 'end' ? Date.now() + 1000 : deadline);
    if (!proof || proof.documentId !== target.documentId || !proof.result) throw new Error('browser_document_changed');
    if ('errorCode' in proof.result) throw new Error(proof.result.errorCode);
    return proof.result as View;
  };
  valid();
  // Prove the grant before attaching even though attachment itself takes no image.
  try { await inspect('begin'); } finally { await inspect('end').catch(() => {}); }
  valid();
  try { lease = await bounded(acquireDebugger(target, deadline, current), deadline, late => late.release()); }
  catch { throw new Error('browser_screenshot_unavailable'); }
  let completed = false;
  try {
    valid();
    // Chrome's debugging banner can resize the viewport asynchronously after
    // attach. Wait for a quiet layout before starting the actual capture window.
    const started = Date.now();
    let quietSince = started, before = await inspect('begin');
    while (Date.now() - started < 500 || Date.now() - quietSince < 250) {
      if (Date.now() - started > 2000) throw new Error('browser_screenshot_changed');
      await bounded(new Promise<void>(resolve => setTimeout(resolve, 75)), deadline);
      valid();
      try {
        const next = await inspect('check');
        if (JSON.stringify(next) !== JSON.stringify(before)) throw new Error('browser_screenshot_changed');
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'browser_screenshot_changed') throw error;
        before = await inspect('begin'); quietSince = Date.now();
      }
    }
    // Capture the actual viewport without a clip. Chrome applies page zoom to
    // clipped capture differently from DOM CSS rectangles, padding the bitmap
    // and misaligning masks. The default viewport capture preserves native pixels.
    if (!Number.isFinite(before.dpr) || before.dpr <= 0 || before.width * before.height * before.dpr ** 2 > 16_777_216) throw new Error('browser_screenshot_too_large');
    valid();
    const result = await bounded(chrome.debugger.sendCommand(attached, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    }), deadline) as { data?: unknown } | undefined;
    valid();
    const after = await inspect('check');
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('browser_screenshot_changed');
    if (typeof result?.data !== 'string' || result.data.length > 32 * 1024 * 1024) throw new Error('browser_screenshot_too_large');
    const binary = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
    const bitmap = await bounded(createImageBitmap(new Blob([binary], { type: 'image/png' })), deadline, bitmap => bitmap.close());
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_777_216
        || Math.abs(bitmap.width / bitmap.height - before.width / before.height) > .02) throw new Error('browser_screenshot_invalid');
      let scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      for (let attempt = 0; attempt < 4; attempt++, scale *= .8) {
        valid();
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('browser_screenshot_unavailable');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        context.fillStyle = '#171b24';
        for (const rect of before.regions) {
          const x = Math.floor(rect.x / before.width * canvas.width), y = Math.floor(rect.y / before.height * canvas.height);
          context.fillRect(x, y, Math.ceil((rect.x + rect.width) / before.width * canvas.width) - x,
            Math.ceil((rect.y + rect.height) / before.height * canvas.height) - y);
        }
        const blob = await bounded(canvas.convertToBlob({ type: 'image/jpeg', quality: .82 }), deadline);
        if (blob.size > SCREENSHOT_MAX_BYTES) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let encoded = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        valid();
        if (JSON.stringify(await inspect('check')) !== JSON.stringify(before)) throw new Error('browser_screenshot_changed');
        valid();
        const screenshot = parseScreenshot({ kind: 'screenshot', mimeType: 'image/jpeg', data: btoa(encoded), width: canvas.width,
          height: canvas.height, origin: target.origin, redactedRegions: before.regions.length });
        completed = true; return screenshot;
      }
      throw new Error('browser_screenshot_too_large');
    } finally { bitmap.close(); }
  } finally {
    await inspect('end').catch(() => {});
    if (completed) lease.release(); else await lease.close();
  }
}
