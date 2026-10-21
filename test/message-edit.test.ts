import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { messageEditInput } from '../src/connector/message-edit.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { MessageEditDialog } from '../web/src/message-edit-dialog.js';
import { MessageBubble } from '../web/src/message-bubble.js';

function fixture() {
  const codex = new CodexAppServer({ runtimeCwd: process.cwd() });
  codex.ensureStarted = async () => {};
  const input = [{ type: 'text', text: 'original' }, { type: 'localImage', path: '/image.png' }];
  const turns: any[] = [{ id: 'later', status: 'completed', items: [] },
    { id: 'target', status: 'completed', items: [{ type: 'userMessage', content: input }] }];
  const calls: any[] = [];
  let status = 'idle';
  let failStart = false;
  codex.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: 'thread', cwd: process.cwd(), status: { type: status } } } as any;
    if (method === 'thread/turns/list') return { data: turns } as any;
    if (method === 'turn/start') { if (failStart) throw Error('start failed'); return { turn: { id: 'new-turn' } } as any; }
    return {} as any;
  };
  return { codex, input, turns, calls, status: (s: string) => { status = s; }, fail: () => { failStart = true; } };
}
test('editing preserves original attachments and wrapper text without interpreting replacement patterns', () => {
  const input = [{ type: 'text', text: '# Files mentioned by the user:\n\n/image.png\n\n## My request:\noriginal' }, { type: 'localImage', path: '/image.png' }];
  const edit = messageEditInput(input);
  assert.equal(edit.text, 'original');
  const result = edit.replace('new $& text');
  assert.equal(result[0].text.endsWith('new $& text'), true);
  assert.deepEqual(result[1], input[1]);
  assert.equal(input[0].text.endsWith('original'), true);
  assert.throws(() => messageEditInput([{ type: 'image' }]), /unsupported/);
  assert.throws(() => messageEditInput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), /unsupported/);
});
test('prepare reads only summaries on demand and produces a history conflict token', async () => {
  const f = fixture();
  const plan = await f.codex.prepareMessageEdit('thread', 'target');
  assert.equal(plan.text, 'original');
  assert.equal(f.calls.filter(c => c.method === 'thread/turns/list')[0].params.itemsView, 'summary');
  f.turns.unshift({ id: 'newer', status: 'completed', items: [] });
  assert.notEqual((await f.codex.prepareMessageEdit('thread', 'target')).token, plan.token);
});
test('revert precedes one new turn and retains the stored image input', async () => {
  const f = fixture(); const plan = await f.codex.prepareMessageEdit('thread', 'target');
  await f.codex.startTurn({ threadId: 'thread', text: 'edited', edit: { turnId: 'target', token: plan.token, confirm: true } });
  const revert = f.calls.findIndex(c => c.method === 'thread/revert'), start = f.calls.findIndex(c => c.method === 'turn/start');
  assert.ok(revert > 0 && start > revert);
  assert.deepEqual(f.calls[revert].params, { threadId: 'thread', beforeTurnId: 'target' });
  assert.deepEqual(f.calls[start].params.input, [{ type: 'text', text: 'edited', text_elements: [] }, f.input[1]]);
});
test('stale confirmation, unknown status, running tasks and invalid text never revert history', async () => {
  for (const kind of ['stale', 'unknown', 'active', 'blank', 'confirm'] as const) {
    const f = fixture(), plan = await f.codex.prepareMessageEdit('thread', 'target');
    if (kind === 'stale') f.turns.unshift({ id: 'newer', status: 'completed', items: [] });
    if (kind === 'unknown' || kind === 'active') f.status(kind);
    await assert.rejects(f.codex.startTurn({ threadId: 'thread', text: kind === 'blank' ? ' ' : 'edited',
      edit: { turnId: 'target', token: plan.token, confirm: kind !== 'confirm' } }));
    assert.equal(f.calls.some(c => c.method === 'thread/revert'), false);
    assert.equal(f.codex.activeTurns.size, 0);
  }
});
test('send failure after revert is explicitly reported and is never automatically retried', async () => {
  const f = fixture(), plan = await f.codex.prepareMessageEdit('thread', 'target'); f.fail();
  await assert.rejects(f.codex.startTurn({ threadId: 'thread', text: 'edited', edit: { turnId: 'target', token: plan.token, confirm: true } }), /reverted_send_failed/);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'thread/revert').length, 1);
  assert.equal(f.codex.activeTurns.size, 0);
});
test('ambiguous multi-message turns are rejected before a destructive operation', async () => {
  const f = fixture(); f.turns[1].items.push({ type: 'userMessage', content: [{ type: 'text', text: 'steer' }] });
  await assert.rejects(f.codex.prepareMessageEdit('thread', 'target'), /unsupported/);
  assert.equal(f.calls.some(c => c.method === 'thread/revert'), false);
});
test('only persisted user messages have edit actions; assistant and synthetic replies do not', () => {
  const render = (item: any) => renderToStaticMarkup(createElement(MessageBubble, { item, onDownloadFile: () => {}, onReadVisualization: async () => '', onEditMessage: () => {} }));
  assert.match(render({ id: '1', kind: 'user', text: 'text', historyTurnId: 'turn' }), /message-edit/);
  for (const item of [{ id: '2', kind: 'assistant', text: 'text', historyTurnId: 'turn' },
    { id: '3', kind: 'user', text: 'text', transient: true },
    { id: '4', kind: 'user', text: 'text', historyTurnId: 'rollout:unknown' },
    { id: '5', kind: 'user', text: 'text', historyTurnId: 'turn', contexts: [{ kind: 'delegation' }] }]) assert.doesNotMatch(render(item), /class="message-copy message-edit"/);
});

test('edit confirmation sends once, keeps drafts on failure and requires inspection before retry', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(window.document.getElementById('root')!);
  let calls = 0; let reject!: (error: Error) => void;
  try {
    await act(async () => root.render(createElement(MessageEditDialog, { originalText: 'original',
      onPrepare: async () => ({ threadId: 'thread', turnId: 'turn', token: 'token', text: 'original' }),
      onSubmit: () => { calls++; return new Promise<void>((_resolve, fail) => { reject = fail; }); }, onClose: () => {} })));
    const button = [...window.document.querySelectorAll('button')].at(-1)!;
    await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); button.dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.equal(calls, 1);
    await act(async () => { reject(new Error('message_edit_unconfirmed')); });
    assert.equal(button.hasAttribute('disabled'), true);
    assert.equal(window.document.querySelector('textarea')!.value, 'original');
    assert.match(window.document.querySelector('[role="alert"]')!.textContent!, /核对最新记录/);
  } finally {
    await act(async () => root.unmount());
    keys.forEach((key, index) => { if (originals[index]) Object.defineProperty(globalThis, key, originals[index]!); else delete (globalThis as any)[key]; });
  }
});
