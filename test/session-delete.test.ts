import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { SessionSidebar } from '../web/src/session-sidebar.js';
import { SessionDeleteDialog } from '../web/src/session-delete-dialog.js';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';

function fixture() {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  const calls: Array<{ method: string; params: any }> = [];
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: process.cwd(), status: { type: 'idle' } } } as any;
    return {} as any;
  };
  return { codex, calls };
}

test('delete targets one native thread and clears only its cached metadata', async () => {
  const { codex, calls } = fixture();
  for (const id of ['a', 'b']) {
    codex.sessionMetadata.set(id, { cwd: process.cwd(), path: '', canAcceptDirectInput: true });
    codex.sessionPermissionModes.set(id, 'ask');
    codex.sessionModelSettings.set(id, { model: 'test', reasoningEffort: 'high' });
  }
  assert.deepEqual(await codex.deleteSession(' a '), { threadId: 'a', deleted: true });
  assert.deepEqual(calls, [
    { method: 'thread/read', params: { threadId: 'a', includeTurns: false } },
    { method: 'thread/delete', params: { threadId: 'a' } },
  ]);
  for (const cache of [codex.sessionMetadata, codex.sessionPermissionModes, codex.sessionModelSettings]) {
    assert.equal(cache.has('a'), false);
    assert.equal(cache.has('b'), true);
  }
});

test('invalid IDs and running or starting tasks never reach native deletion', async () => {
  const { codex, calls } = fixture();
  for (const id of ['', '../a', '/root/codex', 'a\nb', {}, 'a'.repeat(257)]) {
    await assert.rejects(codex.deleteSession(id), /thread_id_required/);
  }
  for (const state of ['starting', 'running', 'cancelling']) {
    codex.activeTurns.set('a', { threadId: 'a', turnId: 'turn-a', cwd: process.cwd(), state });
    await assert.rejects(codex.deleteSession('a'), /session_delete_turn_active/);
  }
  assert.deepEqual(calls, []);
  await codex.deleteSession('b');
  assert.equal(codex.getActiveTurn('a')?.state, 'cancelling');
});

test('native status and project authorization are checked before deletion', async () => {
  for (const [thread, error] of [
    [{ id: 'other', cwd: process.cwd() }, /session_delivery_mismatch/],
    [{ id: 'a' }, /session_project_directory_unavailable/],
    [{ id: 'a', cwd: '/outside-allowed-root' }, /workspace/],
    [{ id: 'a', cwd: process.cwd(), status: { type: 'active' } }, /session_delete_turn_active/],
    [{ id: 'a', cwd: process.cwd() }, /session_delete_status_unknown/],
    [{ id: 'a', cwd: process.cwd(), status: { type: 'unknown' } }, /session_delete_status_unknown/],
  ] as const) {
    const { codex } = fixture();
    let writes = 0;
    codex.rpcRaw = async method => { if (method !== 'thread/read') writes++; return { thread } as any; };
    await assert.rejects(codex.deleteSession('a'), error);
    assert.equal(writes, 0);
  }
});

test('deletion reserves its thread against duplicate delete and concurrent starts; failure releases it', async () => {
  const { codex, calls } = fixture();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  codex.ensureStarted = () => wait;
  const deletion = codex.deleteSession('a');
  await assert.rejects(codex.deleteSession('a'), /session_delete_in_progress/);
  await assert.rejects(codex.startTurn({ threadId: 'a', text: 'hello' }), /session_delete_in_progress/);
  release(); await deletion;
  assert.equal(calls.filter(call => call.method === 'thread/delete').length, 1);
  const rpc = codex.rpcRaw;
  codex.sessionMetadata.set('a', { cwd: process.cwd(), path: '', canAcceptDirectInput: true });
  codex.rpcRaw = async (method, params) => { if (method === 'thread/delete') throw new Error('delete denied'); return rpc(method, params); };
  await assert.rejects(codex.deleteSession('a'), /delete denied/);
  assert.equal(codex.sessionMetadata.has('a'), true);
  codex.rpcRaw = rpc;
  await codex.deleteSession('a');
});

test('deleting a session revokes its browser grants and pending binds, not another session', async () => {
  const broker = new BrowserSessionBroker('ecs', () => true);
  const client = { clientId: 'client', clientDeviceId: 'browser' };
  const target = { browserDeviceId: 'browser', tabId: 1, documentId: 'doc', origin: 'https://example.com' };
  broker.bind(client, 'a', target);
  broker.bind(client, 'b', { ...target, tabId: 2 });
  let release!: () => void;
  const pending = broker.validateAndBind(client, 'a', target, () => new Promise<void>(resolve => { release = resolve; }));
  const rejected = assert.rejects(pending, /browser_authorization_changed/);
  broker.clearSession('a');
  release(); await rejected;
  assert.equal(broker.status('a').authorized, false);
  assert.equal(broker.status('b').authorized, true);
});

test('sidebar only selects sessions; deletion uses the current conversation title action', () => {
  const props = {
    open: true, environmentId: 'ecs', environmentIds: ['ecs'], onlineEnvironmentIds: ['ecs'],
    sessions: [{ id: 'a', title: 'Idle' }, { id: 'b', title: 'Active', status: 'active' }, { id: 'c', title: 'Background' }],
    selectedThreadId: 'a', executionState: 'idle' as const, attention: { c: 'running' as const },
    searchOpen: false, search: '', onSearchOpenChange: () => {}, onSearchChange: () => {},
    onEnvironmentChange: () => {}, onNewSession: () => {}, onClose: () => {}, onSelect: () => {},
  };
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionSidebar, props)));
  assert.equal(document.querySelectorAll('.session-delete-button').length, 0);
  assert.equal(document.querySelectorAll('.session-list button').length, 3);
  assert.equal(document.querySelectorAll('.session-card.running').length, 2);
  assert.equal(document.querySelectorAll('button button').length, 0);
});

test('delete confirmation names its target, explains irreversible history deletion and preserves projects', () => {
  const markup = renderToStaticMarkup(createElement(SessionDeleteDialog, { title: '<test-task>', onClose: () => {}, onDelete: async () => {} }));
  const { document } = parseHTML(markup);
  assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true');
  assert.match(markup, /&lt;test-task&gt;/);
  assert.match(markup, /无法恢复/);
  assert.match(markup, /项目目录和代码文件不会删除/);
  assert.match(markup, /永久删除/);
});

test('confirmation handles a double click once, locks cancel while pending, and displays deletion errors', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(window.document.getElementById('root')!);
  let calls = 0;
  let reject!: (error: Error) => void;
  try {
    await act(async () => root.render(createElement(SessionDeleteDialog, {
      title: 'Test task', onClose: () => { throw new Error('must not close while deleting'); },
      onDelete: () => { calls++; return new Promise<void>((_resolve, fail) => { reject = fail; }); },
    })));
    const button = window.document.querySelector('.delete-session-confirm')!;
    await act(async () => {
      button.dispatchEvent(new window.Event('click', { bubbles: true }));
      button.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    assert.equal(calls, 1);
    assert.ok([...window.document.querySelectorAll('button')].every(button => button.hasAttribute('disabled')));
    await act(async () => { reject(new Error('session_delete_turn_active')); });
    assert.match(window.document.querySelector('[role="alert"]')!.textContent!, /该会话仍在运行/);
    assert.equal(button.hasAttribute('disabled'), false);
  } finally {
    await act(async () => root.unmount());
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globalThis, key, originals[index]!);
      else delete (globalThis as any)[key];
    });
  }
});
