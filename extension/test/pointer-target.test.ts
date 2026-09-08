import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { runPageAgent } from '../src/page-agent.js';

function fixture() {
  const { document, window } = parseHTML('<html><body><button>Open details</button></body></html>');
  const button = document.querySelector('button')!;
  const rect = () => ({ top: 20, bottom: 60, left: 20, right: 180, width: 160, height: 40 });
  for (const element of document.querySelectorAll('*')) element.getBoundingClientRect = rect as any;
  let hit: Element | null = button;
  document.elementFromPoint = () => hit as any;
  const context = createContext({ document, location: new URL('https://example.com'), crypto, URL,
    __name: (value: unknown) => value, Node: { TEXT_NODE: 3 }, innerHeight: 800, innerWidth: 1200,
    window: { scrollX: 0, scrollY: 0 }, HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement, HTMLAnchorElement: window.HTMLAnchorElement,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible', cursor: 'auto' }) });
  const run = (operation: object, clickPhase?: 'verify' | 'consume') => {
    context.input = { grantId: 'fixture', origin: 'https://example.com', deadline: Date.now() + 5000, operation, clickPhase };
    return runInContext(`(${runPageAgent.toString()})(input)`, context);
  };
  run({ method: 'authorize' });
  const snapshot = run({ method: 'snapshot' });
  const ref = snapshot.nodes.find((node: any) => node.text === 'Open details').ref;
  return { button, document, hit: (element: Element | null) => { hit = element; },
    click: (phase?: 'verify' | 'consume') => run({ method: 'click', ref }, phase) };
}

test('only an already prepared pointer click tolerates hover/focus styling; consuming invalidates refs', () => {
  const stale = fixture(); stale.button.className = 'changed-before-click';
  assert.equal(stale.click().errorCode, 'browser_stale_element_read_again');
  const h = fixture();
  assert.equal(h.click('verify').errorCode, 'browser_stale_element_read_again');
  assert.ok(h.click().clickPoint);
  h.button.className = 'hovered'; h.button.dataset.focused = 'true';
  assert.ok(h.click('verify').clickPoint);
  h.button.style.color = 'blue'; h.button.classList.add('pressed');
  assert.ok(h.click('consume').clickPoint);
  assert.equal(h.click('verify').errorCode, 'browser_stale_element_read_again');
});

test('pointer rechecks reject a changed label/action, replacement, disabled target and overlay', () => {
  const changes = [
    (h: ReturnType<typeof fixture>) => { h.button.textContent = 'Delete item'; },
    (h: ReturnType<typeof fixture>) => { h.button.setAttribute('formaction', '/delete'); },
    (h: ReturnType<typeof fixture>) => { h.button.replaceWith(h.button.cloneNode(true)); },
    (h: ReturnType<typeof fixture>) => { h.button.setAttribute('aria-disabled', 'true'); },
    (h: ReturnType<typeof fixture>) => { h.hit(h.document.body); },
  ];
  for (const change of changes) {
    const h = fixture(); assert.ok(h.click().clickPoint); change(h);
    assert.match(h.click('verify').errorCode, /^browser_(stale_element_read_again|element_not_allowed|element_obscured)$/);
  }
});
