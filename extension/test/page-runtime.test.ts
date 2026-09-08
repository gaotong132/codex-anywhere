import assert from 'node:assert/strict';
import test from 'node:test';
import { page, runPageOperation } from '../src/page-runtime.js';
import { matchesTarget } from '../src/page-binding.js';

const target = { browserDeviceId: 'fixture', tabId: 17, documentId: 'document-a', origin: 'https://example.com' };

test('page execution injects only the granted document and rejects replacement or private exception details', async t => {
  const saved = globalThis.chrome;
  t.after(() => { globalThis.chrome = saved; });
  let documentId = target.documentId, result: object = { authorized: true };
  globalThis.chrome = { scripting: { executeScript: async (input: any) => {
    assert.deepEqual(input.target, { tabId: target.tabId, documentIds: [target.documentId] });
    assert.equal(input.world, 'ISOLATED');
    assert.equal(input.args[0].grantId, 'grant');
    return [{ documentId, result }];
  } } } as any;
  assert.deepEqual(await page(target, 'grant', { method: 'authorize' }), { authorized: true });
  documentId = 'replacement';
  await assert.rejects(page(target, 'grant', { method: 'snapshot' }), /browser_document_changed/);
  documentId = target.documentId; result = { errorCode: 'private exception details' };
  await assert.rejects(page(target, 'grant', { method: 'snapshot' }), { message: 'browser_operation_failed_or_authorization_changed' });
});

test('document matching accepts reordered transport fields but rejects extra fields and changed identity', () => {
  assert.ok(matchesTarget({ origin: target.origin, documentId: target.documentId, tabId: 17, browserDeviceId: 'fixture' }, target));
  for (const value of [null, [], { ...target, tabId: '17' }, { ...target, documentId: 'new' }, { ...target, browserDeviceId: 'other' },
    { ...target, origin: 'https://example.com/path' }, { ...target, origin: 'https://foreign.example' }, { ...target, frameId: 0 }]) {
    assert.equal(matchesTarget(value, target), false, JSON.stringify(value));
  }
});

test('a hung exact-document injection and snapshot metadata read respect the operation deadline', async t => {
  const saved = globalThis.chrome;
  t.after(() => { globalThis.chrome = saved; });
  globalThis.chrome = { scripting: { executeScript: async () => new Promise(() => {}) } } as any;
  await assert.rejects(page(target, 'grant', { method: 'snapshot' }, Date.now() + 30), /browser_operation_timeout/);
  globalThis.chrome = {
    scripting: { executeScript: async () => [{ documentId: target.documentId, result: { nodes: [], viewport: {} } }] },
    tabs: { getZoom: async () => new Promise(() => {}) },
  } as any;
  await assert.rejects(runPageOperation(target, 'grant', { method: 'snapshot' }, Date.now() + 30, () => true), /browser_operation_timeout/);
});
