import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { runPageAgent } from '../src/page-agent.js';

test('dense snapshots reuse layout reads but never reuse them across snapshots or actions', () => {
  const { document, window } = parseHTML(`<html><body><main><section><div>${Array.from({ length: 80 }, (_, i) =>
    `<button><span>Action ${i}</span></button>`).join('')}</div></section></main></body></html>`);
  const styleReads = new Map<Element, number>(), rectReads = new Map<Element, number>();
  const count = (map: Map<Element, number>, element: Element) => map.set(element, (map.get(element) || 0) + 1);
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => {
      count(rectReads, element);
      return { top: 10, bottom: 40, left: 10, right: 200, width: 190, height: 30 };
    } });
  }
  const context = createContext({ document, location: new URL('https://example.com'), crypto, URL,
    __name: (value: unknown) => value, Node: { TEXT_NODE: 3 }, innerWidth: 1200, innerHeight: 800,
    window: { scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    HTMLInputElement: window.HTMLInputElement, HTMLSelectElement: window.HTMLSelectElement,
    getComputedStyle: (element: HTMLElement) => {
      count(styleReads, element);
      return { display: element.style.display || 'block', visibility: 'visible', opacity: '1', cursor: 'auto', overflowX: 'visible', overflowY: 'visible' };
    } });
  const run = (operation: object) => {
    context.input = { grantId: 'grant', origin: 'https://example.com', deadline: Date.now() + 5000, operation };
    return runInContext(`(${runPageAgent.toString()})(input)`, context);
  };
  run({ method: 'authorize' });
  const first = run({ method: 'snapshot' });
  assert.equal(first.nodes.filter((n: any) => n.ref).length, 80);
  assert.equal(Math.max(...styleReads.values()), 1, 'shared ancestors are not repeatedly styled in one snapshot');
  assert.equal(Math.max(...rectReads.values()), 1, 'layout rectangles are read once per element');
  const firstButton = document.querySelector('button')!;
  firstButton.style.display = 'none';
  assert.equal(run({ method: 'click', ref: first.nodes[0].ref }).errorCode, 'browser_stale_element_read_again');
  const second = run({ method: 'snapshot' });
  assert.equal(second.nodes.filter((n: any) => n.ref).length, 79);
  assert.ok(!second.nodes.some((n: any) => n.text === 'Action 0'));
  assert.ok([...styleReads.values()].some(n => n > 1), 'later operations re-read live style');
});
