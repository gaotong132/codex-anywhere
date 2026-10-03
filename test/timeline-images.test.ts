import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useTimelineImages } from '../web/src/timeline-images.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';

test('image hook retries failures on reconnect/wake while retaining successful images and isolating sessions', async () => {
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const calls: string[] = [];
  let fail = true;
  let result: ReturnType<typeof useTimelineImages> | undefined;
  const request: BridgeRequest = (async (_action, payload) => {
    calls.push(String(payload.path));
    if (payload.path === '/failed.png' && fail) throw new Error('request_timeout');
    return { mimeType: 'image/png', data: 'aA==', size: 1 };
  }) as BridgeRequest;
  function Harness({ scope, online, epoch }: { scope: string; online: boolean; epoch: number }) {
    result = useTimelineImages(scope, ['/ok.png', '/failed.png'].map((path) => ({ path, name: path })), online, epoch, request);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const render = (scope: string, online: boolean, epoch: number) => act(async () => {
    root.render(createElement(Harness, { scope, online, epoch }));
  });
  try {
    await render('one', true, 1);
    assert.ok(result!.attachmentUrls['/ok.png']);
    assert.equal(result!.attachmentUrls['/failed.png'], '');
    await render('one', true, 1);
    assert.equal(calls.length, 2, 'ordinary rerenders must not start retry loops');
    await render('one', false, 1);
    fail = false;
    await render('one', true, 2);
    assert.deepEqual(calls, ['/ok.png', '/failed.png', '/failed.png']);
    assert.ok(result!.attachmentUrls['/failed.png']);
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.equal(calls.length, 3, 'wake retains successful image bytes');
    await render('two', false, 2);
    assert.deepEqual(result!.attachmentUrls, {}, 'another session cannot display the first session cache');
    await render('two', true, 2);
    assert.equal(calls.length, 5);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
