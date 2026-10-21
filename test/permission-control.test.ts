import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { PermissionModeControl } from '../web/src/permission-mode-control.js';
import { useSessionConfiguration } from '../web/src/session-configuration.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';

test('desktop access shows a working navigation/refresh flow instead of three disabled choices; headless choices stay gated', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const calls: string[] = [];
  let fail = false;
  const config = { mode: 'ask' as const, editable: false, networkAccess: true, allowFullAccess: true, canOpenOnDesktop: true };
  const render = (editable = false, busy = false, newSession = false, persisted = false) => act(async () => root.render(createElement(PermissionModeControl, {
    newSession,
    config: { ...config, editable, allowFullAccess: !editable, ...(persisted ? { source: 'persisted' as const, canOpenOnDesktop: false } : {}) }, loading: false, disabled: busy,
    onRefresh: async () => { calls.push('refresh'); },
    onOpenDesktop: async () => { if (fail) throw new Error('desktop_thread_open_failed'); calls.push('open'); },
    onChange: async (mode) => { calls.push(mode); },
  })));
  const click = async (selector: string) => act(async () => {
    document.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  try {
    await render(false, true);
    await click('.permission-mode-summary');
    assert.equal(document.querySelectorAll('.permission-mode-options button').length, 0);
    assert.match(document.body.textContent!, /权限由 Codex 电脑端管理/);
    assert.deepEqual(calls, ['refresh']);
    await click('.permission-mode-desktop button');
    assert.match(document.querySelector('[role=status]')!.textContent!, /已在电脑端打开/);
    assert.deepEqual(calls, ['refresh', 'open']);
    fail = true;
    await click('.permission-mode-desktop button');
    assert.match(document.querySelector('[role=alert]')!.textContent!, /未能在电脑端打开/);
    await render(true);
    await click('.permission-mode-summary');
    const choices = document.querySelectorAll<HTMLButtonElement>('.permission-mode-options button');
    assert.equal(choices.length, 3);
    assert.equal(choices[0].disabled, false);
    assert.equal(choices[1].disabled, false);
    assert.equal(choices[2].disabled, true);
    await click('.permission-mode-options button.auto');
    assert.equal(calls.at(-1), 'auto');
    await render(true, true);
    await click('.permission-mode-summary');
    assert.equal(document.querySelectorAll('.permission-mode-options button:disabled').length, 3);
    assert.match(document.body.textContent!, /当前会话正在执行或等待处理/);
    await render(true, true, true);
    assert.match(document.body.textContent!, /从第一条消息生效/);
    assert.match(document.body.textContent!, /请等待执行节点连接/);
    assert.doesNotMatch(document.body.textContent!, /当前会话正在执行或等待处理/);
    await render(false, false, false, true);
    await click('.permission-mode-summary');
    assert.match(document.body.textContent!, /任务空闲后可修改/);
    assert.match(document.querySelector('.permission-mode-summary')!.textContent!, /只读/);
    assert.equal(document.querySelectorAll('.permission-mode-options button').length, 0);
    assert.equal(document.querySelectorAll('.permission-mode-desktop button').length, 1);
    assert.match(document.querySelector('.permission-mode-desktop button')!.textContent!, /刷新权限/);
    await render(true, false, false, true);
    await click('.permission-mode-summary');
    assert.equal(document.querySelectorAll('.permission-mode-options button').length, 3);
    assert.match(document.body.textContent!, /仅修改当前会话/);
    assert.doesNotMatch(document.body.textContent!, /新会话的默认值/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('permission refresh ignores old sessions and older responses, and preserves displayed state after a failed refresh', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById('root')!);
  const reads: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  let result: ReturnType<typeof useSessionConfiguration>;
  const request = (async (action: string) => {
    if (action === 'session.permissions.read') return new Promise((resolve, reject) => reads.push({ resolve, reject }));
    if (action === 'connector.status') return { capabilities: { networkAccess: true, fullAccess: true } };
    return {};
  }) as BridgeRequest;
  function Harness({ threadId }: { threadId: string }) {
    result = useSessionConfiguration({ environmentId: 'personal-pc', online: true, threadId, request });
    return null;
  }
  const config = (mode: 'ask' | 'auto' | 'full') => ({ mode, editable: false, networkAccess: true, allowFullAccess: true });
  try {
    await act(async () => root.render(createElement(Harness, { threadId: 'one' })));
    await act(async () => root.render(createElement(Harness, { threadId: 'two' })));
    await act(async () => reads[0].resolve(config('full')));
    assert.equal(result!.permissionConfig, null);
    await act(async () => reads[1].resolve(config('ask')));
    let old: Promise<void>;
    let latest: Promise<void>;
    await act(async () => { old = result!.refreshPermissionConfig(); latest = result!.refreshPermissionConfig(); });
    await act(async () => { reads[3].resolve(config('auto')); await latest!; });
    await act(async () => { reads[2].resolve(config('full')); await old!; });
    assert.equal(result!.permissionConfig?.mode, 'auto');
    let failed: Promise<void>;
    await act(async () => { failed = result!.refreshPermissionConfig(); });
    await act(async () => { reads[4].reject(new Error('request_timeout')); await assert.rejects(failed!); });
    assert.equal(result!.permissionConfig?.mode, 'auto');
    assert.equal(result!.permissionConfigLoading, false);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
