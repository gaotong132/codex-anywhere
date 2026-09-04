import type { SnapshotOptions } from '../../src/browser-control/contracts.js';
import type { BrowserSnapshot } from '../../src/browser-control/readonly-controller.js';

// Self-contained: Chrome serializes this function for ISOLATED-world injection.
// No external helpers, page JS execution, field values, attributes, or network reads.
export function collectLocalSnapshot(options: SnapshotOptions, root: Document = document): BrowserSnapshot {
  const nodes: BrowserSnapshot['nodes'] = [];
  const maxNodes = Math.max(1, Math.min(200, options.maxNodes));
  const maxChars = Math.max(1, Math.min(16_000, options.maxChars));
  const result: BrowserSnapshot = { origin: root.location.origin, nodes, truncated: false };
  if (!root.body) return result;
  const excluded = 'script,style,noscript,template,iframe,input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[data-anywhere-private]';
  const walker = root.createTreeWalker(root.body, 0xFFFFFFFF);
  let visited = 0;
  let chars = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++visited > 5_000) { result.truncated = true; break; }
    if (node.nodeType !== 3) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    let hidden = false;
    let depth = 0;
    for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
      if (++depth > 64) { hidden = true; result.truncated = true; break; }
      if (ancestor.matches(excluded)) { hidden = true; break; }
      const style = root.defaultView?.getComputedStyle?.(ancestor);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') {
        hidden = true; break;
      }
    }
    if (hidden) continue;
    const remaining = maxChars - chars;
    const raw = node.textContent || '';
    const text = raw.slice(0, remaining + 1).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) {
      if (raw.length > remaining + 1) { result.truncated = true; break; }
      continue;
    }
    if (nodes.length >= maxNodes || remaining <= 0) { result.truncated = true; break; }
    nodes.push({ tag: parent.tagName.toLowerCase(), text: text.slice(0, remaining) });
    chars += nodes[nodes.length - 1].text.length;
    if (text.length > remaining || raw.length > remaining + 1) { result.truncated = true; break; }
  }
  return result;
}
