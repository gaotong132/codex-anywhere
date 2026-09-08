import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { runPageAgent } from '../src/page-agent.js';

function fixture(markup: string) {
  const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
  const rect = { top: 20, bottom: 60, left: 20, right: 220, width: 200, height: 40 };
  for (const element of document.querySelectorAll('*')) element.getBoundingClientRect = (() => rect) as any;
  let hit: (x: number, y: number) => Element | null = () => null;
  document.elementFromPoint = ((x: number, y: number) => hit(x, y)) as any;
  const context = createContext({ document, location: new URL('https://example.com'), crypto, URL,
    __name: (value: unknown) => value, Node: { TEXT_NODE: 3 }, innerHeight: 800, innerWidth: 1200,
    window: { scrollX: 0, scrollY: 0 }, HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement, HTMLAnchorElement: window.HTMLAnchorElement,
    getComputedStyle: (element: HTMLElement) => ({ display: element.style.display || 'block',
      visibility: 'visible', opacity: element.style.opacity || '1',
      overflowX: element.style.overflowX || 'visible', overflowY: element.style.overflowY || 'visible',
      cursor: element.style.cursor || element.parentElement?.style.cursor || 'auto' }) });
  const run = (operation: object) => {
    context.input = { grantId: 'fixture', origin: 'https://example.com', deadline: Date.now() + 5000, operation };
    return runInContext(`(${runPageAgent.toString()})(input)`, context);
  };
  run({ method: 'authorize' });
  return { document, run, hit: (fn: typeof hit) => { hit = fn; }, read: () => run({ method: 'snapshot' }) };
}

test('opening a composite dropdown avoids its nested remove button', () => {
  for (const role of ['', ' role="combobox"']) {
    const h = fixture(`<div id="picker"${role} style="cursor:pointer">West <button>Remove West</button></div>`);
    const picker = h.document.querySelector('#picker')!, remove = h.document.querySelector('button')!;
    h.hit(x => x < 160 ? remove : picker);
    const ref = h.read().nodes.find((n: any) => n.tag === 'div' && n.ref).ref;
    const result = h.run({ method: 'click', ref });
    assert.ok(result.clickPoint.x >= 160, JSON.stringify(result));
  }
});

test('unlabeled custom remove icons are not treated as dropdown decoration', () => {
  const h = fixture('<div id="picker" style="cursor:pointer">West<section id="remove" style="cursor:pointer"></section></div>');
  const picker = h.document.querySelector('#picker')!, remove = h.document.querySelector('#remove')!;
  h.hit(x => x < 160 ? remove : picker);
  const ref = h.read().nodes.find((n: any) => n.tag === 'div').ref;
  assert.ok(h.run({ method: 'click', ref }).clickPoint.x >= 160);
});

test('a parent fully covered by nested actions cannot redirect a click into them', () => {
  const h = fixture('<div style="cursor:pointer">Item<button>Delete item</button></div>');
  h.hit(() => h.document.querySelector('button'));
  const snapshot = h.read(), parent = snapshot.nodes.find((n: any) => n.tag === 'div');
  assert.equal(h.run({ method: 'click', ref: parent.ref }).errorCode, 'browser_element_obscured');
  const child = snapshot.nodes.find((n: any) => n.tag === 'button');
  assert.ok(h.run({ method: 'click', ref: child.ref }).clickPoint);
});

test('native button decorative icons still receive the intended click', () => {
  const h = fixture('<button>Save<span style="cursor:pointer"></span></button>');
  h.hit(() => h.document.querySelector('span'));
  const ref = h.read().nodes.find((n: any) => n.tag === 'button').ref;
  assert.ok(h.run({ method: 'click', ref }).clickPoint);
});

test('browser hit testing recovers visible overflow descendants but never hidden or covered content', () => {
  for (const hidden of ['', 'hidden', 'data-anywhere-private', 'style="opacity:0"']) {
    const h = fixture(`<div style="overflow-y:hidden"><section ${hidden}><button>Visible action</button></section></div>`);
    const wrapper = h.document.querySelector('div')!, button = h.document.querySelector('button')!;
    wrapper.getBoundingClientRect = (() => ({ top: 0, bottom: 1, left: 0, right: 300, width: 300, height: 1 })) as any;
    h.hit(() => button);
    assert.equal(h.read().nodes.some((n: any) => n.text === 'Visible action'), hidden === '');
    h.hit(() => h.document.body);
    assert.ok(!h.read().nodes.some((n: any) => n.text === 'Visible action'));
  }
});

test('visible exclusion diagnostics are bounded and contain no excluded labels or attributes', () => {
  const h = fixture(Array.from({ length: 8 }, (_, i) => `<section aria-hidden="true" data-label="private-${i}"><button>private-label-${i}</button></section>`).join(''));
  const snapshot = h.read();
  assert.equal(snapshot.excludedVisibleBranches.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.excludedVisibleBranches[0])), { tag: 'section', reason: 'aria-hidden', beforeNode: 0 });
  assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
});
