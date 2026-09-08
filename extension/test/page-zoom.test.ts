import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { inspectZoom, zoomPage } from '../src/page-zoom.js';

const target = { browserDeviceId: 'browser', tabId: 7, documentId: 'doc-7', origin: 'https://example.com' };
function harness(t: test.TestContext) {
  let current = true, factor = 1, mode = 'automatic', scope = 'per-origin';
  let onCall: ((name: string) => void | Promise<void>) | undefined;
  const calls: string[] = [];
  const state = { grantId: 'grant', refs: new Map([['old-ref', {}]]), snapshot: 'old' };
  const context = createContext({ __anywhereBrowser: state, location: new URL(target.origin), innerWidth: 1200, innerHeight: 800, window: { devicePixelRatio: 1 } });
  const record = async (name: string, id: number) => { assert.equal(id, target.tabId); calls.push(name); await onCall?.(name); };
  const previous = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    scripting: { executeScript: async (options: any) => {
      await record('inspect', options.target.tabId); assert.deepEqual(options.target.documentIds, [target.documentId]); assert.equal(options.world, 'ISOLATED');
      context.args = options.args;
      return [{ documentId: target.documentId, result: runInContext(`(${options.func.toString()})(...args)`, context) }];
    } },
    tabs: {
      getZoom: async (id: number) => { await record('getZoom', id); return factor; },
      getZoomSettings: async (id: number) => { await record('getZoomSettings', id); return { mode, scope }; },
      setZoomSettings: async (id: number, settings: any) => { await record('setZoomSettings', id); assert.deepEqual(settings, { mode: 'automatic', scope: 'per-tab' }); scope = settings.scope; },
      setZoom: async (id: number, next: number) => { await record('setZoom', id); assert.equal(scope, 'per-tab'); factor = next; context.innerWidth = Math.round(1200 / factor); context.window.devicePixelRatio = factor; },
    },
  };
  t.after(() => { (globalThis as any).chrome = previous; });
  return { state, calls, context, revoke: () => { current = false; }, mode: (value: string) => { mode = value; }, hook: (fn: typeof onCall) => { onCall = fn; },
    zoom: (percent: number, deadline = Date.now() + 1000) => zoomPage(target, 'grant', percent, deadline, () => current) };
}

test('native zoom isolates the exact tab, reports real viewport and retires refs before changing layout', async t => {
  const h = harness(t);
  for (const percent of [80, 67, 125, 50, 200, 100]) {
    const result = await h.zoom(percent);
    assert.equal(result.zoomPercent, percent); assert.equal(result.scope, 'per-tab'); assert.equal(result.requiresSnapshot, true);
    assert.equal(result.viewport.width, Math.round(1200 / (percent / 100)));
    assert.equal(h.state.refs.size, 0); assert.equal(h.state.snapshot, '');
  }
  assert.ok(h.calls.indexOf('setZoomSettings') < h.calls.indexOf('setZoom'));
});

test('zoom denies stale grants, invalid percentages, expired calls and browser-controlled zoom modes before mutation', async t => {
  const h = harness(t);
  for (const value of [0, 49, 201, 80.5, NaN, Infinity]) await assert.rejects(h.zoom(value), /browser_invalid_operation/);
  assert.equal(h.calls.length, 0);
  for (const mode of ['manual', 'disabled']) { h.mode(mode); await assert.rejects(h.zoom(80), /browser_zoom_unavailable/); }
  h.mode('automatic'); h.state.grantId = 'replaced';
  await assert.rejects(h.zoom(80), /browser_document_changed/);
  h.state.grantId = 'grant'; await assert.rejects(h.zoom(80, Date.now() - 1), /browser_document_changed/);
  h.revoke(); await assert.rejects(h.zoom(80), /browser_document_changed/);
  assert.equal(h.calls.some(name => name.startsWith('set')), false);
});

test('revocation while preparing zoom prevents any change; interruption after isolation never retries the factor', async t => {
  const h = harness(t);
  h.hook(name => { if (name === 'getZoom') h.revoke(); });
  await assert.rejects(h.zoom(80), /browser_document_changed/);
  assert.equal(h.calls.includes('setZoomSettings'), false);
});

test('failed isolation and uncertain factor changes are not retried or restored onto a replacement page', async t => {
  const h = harness(t);
  h.hook(name => { if (name === 'setZoomSettings') throw new Error('private browser error'); });
  await assert.rejects(h.zoom(80), { message: 'browser_zoom_interrupted' });
  assert.equal(h.calls.includes('setZoom'), false);
  h.hook(name => { if (name === 'setZoom') { h.state.grantId = 'next-document'; } });
  await assert.rejects(h.zoom(67), /browser_zoom_interrupted/);
  assert.equal(h.calls.filter(name => name === 'setZoom').length, 1);
  assert.equal(h.state.refs.size, 0);
});

test('a hung browser zoom call obeys the request deadline', async t => {
  const h = harness(t);
  h.hook(name => name === 'setZoom' ? new Promise<void>(() => {}) : undefined);
  await assert.rejects(h.zoom(80, Date.now() + 75), /browser_zoom_interrupted/);
  assert.equal(h.calls.filter(name => name === 'setZoom').length, 1);
});

test('the fixed zoom inspector rejects a replaced origin without clearing its state', () => {
  const state = { grantId: 'grant', refs: new Map([['ref', {}]]), snapshot: 'snapshot' };
  const context = createContext({ __anywhereBrowser: state, location: new URL('https://foreign.example'), args: [{ grantId: 'grant', origin: target.origin, deadline: Date.now() + 1000, invalidate: true }] });
  const result = runInContext(`(${inspectZoom.toString()})(...args)`, context);
  assert.equal(result.errorCode, 'browser_document_changed'); assert.equal(state.refs.size, 1);
});
