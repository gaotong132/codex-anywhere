import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerClick } from '../src/pointer-click.js';
import { releaseAllDebuggers } from '../src/debugger-session.js';

const target = { tabId: 17, documentId: 'exact-document', origin: 'https://example.com', browserDeviceId: 'fixture' };
function harness(t: test.TestContext) {
  const original = globalThis.chrome;
  const calls: any[] = [];
  let granted = true, attachFails = false, current = true;
  let onInput = (_type: string) => {};
  globalThis.chrome = { permissions: { contains: async (value: any) => {
    assert.deepEqual(value, { permissions: ['debugger'] }); return granted;
  } }, debugger: {
    attach: async (value: any, version: string) => { calls.push({ attach: value, version }); if (attachFails) throw Error('private browser details'); },
    detach: async (value: any) => { calls.push({ detach: value }); },
    sendCommand: async (value: any, method: string, params: any) => {
      assert.deepEqual(value, { tabId: target.tabId }); assert.equal(method, 'Input.dispatchMouseEvent');
      calls.push(params); onInput(params.type);
    },
  } } as any;
  t.after(async () => { await releaseAllDebuggers(); globalThis.chrome = original; });
  return { calls, run: (prepare: (phase?: 'verify' | 'consume') => Promise<Record<string, unknown>>) => pointerClick(target, Date.now() + 5000, () => current, prepare),
    permission: (value: boolean) => { granted = value; }, attachFailure: () => { attachFails = true; }, revoke: () => { current = false; },
    input: (callback: typeof onInput) => { onInput = callback; } };
}
const point = () => Promise.resolve({ clickPoint: { x: 30, y: 40 } });

test('real input uses only the granted tab and consumes refs before one release, retaining its debugger', async (t) => {
  const h = harness(t), phases: (string | undefined)[] = [];
  assert.deepEqual(await h.run(async (phase) => { phases.push(phase); return point(); }), { clicked: true });
  assert.deepEqual(phases, [undefined, 'verify', 'verify', 'consume']);
  assert.deepEqual(h.calls.map((c) => c.type ?? (c.attach ? 'attach' : 'detach')), ['attach', 'mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(h.calls[3].clickCount, 1);
  await h.run(point);
  assert.equal(h.calls.filter(c => c.attach).length, 1);
  await releaseAllDebuggers(); assert.deepEqual(h.calls.at(-1), { detach: { tabId: 17 } });
});

test('permission denial and attach conflicts never click or detach someone else’s debugger', async (t) => {
  const h = harness(t); h.permission(false);
  await assert.rejects(h.run(point), /native_click_permission_required/); assert.deepEqual(h.calls, []);
  h.permission(true); h.attachFailure();
  await assert.rejects(h.run(point), { message: 'browser_native_click_unavailable' });
  assert.equal(h.calls.length, 1);
});

test('managed links and select label reads need no debugger permission', async (t) => {
  const h = harness(t); h.permission(false);
  for (const result of [{ openInNewTab: 'https://example.com/child' }, { options: [], truncated: false }]) {
    assert.deepEqual(await h.run(async () => result), result);
  }
  assert.deepEqual(h.calls, []);
});

test('hover replacement or an overlay stops before the press and still detaches', async (t) => {
  const h = harness(t); let hovered = false;
  h.input((type) => { if (type === 'mouseMoved') hovered = true; });
  await assert.rejects(h.run(async () => { if (hovered) throw Error('browser_element_obscured'); return point(); }), /obscured/);
  assert.deepEqual(h.calls.map((c) => c.type ?? (c.attach ? 'attach' : 'detach')), ['attach', 'mouseMoved', 'detach']);
});

test('revocation during a press cancels outside the viewport without completing a click', async (t) => {
  const h = harness(t);
  h.input((type) => { if (type === 'mousePressed') h.revoke(); });
  await assert.rejects(h.run(point), /native_click_interrupted/);
  assert.deepEqual(h.calls.at(-2), { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: 0 });
  assert.ok(h.calls.at(-1).detach);
});

test('uncertain final release is never replayed', async (t) => {
  const h = harness(t);
  h.input((type) => { if (type === 'mouseReleased') throw Error('transport disconnected'); });
  await assert.rejects(h.run(point), /native_click_interrupted/);
  assert.equal(h.calls.filter((c) => c.type === 'mouseReleased').length, 1);
  assert.ok(h.calls.at(-1).detach);
});
