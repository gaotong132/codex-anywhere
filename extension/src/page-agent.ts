import type { BrowserOperation } from '../../src/browser-control/operations.js';

// Serialized by Chrome: all runtime dependencies must remain INSIDE this function.
// ISOLATED world state cannot be set/read by the website's JavaScript.
export function runPageAgent(input: { grantId: string; origin: string; deadline: number; operation: BrowserOperation | { method: 'authorize' } | { method: 'revoke' } }) {
  // Chrome may otherwise drop an injected function's exception and return no result.
  // Background and broker independently allowlist these codes before forwarding them.
  try { return perform(); }
  catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { errorCode: /^browser_[a-z_]+$/.test(code) ? code : 'browser_operation_failed' };
  }

  function perform() {
    type State = { grantId: string; refs: Map<string, { element: Element; html?: string; scrollOnly?: boolean }>; snapshot: string };
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
      let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      if (rect.width <= 0 || rect.height <= 0 || bottom <= top || right <= left) return false;
      let depth = 0;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (++depth > 64) return false;
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (ancestor !== element) {
          const bounds = ancestor.getBoundingClientRect();
          if (/auto|scroll|hidden|clip|overlay/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
          if (/auto|scroll|hidden|clip|overlay/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (bottom <= top || right <= left) return false;
        }
      }
      return true;
    };
    const scrollable = (element: Element) => element !== document.body && element !== document.documentElement
      && element.scrollHeight > element.clientHeight && /auto|scroll|overlay/.test(getComputedStyle(element).overflowY);
    const directText = (element: Element) => element.matches('input,textarea,select') ? '' : [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => (node.textContent || '').slice(0, 8001)).join(' ').slice(0, 8001);
    const labelText = (element: Element) => {
      let result = directText(element), visited = 0;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
      while (result.length < 500 && visited++ < 100 && walker.nextNode()) {
        const child = walker.currentNode as Element;
        if (visible(child) && !sensitive(child) && !child.closest('input,textarea,select')) result += ' ' + directText(child);
      }
      return result.slice(0, 8001).replace(/\s+/g, ' ').trim();
    };
    if (input.operation.method === 'snapshot') {
      state.refs.clear(); state.snapshot = crypto.randomUUID();
      const nodes: { ref?: string; tag: string; text: string; role?: string; inputType?: string; disabled?: boolean; checked?: boolean | 'mixed'; expanded?: boolean; scrollable?: boolean }[] = [];
      let chars = 0; let visited = 0; let truncated = false;
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        if (++visited > 5000 || nodes.length >= 100 || chars >= 8000) { truncated = true; break; }
        const element = walker.currentNode as Element;
        if (!visible(element) || sensitive(element) || element.parentElement?.closest('textarea,select')) continue;
        const actionable = element.matches('a[href],button,input,textarea,select,[role="button"],[role="combobox"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"]');
        const canScroll = scrollable(element);
        const labels = element.matches('input,textarea,select') ? [...((element as HTMLInputElement).labels ?? [])]
          .filter((label) => visible(label) && !sensitive(label)).map(labelText).join(' ') : '';
        // Never read form values; actionable descendants supply button/option labels.
        const text = (element.getAttribute('aria-label') || labels || (actionable ? element.getAttribute('placeholder') : '')
          || (actionable ? labelText(element) : directText(element))).slice(0, 8001).replace(/\s+/g, ' ').trim();
        if (!actionable && !canScroll && !text) continue;
        const ref = actionable || canScroll ? `${state.snapshot}:${nodes.length}` : undefined;
        // Scroll-only regions can contain large, frequently changing subtrees.
        if (ref) state.refs.set(ref, { element, ...(actionable ? { html: element.outerHTML } : { scrollOnly: true }) });
        const bounded = text.slice(0, Math.min(500, 8000 - chars)); chars += bounded.length;
        if (bounded.length < text.length) truncated = true;
        const role = element.getAttribute('role')?.slice(0, 40);
        const checked = element.getAttribute('aria-checked');
        const expanded = element.getAttribute('aria-expanded');
        nodes.push({ ...(ref ? { ref } : {}), tag: element.tagName.toLowerCase(), text: bounded,
          ...(role ? { role } : {}), ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
          ...(actionable ? { disabled: element.matches(':disabled,[aria-disabled="true"]') } : {}),
          ...(element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? { checked: element.checked }
            : ['true', 'false', 'mixed'].includes(checked ?? '') ? { checked: checked === 'mixed' ? 'mixed' : checked === 'true' } : {}),
          ...(['true', 'false'].includes(expanded ?? '') ? { expanded: expanded === 'true' } : {}),
          ...(canScroll ? { scrollable: true } : {}) });
      }
      return { origin: location.origin, nodes, truncated };
    }
    if (input.operation.method === 'scroll' && input.operation.ref === undefined) {
      const before = window.scrollY;
      window.scrollBy({ top: input.operation.deltaY, behavior: 'instant' }); state.refs.clear();
      return { scrolled: window.scrollY !== before, target: 'page' };
    }
    const entry = state.refs.get(input.operation.ref!);
    if (!entry || !entry.element.isConnected || !visible(entry.element)
      || (entry.html !== undefined && entry.html !== entry.element.outerHTML) || sensitive(entry.element)) throw new Error('browser_stale_element_read_again');
    const element = entry.element as HTMLElement;
    if (input.operation.method === 'scroll') {
      if (!scrollable(element)) throw new Error('browser_scroll_target_not_scrollable');
      const before = element.scrollTop;
      element.scrollTop += input.operation.deltaY; state.refs.clear();
      return { scrolled: element.scrollTop !== before, target: 'element' };
    }
    if (entry.scrollOnly || element.matches(':disabled,[aria-disabled="true"],input[type="file"],input[type="password"],input[type="hidden"]')) throw new Error('browser_element_not_allowed');
    if (input.operation.method === 'open_link' || (input.operation.method === 'click' && element instanceof HTMLAnchorElement)) {
      if (!(element instanceof HTMLAnchorElement) || element.hasAttribute('download')) throw new Error('browser_link_required');
      const url = new URL(element.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('browser_navigation_not_allowed');
      state.refs.clear();
      // The worker creates exactly this tab; do not adopt unsolicited website popups.
      return { openInNewTab: url.href };
    }
    if (input.operation.method === 'click') {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
      if (!hit || (hit !== element && !element.contains(hit))) throw new Error('browser_element_obscured');
      if (element instanceof HTMLSelectElement) {
        const options: { label: string; disabled: boolean }[] = [];
        let chars = 0; let truncated = false;
        for (const option of element.options) {
          if (option.hidden || option.closest('optgroup[hidden]')) continue;
          if (options.length >= 50 || chars >= 8000) { truncated = true; break; }
          const text = option.label.replace(/\s+/g, ' ').trim();
          const label = text.slice(0, Math.min(500, 8000 - chars)); chars += label.length;
          if (label.length < text.length) truncated = true;
          options.push({ label, disabled: option.disabled || Boolean(option.closest('optgroup[disabled]')) });
        }
        state.refs.clear(); return { options, truncated };
      }
      element.click(); state.refs.clear(); return { clicked: true };
    }
    const fillText = input.operation.text;
    if (element instanceof HTMLSelectElement) {
      if (element.multiple) throw new Error('browser_select_multiple_not_supported');
      const matches = [...element.options].filter((option) => !option.disabled && !option.hidden && !option.closest('optgroup[disabled],optgroup[hidden]')
        && option.label.replace(/\s+/g, ' ').trim() === fillText);
      if (matches.length !== 1) throw new Error('browser_option_not_available');
      element.selectedIndex = [...element.options].indexOf(matches[0]);
    } else {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.readOnly
        || (element instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type))) throw new Error('browser_input_not_allowed');
      if (element instanceof HTMLInputElement && element.type === 'number') {
        const probe = element.cloneNode(false) as HTMLInputElement;
        probe.value = fillText;
        if ((fillText !== '' && probe.value === '') || !probe.validity.valid) throw new Error('browser_number_value_invalid');
      }
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, fillText);
    }
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    state.refs.clear(); return { filled: true };
  }
}
