import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useDeliveryNotice, type MessageDelivery } from '../web/src/message-delivery.js';
import { LiveActivityStatus } from '../web/src/live-activity.js';

test('delivery occupies the detail line and yields to activity; short turns expire without another event', async t => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of [['window', window], ['document', document], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = createRoot(document.getElementById('root')!);
  const receipt: MessageDelivery = { id: 'first', status: 'confirmed', environmentId: 'personal-pc', threadId: 't', selectionVersion: 1 };
  function Harness({ receipt, detail, active = true }: { receipt: MessageDelivery; detail: string; active?: boolean }) {
    const notice = useDeliveryNotice(receipt, detail);
    return createElement(LiveActivityStatus, { kind: 'command', purpose: '', detail, progress: {},
      startedAt: null, active, notice: notice ? createElement('span', { className: 'receipt' }, notice.status) : null });
  }
  try {
    await act(async () => root.render(createElement(Harness, { receipt, detail: 'exec_command' })));
    assert.equal(document.querySelectorAll('.activity-detail-line').length, 1);
    assert.equal(document.querySelector('.activity-detail-line .receipt')?.textContent, 'confirmed');
    assert.doesNotMatch(document.body.textContent!, /exec_command/);
    await act(async () => root.render(createElement(Harness, { receipt, detail: 'next_tool' })));
    assert.equal(document.querySelector('.receipt'), null);
    assert.match(document.querySelector('button')!.getAttribute('aria-label')!, /next_tool/);
    // Same status on another render must not resurrect the old receipt.
    await act(async () => root.render(createElement(Harness, { receipt, detail: 'third_tool' })));
    assert.equal(document.querySelector('.receipt'), null);
    const second = { ...receipt, id: 'second' };
    await act(async () => root.render(createElement(Harness, { receipt: second, detail: '', active: false })));
    assert.ok(document.querySelector('.receipt'));
    await act(async () => t.mock.timers.tick(5000));
    assert.equal(document.querySelector('.receipt'), null);
    const pending = { ...receipt, id: 'pending', status: 'sending' as const };
    await act(async () => root.render(createElement(Harness, { receipt: pending, detail: 'a' })));
    await act(async () => root.render(createElement(Harness, { receipt: pending, detail: 'b' })));
    await act(async () => t.mock.timers.tick(6000));
    assert.equal(document.querySelector('.receipt')?.textContent, 'sending');
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
