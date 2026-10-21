import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { ModelConfigControl } from '../web/src/model-config-control.js';
import { useSessionConfiguration } from '../web/src/session-configuration.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';

test('an existing session read failure is retryable and never presented as automatic model selection', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  let reads = 0;
  const request = (async (action: string) => {
    if (action === 'session.model-config.read') {
      if (++reads === 1) throw new Error('desktop_input_unsupported');
      return { model: 'gpt-6-astra', reasoningEffort: 'high', serviceTier: null, fastMode: false, readOnly: true, models: [] };
    }
    if (action === 'connector.status') return { capabilities: {} };
    return {};
  }) as BridgeRequest;
  function Harness() {
    const state = useSessionConfiguration({ environmentId: 'personal-pc', online: true, threadId: 'long-thread', request });
    return createElement(ModelConfigControl, { config: state.modelConfig, loading: state.modelConfigLoading,
      disabled: false, hasSession: true, onRefresh: state.refreshModelConfig, onSave: state.saveModelConfig });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.match(document.body.textContent!, /模型读取失败|Model unavailable/);
    assert.doesNotMatch(document.body.textContent!, /自动选择|Automatic|默认思考|Default reasoning/);
    await act(async () => { document.querySelector<HTMLButtonElement>('button')!.click(); });
    assert.equal(reads, 2);
    assert.match(document.body.textContent!, /gpt-6-astra/);
    assert.match(document.body.textContent!, /高|High/);
    assert.equal(document.querySelector<HTMLButtonElement>('button')!.disabled, true);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a new session still shows defaults before any model is selected', () => {
  const html = renderToStaticMarkup(createElement(ModelConfigControl, {
    config: null, loading: false, disabled: false, hasSession: false, onSave: async () => {},
  }));
  assert.match(html, /自动选择|Automatic/);
  assert.doesNotMatch(html, /模型读取失败|Model unavailable/);
});

async function configurationHarness(t: any, request: BridgeRequest) {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  let state: ReturnType<typeof useSessionConfiguration>;
  function Harness(props: any) {
    state = useSessionConfiguration({ environmentId: 'pc', online: true, threadId: 'one', request, ...props });
    return null;
  }
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { state: () => state!, render: async (props: any = {}) => { await act(async () => root.render(createElement(Harness, props))); } };
}
const readConfig = { model: 'astra', reasoningEffort: 'high', serviceTier: 'default', fastMode: false,
  models: [{ model: 'astra', serviceTiers: [] }] };

test('model initialization retries one transient failure and stops after recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const request = (async (action: string, _payload: unknown, options: any) => {
    if (action !== 'session.model-config.read') return { capabilities: {} };
    assert.equal(options.timeoutMs, 12000);
    if (++reads === 1) throw new Error('desktop_input_not_ready');
    return readConfig;
  }) as BridgeRequest;
  const harness = await configurationHarness(t, request);
  await harness.render(); assert.equal(reads, 1);
  await act(async () => t.mock.timers.tick(800));
  assert.equal(reads, 2); assert.equal(harness.state().modelConfig?.model, 'astra');
  await act(async () => t.mock.timers.tick(100000)); assert.equal(reads, 2);
});

test('model reads cancel on selection change and restart on recovery without requiring an offline render', async t => {
  let firstSignal: AbortSignal | undefined, finishOld!: (value: any) => void, reads = 0;
  const request = (async (action: string, _payload: unknown, options: any) => {
    if (action !== 'session.model-config.read') return { capabilities: {} };
    reads++;
    if (reads === 1) { firstSignal = options.signal; return new Promise(r => { finishOld = r; }); }
    return readConfig;
  }) as BridgeRequest;
  const harness = await configurationHarness(t, request);
  await harness.render();
  await harness.render({ threadId: 'two' }); assert.equal(firstSignal?.aborted, true);
  await act(async () => finishOld({ ...readConfig, model: 'stale' }));
  assert.equal(harness.state().modelConfig?.model, 'astra');
  await harness.render({ threadId: 'two', recoveryKey: '2:1' }); assert.equal(reads, 3);
  assert.equal(harness.state().modelConfigLoading, false);
});

test('native model push can recover a failed header without inventing catalog or editable settings', async t => {
  const request = (async (action: string) => {
    if (action === 'session.model-config.read') throw new Error('desktop_input_unsupported');
    return { capabilities: {} };
  }) as BridgeRequest;
  const harness = await configurationHarness(t, request);
  await harness.render(); assert.equal(harness.state().modelConfig, null);
  await harness.render({ desktopState: { threadId: 'one', model: 'astra', reasoningEffort: 'high', serviceTier: 'default' } });
  assert.equal(harness.state().modelConfig?.model, 'astra');
  assert.equal(harness.state().modelConfig?.readOnly, true);
  assert.equal(harness.state().modelConfigLoading, false);
});
