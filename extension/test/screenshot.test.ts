import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import sharp from 'sharp';
import { captureScreenshot, inspectScreenshot } from '../src/screenshot.js';

const target = { tabId: 17, documentId: 'exact-document', origin: 'https://example.com', browserDeviceId: 'fixture' };
const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer();

function inspector(t: test.TestContext) {
  const { document } = parseHTML('<html><body><h1>Public chart</h1><input id="field"><iframe></iframe><div data-anywhere-private></div><div id="shadow"></div><div id="api-token"></div></body></html>');
  document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
  Object.defineProperty(document.querySelector('input'), 'value', { get: () => assert.fail('must not read a form value') });
  for (const [index, element] of [...document.querySelectorAll('*')].entries()) {
    Object.defineProperty(element, 'getClientRects', { value: () => [{ left: 10, top: index * 40, right: 110, bottom: index * 40 + 30, width: 100, height: 30 }] });
  }
  let mutation = () => {}, disconnected = 0;
  const window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 120, devicePixelRatio: 2,
    visualViewport: { width: 800, height: 600, scale: 1, offsetLeft: 0, offsetTop: 0 } });
  const context = createContext({ document, window, location: new URL(target.origin), __anywhereBrowser: { grantId: 'grant' },
    __name: (value: unknown) => value, setTimeout, clearTimeout,
    MutationObserver: class { constructor(callback: () => void) { mutation = callback; } observe() {} disconnect() { disconnected++; } } });
  const run = (phase = 'begin', extra = {}) => {
    context.input = { grantId: 'grant', origin: target.origin, token: 'token', deadline: Date.now() + 1000, phase, ...extra };
    return JSON.parse(JSON.stringify(runInContext(`(${inspectScreenshot.toString()})(input)`, context)));
  };
  t.after(() => run('end'));
  return { run, window, mutate: () => mutation(), disconnected: () => disconnected };
}

test('inspector masks field, iframe, private region, open shadow host and token label without reading values', t => {
  const h = inspector(t), view = h.run();
  assert.equal(view.width, 800); assert.equal(view.y, 120); assert.equal(view.dpr, 2);
  assert.equal(view.regions.length, 5);
  assert.deepEqual(view.regions[0], { x: 2, y: 112, width: 116, height: 46 });
  assert.deepEqual(h.run('check'), view);
  assert.deepEqual(h.run('end'), { ended: true }); assert.equal(h.disconnected(), 1);
  assert.match(h.run('check').errorCode, /screenshot_changed/);
});

test('inspector rejects stale grants, unsupported zoom, mutations and viewport/input changes', t => {
  const h = inspector(t);
  for (const extra of [{ grantId: 'other' }, { origin: 'https://other.example' }, { deadline: 1 }]) {
    assert.equal(h.run('begin', extra).errorCode, 'browser_document_changed');
  }
  h.window.visualViewport.scale = 1.5;
  assert.equal(h.run().errorCode, 'browser_screenshot_unavailable');
  h.window.visualViewport.scale = 1;
  h.run(); h.mutate(); assert.equal(h.run('check').errorCode, 'browser_screenshot_changed');
  for (const event of ['scroll', 'resize', 'input', 'change']) {
    h.run(); h.window.dispatchEvent(new Event(event)); assert.equal(h.run('check').errorCode, 'browser_screenshot_changed');
  }
  h.window.visualViewport.width = 9000;
  assert.equal(h.run().errorCode, 'browser_screenshot_too_large');
});

function capture(t: test.TestContext) {
  const saved = { chrome: globalThis.chrome, OffscreenCanvas: globalThis.OffscreenCanvas, createImageBitmap: globalThis.createImageBitmap };
  const calls: any[] = [], masks: number[][] = [];
  let permitted = true, current = true, attachFails = false, changed = false, oversized = false, failCommand = false, closed = 0;
  let onCapture = () => {}, onAttach = async () => {};
  const view = { width: 800, height: 600, x: 0, y: 120, dpr: 2, regions: [{ x: 20, y: 30, width: 100, height: 40 }] };
  globalThis.chrome = {
    permissions: { contains: async () => permitted },
    scripting: { executeScript: async (input: any) => {
      assert.deepEqual(input.target, { tabId: 17, documentIds: ['exact-document'] }); assert.equal(input.world, 'ISOLATED');
      const phase = input.args[0].phase; calls.push(phase);
      if (phase === 'begin') changed = false;
      return [{ documentId: target.documentId, result: phase === 'end' ? { ended: true }
        : phase === 'check' && changed ? { errorCode: 'browser_screenshot_changed' } : structuredClone(view) }];
    } },
    debugger: {
      attach: async (input: any) => { calls.push('attach'); assert.deepEqual(input, { tabId: 17 }); if (attachFails) throw Error('private debugger reason'); await onAttach(); },
      detach: async () => { calls.push('detach'); },
      sendCommand: async (input: any, method: string, params: any) => {
        assert.deepEqual(input, { tabId: 17 }); assert.equal(method, 'Page.captureScreenshot'); calls.push(params); onCapture();
        if (failCommand) throw Error('capture failed');
        return { data: 'aW1hZ2U=' };
      },
    },
  } as any;
  globalThis.createImageBitmap = (async () => ({ width: 800, height: 600, close: () => closed++ })) as any;
  globalThis.OffscreenCanvas = class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage() {}, fillRect: (...args: number[]) => masks.push(args), fillStyle: '' }; }
    async convertToBlob() { return new Blob([oversized ? Buffer.alloc(1024 * 1024 + 1) : jpeg], { type: 'image/jpeg' }); }
  } as any;
  t.after(() => Object.assign(globalThis, saved));
  return { calls, masks, run: (budget = 5000) => captureScreenshot(target, 'grant', Date.now() + budget, () => current),
    permission: (value: boolean) => { permitted = value; }, attachFailure: () => { attachFails = true; }, revoke: () => { current = false; },
    change: () => { changed = true; }, resize: () => { changed = true; view.x = 10; }, tooLarge: () => { oversized = true; }, commandFailure: () => { failCommand = true; },
    captured: (fn: () => void) => { onCapture = fn; }, attaching: (fn: () => Promise<void>) => { onAttach = fn; }, closed: () => closed };
}

test('capture targets the granted tab, clips its scrolled viewport, masks before JPEG output and detaches', async t => {
  const h = capture(t), result = await h.run();
  assert.equal(result.width, 800); assert.equal(result.height, 600); assert.equal(result.redactedRegions, 1);
  assert.equal(result.data, jpeg.toString('base64'));
  const params = h.calls.find(item => typeof item === 'object');
  assert.equal(params.captureBeyondViewport, false);
  assert.deepEqual(params.clip, { x: 0, y: 120, width: 800, height: 600, scale: 1 });
  assert.deepEqual(h.masks, [[20, 30, 100, 40]]); assert.equal(h.closed(), 1); assert.equal(h.calls.at(-1), 'detach');
});

test('permission denial or an attach conflict takes no image and leaves other debugger sessions alone', async t => {
  const h = capture(t); h.permission(false);
  await assert.rejects(h.run(), /screenshot_permission_required/); assert.equal(h.calls.length, 0);
  h.permission(true); h.attachFailure();
  await assert.rejects(h.run(), { message: 'browser_screenshot_unavailable' });
  assert.ok(!h.calls.includes('detach')); assert.ok(!h.calls.some(item => typeof item === 'object'));
});

test('in-flight changes or opt-out discard the image and detach without encoding', async t => {
  const h = capture(t); h.captured(() => h.change());
  await assert.rejects(h.run(), /screenshot_changed/);
  assert.equal(h.masks.length, 0); assert.equal(h.calls.at(-1), 'detach');
});

test('delayed layout changes after attach settle before capturing the final viewport', async t => {
  const h = capture(t);
  h.attaching(async () => { setTimeout(() => h.resize(), 100); });
  await h.run();
  assert.equal(h.calls.find(item => typeof item === 'object').clip.x, 10);
  assert.equal(h.calls.filter(item => typeof item === 'object').length, 1, 'only one screenshot is taken');
});

test('a failed browser capture releases the scoped debugger without encoding an image', async t => {
  const h = capture(t); h.commandFailure();
  await assert.rejects(h.run(), /capture failed/);
  assert.equal(h.calls.at(-1), 'detach'); assert.equal(h.masks.length, 0);
});

test('revocation during capture discards pixels before encoding', async t => {
  const h = capture(t); h.captured(() => h.revoke());
  await assert.rejects(h.run(), /document_changed/);
  assert.equal(h.masks.length, 0); assert.equal(h.calls.at(-1), 'detach');
});

test('oversized output has bounded retries and always releases bitmap and debugger', async t => {
  const h = capture(t); h.tooLarge();
  await assert.rejects(h.run(), /screenshot_too_large/);
  assert.equal(h.masks.length, 4); assert.equal(h.closed(), 1); assert.equal(h.calls.at(-1), 'detach');
});

test('an attach completing after deadline is detached without taking a late screenshot', async t => {
  const h = capture(t); let release!: () => void;
  h.attaching(() => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(h.run(30), /screenshot_unavailable/);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.at(-1), 'detach'); assert.ok(!h.calls.some(item => typeof item === 'object'));
});
