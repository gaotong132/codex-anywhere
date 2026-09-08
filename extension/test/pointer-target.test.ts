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
  const listeners = new Set<(event: any) => void>();
  const context = createContext({ document, location: new URL('https://example.com'), crypto, URL, setTimeout, clearTimeout,
    __name: (value: unknown) => value, Node: { TEXT_NODE: 3 }, innerHeight: 800, innerWidth: 1200,
    window: { scrollX: 0, scrollY: 0,
      addEventListener: (_: string, fn: (event: any) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (event: any) => void) => listeners.delete(fn) }, HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement, HTMLAnchorElement: window.HTMLAnchorElement,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible', cursor: 'auto' }) });
  const run = (operation: object, clickPhase?: Parameters<typeof runPageAgent>[0]['clickPhase']) => {
    context.input = { grantId: 'fixture', origin: 'https://example.com', deadline: Date.now() + 5000, operation, clickPhase };
    return runInContext(`(${runPageAgent.toString()})(input)`, context);
  };
  run({ method: 'authorize' });
  const snapshot = run({ method: 'snapshot' });
  const ref = snapshot.nodes.find((node: any) => node.text === 'Open details').ref;
  return { button, document, hit: (element: Element | null) => { hit = element; },
    hover: (x: number, y: number, target: Element | null = button, trusted = true) => {
      for (const fn of listeners) fn({ isTrusted: trusted, clientX: x, clientY: y, composedPath: () => [target] });
    }, listeners, snapshot: () => run({ method: 'snapshot' }),
    click: (phase?: Parameters<typeof runPageAgent>[0]['clickPhase']) => run({ method: 'click', ref }, phase) };
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

test('native hover proof requires the trusted event to reach the expected point and target', () => {
  for (const mode of ['match', 'offset', 'other-target', 'synthetic-event', 'missing-event']) {
    const h = fixture(); h.click(); h.click('arm');
    assert.equal(h.listeners.size, 1);
    if (mode !== 'missing-event') h.hover(mode === 'offset' ? 80 : 100, 40,
      mode === 'other-target' ? h.document.body : h.button, mode !== 'synthetic-event');
    const result = h.click('hover');
    assert.equal(result.pointerMismatch === true, mode !== 'match', mode);
    assert.equal(h.listeners.size, 0);
    const evidence = JSON.parse(JSON.stringify(h.snapshot().lastPointer));
    assert.deepEqual(evidence.expected, { x: 100, y: 40 });
    assert.doesNotMatch(JSON.stringify(evidence), /Open details|button|example/);
  }
});

test('observer cleanup works after refs were consumed or an operation failed', () => {
  const h = fixture(); h.click(); h.click('arm'); h.click('consume');
  assert.deepEqual(JSON.parse(JSON.stringify(h.click('end'))), { ended: true });
  assert.equal(h.listeners.size, 0);
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
