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
      if (++reads === 1) throw new Error('desktop_state_unavailable');
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
