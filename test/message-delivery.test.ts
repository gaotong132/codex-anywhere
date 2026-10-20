import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptDeliveryThread, confirmedDelivery, visibleDelivery, type MessageDelivery } from '../web/src/message-delivery.js';
import { BridgeRequestManager } from '../web/src/bridge-request-manager.js';

const pending: MessageDelivery = { id: 'send-1', environmentId: 'personal-pc', threadId: 'thread-a', selectionVersion: 1, status: 'sending' };

test('receipt needs the correct Codex response; transport ACK does not confirm delivery', async () => {
  for (const action of ['turn.start', 'turn.steer']) {
    let receipt = pending;
    const manager = new BridgeRequestManager({ isConnected: () => true, send: () => true, createId: () => action });
    const sent = manager.request<{ threadId: string }>(action, {}, { timeoutMs: null })
      .then((result) => { receipt = confirmedDelivery(pending, result.threadId); });
    manager.handle({ type: 'ack', requestId: action });
    await Promise.resolve();
    assert.equal(receipt.status, 'sending');
    manager.handle({ type: 'response', requestId: action, ok: true, data: { threadId: 'thread-a' } });
    await sent;
    assert.equal(receipt.status, 'confirmed');
  }
});

test('failed or lost responses never produce a success receipt', async () => {
  for (const failure of ['desktop_delivery_unknown', 'disconnected']) {
    let receipt = pending;
    const manager = new BridgeRequestManager({ isConnected: () => true, send: () => true, createId: () => failure });
    const sent = manager.request<{ threadId: string }>('turn.start', {}, { timeoutMs: null })
      .then((result) => { receipt = confirmedDelivery(pending, result.threadId); });
    manager.handle({ type: 'ack', requestId: failure });
    if (failure === 'disconnected') manager.rejectAll(failure);
    else manager.handle({ type: 'response', requestId: failure, ok: false, error: failure });
    await assert.rejects(sent, new RegExp(failure));
    assert.notEqual(receipt.status, 'confirmed');
  }
});

test('receipt is scoped to environment, conversation and selection generation', () => {
  const receipt = confirmedDelivery(pending, 'thread-a');
  assert.equal(visibleDelivery(receipt, 'personal-pc', 'thread-a', 1), receipt);
  assert.equal(visibleDelivery(receipt, 'ecs', 'thread-a', 1), null);
  assert.equal(visibleDelivery(receipt, 'personal-pc', 'thread-b', 1), null);
  // Switching away and back must not show a late response from the earlier selection.
  assert.equal(visibleDelivery(receipt, 'personal-pc', 'thread-a', 3), null);
  assert.throws(() => confirmedDelivery(pending, 'thread-b'), /session_delivery_mismatch/);
});

test('new conversation receipt follows the created thread and rejects empty success payloads', () => {
  const newMessage = { ...pending, threadId: null };
  const eventFirst = adoptDeliveryThread(newMessage, 'personal-pc', 1, 'new-thread');
  assert.equal(visibleDelivery(eventFirst, 'personal-pc', 'new-thread', 1)?.status, 'sending');
  assert.equal(adoptDeliveryThread(newMessage, 'ecs', 1, 'unrelated-thread'), newMessage);
  assert.equal(adoptDeliveryThread(newMessage, 'personal-pc', 2, 'unrelated-thread'), newMessage);
  const receipt = confirmedDelivery(newMessage, 'new-thread');
  assert.equal(visibleDelivery(receipt, 'personal-pc', 'new-thread', 1), receipt);
  for (const invalid of [undefined, null, '', ' ', 1]) {
    assert.throws(() => confirmedDelivery(newMessage, invalid), /session_delivery_mismatch/);
  }
});
