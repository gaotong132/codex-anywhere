import type { BrowserOperation } from '../../src/browser-control/operations.js';

// Serialized by Chrome: all runtime dependencies must remain INSIDE this function.
// ISOLATED world state cannot be set/read by the website's JavaScript.
export function runPageAgent(input: { grantId: string; origin: string; deadline: number; operation: BrowserOperation | { method: 'authorize' } | { method: 'revoke' } }) {
  type State = { grantId: string; refs: Map<string, { element: Element; html: string }>; snapshot: string };
  const scope = globalThis as typeof globalThis & { __anywhereBrowser?: State };
  if (location.origin !== input.origin || Date.now() > input.deadline) throw new Error('browser_document_changed');
  if (input.operation.method === 'authorize') { scope.__anywhereBrowser = { grantId: input.grantId, refs: new Map(), snapshot: '' }; return { authorized: true }; }
  const state = scope.__anywhereBrowser;
  if (!state || state.grantId !== input.grantId) throw new Error('browser_not_authorized');
  if (input.operation.method === 'revoke') { delete scope.__anywhereBrowser; return { authorized: false }; }
  const excluded = 'script,style,noscript,iframe,object,embed,[hidden],[inert],[aria-hidden="true"],[data-anywhere-private]';
  const sensitive = (element: Element) => {
    const hint = ['type', 'name', 'id', 'autocomplete', 'aria-label'].map((key) => element.getAttribute(key) || '').join(' ');
    return /password|passwd|secret|token|credit|cc-|card.?number|one-time-code|otp|cvv|cvc|social.?security/i.test(hint);
  };
  const visible = (element: Element) => {
    if (element.closest(excluded) || element.closest('[contenteditable]')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    let depth = 0;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      if (++depth > 64) return false;
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  if (input.operation.method === 'snapshot') {
    state.refs.clear(); state.snapshot = crypto.randomUUID();
    const nodes: { ref?: string; tag: string; text: string }[] = [];
    let chars = 0; let visited = 0; let truncated = false;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      if (++visited > 5000 || nodes.length >= 100 || chars >= 8000) { truncated = true; break; }
      const element = walker.currentNode as Element;
      if (!visible(element) || sensitive(element) || element.parentElement?.closest('textarea,select')) continue;
      const actionable = element.matches('a[href],button,input,textarea,select,[role="button"]');
      // Never read form values. Only direct text nodes, not hidden descendant textContent.
      const directText = element.matches('input,textarea,select') ? '' : [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => (node.textContent || '').slice(0, 8001)).join(' ').slice(0, 8001);
      const text = (element.getAttribute('aria-label') || (actionable ? element.getAttribute('placeholder') : '') || directText).slice(0, 8001).replace(/\s+/g, ' ').trim();
      if (!actionable && !text) continue;
      const ref = actionable ? `${state.snapshot}:${nodes.length}` : undefined;
      if (ref) state.refs.set(ref, { element, html: element.outerHTML });
      const bounded = text.slice(0, Math.min(500, 8000 - chars)); chars += bounded.length;
      if (bounded.length < text.length) truncated = true;
      nodes.push({ ...(ref ? { ref } : {}), tag: element.tagName.toLowerCase(), text: bounded });
    }
    return { origin: location.origin, nodes, truncated };
  }
  if (input.operation.method === 'scroll') {
    window.scrollBy({ top: input.operation.deltaY, behavior: 'instant' }); return { scrolled: true };
  }
  const entry = state.refs.get(input.operation.ref);
  if (!entry || !entry.element.isConnected || !visible(entry.element) || entry.html !== entry.element.outerHTML || sensitive(entry.element)) throw new Error('browser_stale_element_read_again');
  const element = entry.element as HTMLElement;
  if (element.matches(':disabled,[aria-disabled="true"],input[type="file"],input[type="password"],input[type="hidden"]')) throw new Error('browser_element_not_allowed');
  if (input.operation.method === 'open_link' || (input.operation.method === 'click' && element instanceof HTMLAnchorElement && element.target === '_blank')) {
    if (!(element instanceof HTMLAnchorElement) || element.hasAttribute('download')) throw new Error('browser_link_required');
    const url = new URL(element.href);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.origin !== input.origin) return { denied: 'browser_child_origin_denied' as const };
    state.refs.clear();
    // The worker creates exactly this tab and records its identity. Do not click
    // website handlers/window.open and then guess which tab they opened.
    return { openInNewTab: url.href };
  }
  if (input.operation.method === 'click') {
    if (element instanceof HTMLAnchorElement && (!/^https?:$/.test(new URL(element.href).protocol) || element.target === '_blank' || element.hasAttribute('download'))) throw new Error('browser_navigation_not_allowed');
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
    if (!hit || (hit !== element && !element.contains(hit))) throw new Error('browser_element_obscured');
    element.click(); state.refs.clear(); return { clicked: true };
  }
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.readOnly
    || (element instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel'].includes(element.type))) throw new Error('browser_input_not_allowed');
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, input.operation.text);
  element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  state.refs.clear(); return { filled: true };
}
