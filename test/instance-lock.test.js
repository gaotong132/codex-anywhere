import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireConnectorInstanceLock } from '../src/connector/instance-lock.js';

test('Windows connector instance lock excludes duplicates and releases on close', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const name = `PersonalCodexBridgeTest-${process.pid}-${randomUUID()}`;
  const first = await acquireConnectorInstanceLock(name);
  assert.ok(first);
  t.after(() => first?.close());

  const duplicate = await acquireConnectorInstanceLock(name);
  assert.equal(duplicate, null);

  await first.close();
  const afterClose = await acquireConnectorInstanceLock(name);
  assert.ok(afterClose);
  await afterClose.close();
});
