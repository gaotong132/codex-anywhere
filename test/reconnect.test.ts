import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleReferencedRetry } from '../src/connector/reconnect.js';

test('connector reconnect retry keeps the process alive', () => {
  const timer = scheduleReferencedRetry(() => {}, 60_000);
  try {
    assert.equal(timer.hasRef(), true);
  } finally {
    clearTimeout(timer);
  }
});
