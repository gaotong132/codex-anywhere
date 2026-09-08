import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { runPageAgent } from '../src/page-agent.js';

function fixture(rootOverflow: string, bodyOverflow: string, wrapperDisplay = 'block', containment = '') {
  const { document, window } = parseHTML('<html><body><div id="wrapper"><button>Visible bottom action</button></div><div id="panel"><p>Clipped panel content</p></div><div hidden>Private hidden</div></body></html>');
  document.documentElement.style.cssText = `overflow-x:${rootOverflow};overflow-y:${rootOverflow};contain:${containment}`;
  document.body.style.cssText = `overflow-x:${bodyOverflow};overflow-y:${bodyOverflow}`;
  document.querySelector('#wrapper')!.setAttribute('style', `display:${wrapperDisplay};overflow-x:hidden;overflow-y:hidden`);
  document.querySelector('#panel')!.setAttribute('style', 'overflow-x:hidden;overflow-y:hidden');
  for (const element of document.querySelectorAll('*')) {
    const top = ['HTML', 'BODY'].includes(element.tagName) ? -840 : element.id === 'panel' ? 100 : 560;
    const height = ['HTML', 'BODY'].includes(element.tagName) ? 800 : 40;
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => ({ x: 10, y: top, top, bottom: top + height, left: 10, right: 210, width: 200, height,
      ...(element.id === 'wrapper' && wrapperDisplay === 'contents' ? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } : {}) }) });
  }
  const context = createContext({ document, location: new URL('https://example.com'), crypto, URL,
    __name: (value: unknown) => value,
    Node: { TEXT_NODE: 3 }, innerHeight: 800, innerWidth: 1200, window: { scrollX: 0, scrollY: 840 },
    HTMLInputElement: window.HTMLInputElement, HTMLSelectElement: window.HTMLSelectElement,
    getComputedStyle: (element: HTMLElement) => ({ display: element.style.display || 'block', visibility: 'visible', opacity: '1',
      overflowX: element.style.overflowX || 'visible', overflowY: element.style.overflowY || 'visible', contain: element.style.contain || 'none', cursor: 'auto' }) });
  const run = (method: string) => {
    context.input = { grantId: 'fixture', origin: 'https://example.com', deadline: Date.now() + 5000, operation: { method } };
    return runInContext(`(${runPageAgent.toString()})(input)`, context);
  };
  assert.equal(run('authorize').authorized, true);
  const snapshot = run('snapshot');
  assert.ok(snapshot.nodes, JSON.stringify(snapshot));
  return snapshot;
}

test('document scrolling retains visible controls under viewport overflow and boxless wrappers', () => {
  for (const options of [['auto', 'visible'], ['visible', 'auto'], ['visible', 'visible', 'contents']]) {
    const snapshot = fixture(options[0], options[1], options[2]);
    assert.ok(snapshot.nodes.some((node: any) => node.text === 'Visible bottom action'), JSON.stringify({ options, snapshot }));
    assert.doesNotMatch(JSON.stringify(snapshot.nodes), /Clipped panel content|Private hidden/);
    assert.equal(snapshot.viewport.scrollY, 840); assert.equal(snapshot.viewport.height, 800);
  }
});

test('a body that owns its clipping box still hides content outside it', () => {
  for (const options of [['auto', 'hidden', ''], ['visible', 'hidden', 'paint']]) {
    const snapshot = fixture(options[0], options[1], 'block', options[2]);
    assert.ok(!snapshot.nodes.some((node: any) => node.text === 'Visible bottom action'));
  }
});
