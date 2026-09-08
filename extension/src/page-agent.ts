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
    const controlSelector = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="combobox"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"]';
    const focusControl = (element: HTMLElement) => {
      element.focus?.({ preventScroll: true });
      if (!element.isConnected) throw new Error('browser_stale_element_read_again');
    };
    const sensitive = (element: Element) => {
      const hint = ['type', 'name', 'id', 'autocomplete', 'aria-label'].map((key) => element.getAttribute(key) || '').join(' ');
      return /password|passwd|secret|token|credit|cc-|card.?number|one-time-code|otp|cvv|cvc|social.?security/i.test(hint);
    };
    const skipSubtree = (element: Element) => {
      if (element.matches(`${excluded},[contenteditable]`) || sensitive(element)) return true;
      const style = getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    };
    // Collapsed console menus can contain thousands of nodes. Skip their descendants,
    // but retain zero-size/offscreen wrappers whose children may still be visible.
    const nextElement = (element: Element, root: Element, skipChildren: boolean): Element | null => {
      if (!skipChildren && element.firstElementChild) return element.firstElementChild;
      for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
        if (node.nextElementSibling) return node.nextElementSibling;
      }
      return null;
    };
    // HTML/body overflow can belong to the viewport rather than their own box.
    // Their DOM rectangles move above the screen during document scrolling.
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = document.body ? getComputedStyle(document.body) : undefined;
    const bodyOverflowAtViewport = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
      && (!rootStyle.contain || rootStyle.contain === 'none') && (!bodyStyle?.contain || bodyStyle.contain === 'none');
    const visibleBox = (element: Element, rect = element.getBoundingClientRect()) => {
      if (element.closest(excluded) || element.closest('[contenteditable]')) return null;
      let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      if (rect.width <= 0 || rect.height <= 0 || bottom <= top || right <= left) return null;
      let depth = 0;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (++depth > 64) return null;
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
        if (ancestor !== element && ancestor !== document.documentElement && style.display !== 'contents'
          && !(ancestor === document.body && bodyOverflowAtViewport)) {
          const bounds = ancestor.getBoundingClientRect();
          if (/auto|scroll|hidden|clip|overlay/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
          if (/auto|scroll|hidden|clip|overlay/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (bottom <= top || right <= left) return null;
        }
      }
      return { top, bottom, left, right };
    };
    const visible = (element: Element) => visibleBox(element) !== null;
    const scrollAxes = (element: Element): ('x' | 'y')[] => {
      if (element === document.body || element === document.documentElement) return [];
      const style = getComputedStyle(element), axes: ('x' | 'y')[] = [];
      if (element.scrollWidth > element.clientWidth && /auto|scroll|overlay/.test(style.overflowX)) axes.push('x');
      if (element.scrollHeight > element.clientHeight && /auto|scroll|overlay/.test(style.overflowY)) axes.push('y');
      return axes;
    };
    const directText = (element: Element) => element.matches('input,textarea,select') ? '' : [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => (node.textContent || '').slice(0, 8001)).join(' ').slice(0, 8001);
    const labelText = (element: Element) => {
      if (element.matches('input,textarea,select')) return '';
      let result = directText(element), visited = 0;
      let next = element.firstElementChild;
      while (result.length < 500 && visited++ < 100 && next) {
        const child = next, skip = skipSubtree(child);
        next = nextElement(child, element, skip || child.matches('input,textarea,select'));
        if (!skip && visible(child) && !child.matches('input,textarea,select')) result += ' ' + directText(child);
      }
      return result.slice(0, 8001).replace(/\s+/g, ' ').trim();
    };
    if (input.operation.method === 'snapshot') {
      state.refs.clear(); state.snapshot = crypto.randomUUID();
      const viewport = { width: innerWidth, height: innerHeight, scrollX: window.scrollX, scrollY: window.scrollY,
        pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight };
      const nodes: { ref?: string; tag: string; text: string; role?: string; inputType?: string; disabled?: boolean; checked?: boolean | 'mixed'; expanded?: boolean; scrollable?: boolean; scrollAxes?: ('x' | 'y')[]; scrollPosition?: { x: number; y: number } }[] = [];
      let chars = 0; let visited = 0; let truncated = false;
      let truncationReason: 'scan_limit' | 'node_limit' | 'text_limit' | 'result_limit' | undefined;
      let resultSize = JSON.stringify({ origin: location.origin, viewport, nodes: [], truncated: true, scannedElements: 5000, truncationReason: 'result_limit' }).length;
      const root = document.body || document.documentElement;
      const representedLabels = new Map<Element, string>();
      let next = skipSubtree(root) ? null : root.firstElementChild;
      while (next) {
        if (visited >= 5000 || nodes.length >= 200 || chars >= 8000) {
          truncated = true; truncationReason = visited >= 5000 ? 'scan_limit' : nodes.length >= 200 ? 'node_limit' : 'text_limit'; break;
        }
        visited++;
        const element = next, skip = skipSubtree(element);
        next = nextElement(element, root, skip || element.matches('input,textarea,select'));
        if (skip || !visible(element)) continue;
        const semanticControl = element.matches(controlSelector);
        const explicitControl = semanticControl || (element.hasAttribute('tabindex') && (element as HTMLElement).tabIndex >= 0)
          || element.hasAttribute('onclick');
        const actionable = semanticControl || (!element.closest(controlSelector)
          && (explicitControl || getComputedStyle(element).cursor === 'pointer'));
        const axes = scrollAxes(element), canScroll = axes.length > 0;
        const labels = element.matches('input,textarea,select') ? [...((element as HTMLInputElement).labels ?? [])]
          .filter((label) => visible(label) && !sensitive(label)).map(labelText).join(' ') : '';
        // Never read form values; actionable descendants supply button/option labels.
        const text = (element.getAttribute('aria-label') || labels || (actionable ? element.getAttribute('placeholder') : '')
          || (actionable ? labelText(element) : directText(element))).slice(0, 8001).replace(/\s+/g, ' ').trim();
        if (!actionable && !canScroll && !text) continue;
        // The parent ref already carries nested button/link text. Keep independent
        // controls and scroll regions, without spending the output budget twice.
        if (!explicitControl && !canScroll) {
          let owner = element.parentElement;
          while (owner && !representedLabels.has(owner)) owner = owner.parentElement;
          if (owner && representedLabels.get(owner)!.includes(text)) continue;
        }
        const ref = actionable || canScroll ? `${state.snapshot}:${nodes.length}` : undefined;
        // Scroll-only regions can contain large, frequently changing subtrees.
        if (ref) state.refs.set(ref, { element, ...(actionable ? { html: element.outerHTML } : { scrollOnly: true }) });
        const bounded = text.slice(0, Math.min(500, 8000 - chars)); chars += bounded.length;
        if (actionable) representedLabels.set(element, bounded);
        if (bounded.length < text.length) { truncated = true; truncationReason = 'text_limit'; }
        const role = element.getAttribute('role')?.slice(0, 40);
        const checked = element.getAttribute('aria-checked');
        const expanded = element.getAttribute('aria-expanded');
        const node: (typeof nodes)[number] = { ...(ref ? { ref } : {}), tag: element.tagName.toLowerCase(), text: bounded,
          ...(role ? { role } : {}), ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
          ...(actionable ? { disabled: element.matches(':disabled,[aria-disabled="true"]') } : {}),
          ...(element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? { checked: element.checked }
            : ['true', 'false', 'mixed'].includes(checked ?? '') ? { checked: checked === 'mixed' ? 'mixed' : checked === 'true' } : {}),
          ...(['true', 'false'].includes(expanded ?? '') ? { expanded: expanded === 'true' } : {}),
          ...(canScroll ? { scrollable: true, scrollAxes: axes, scrollPosition: { x: element.scrollLeft, y: element.scrollTop } } : {}) };
        resultSize += JSON.stringify(node).length + 1;
        if (resultSize > 23_000) {
          if (ref) state.refs.delete(ref);
          truncated = true; truncationReason = 'result_limit'; break;
        }
        nodes.push(node);
      }
      return { origin: location.origin, viewport, nodes, truncated, scannedElements: visited, ...(truncationReason ? { truncationReason } : {}) };
    }
    if (input.operation.method === 'scroll' && input.operation.ref === undefined) {
      const beforeX = window.scrollX, beforeY = window.scrollY;
      window.scrollBy({ left: input.operation.deltaX ?? 0, top: input.operation.deltaY, behavior: 'instant' }); state.refs.clear();
      const deltaX = window.scrollX - beforeX, deltaY = window.scrollY - beforeY;
      return { scrolled: deltaX !== 0 || deltaY !== 0, target: 'page', deltaX, deltaY };
    }
    const entry = state.refs.get(input.operation.ref!);
    if (!entry || !entry.element.isConnected || !visible(entry.element)
      || (entry.html !== undefined && entry.html !== entry.element.outerHTML) || sensitive(entry.element)) throw new Error('browser_stale_element_read_again');
    const element = entry.element as HTMLElement;
    if (input.operation.method === 'scroll') {
      const axes = scrollAxes(element), requestedX = input.operation.deltaX ?? 0;
      if (!axes.length || (requestedX !== 0 && !axes.includes('x'))
        || (input.operation.deltaY !== 0 && !axes.includes('y'))) throw new Error('browser_scroll_target_not_scrollable');
      const beforeX = element.scrollLeft, beforeY = element.scrollTop;
      // Keep native coordinates and clamping, including negative scrollLeft in RTL.
      element.scrollBy({ left: requestedX, top: input.operation.deltaY, behavior: 'instant' }); state.refs.clear();
      const deltaX = element.scrollLeft - beforeX, deltaY = element.scrollTop - beforeY;
      return { scrolled: deltaX !== 0 || deltaY !== 0, target: 'element', deltaX, deltaY };
    }
    if (entry.scrollOnly || element.matches(':disabled,[aria-disabled="true"],input[type="file"],input[type="password"],input[type="hidden"]')) throw new Error('browser_element_not_allowed');
    if (input.operation.method === 'open_link' || (input.operation.method === 'click' && element instanceof HTMLAnchorElement && element.hasAttribute('href'))) {
      if (!(element instanceof HTMLAnchorElement) || !element.hasAttribute('href') || element.hasAttribute('download')) throw new Error('browser_link_required');
      const url = new URL(element.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('browser_navigation_not_allowed');
      state.refs.clear();
      // The worker creates exactly this tab; do not adopt unsolicited website popups.
      return { openInNewTab: url.href };
    }
    if (input.operation.method === 'click') {
      // A newly inserted anchor must not turn a generic control ref into an
      // unmanaged link click after the snapshot.
      if (element.closest('a[href]')) throw new Error('browser_stale_element_read_again');
      // Test a point inside a visible fragment, not the unclipped bounding box's
      // center (which can sit outside its panel or in a wrapped link's whitespace).
      const fragments = element.getClientRects ? [...element.getClientRects()].slice(0, 20) : [element.getBoundingClientRect()];
      const reachable = fragments.some((fragment) => {
        const box = visibleBox(element, fragment);
        if (!box) return false;
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        return hit !== null && (hit === element || element.contains(hit));
      });
      if (!reachable) throw new Error('browser_element_obscured');
      focusControl(element);
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
      focusControl(element);
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
      focusControl(element);
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, fillText);
    }
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    state.refs.clear(); return { filled: true };
  }
}
