import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttachmentPreparation } from '../web/src/attachment-draft.js';
import type { PendingAttachment } from '../web/src/app-types.js';

function fixture() {
  const pending: { resolve: (value: PendingAttachment) => void; reject: (error: Error) => void }[] = [];
  const published: PendingAttachment[] = [];
  const discarded: PendingAttachment[] = [];
  const errors: unknown[] = [];
  const preparation = createAttachmentPreparation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    value => discarded.push(value));
  const file = new File(['image'], 'screen.png');
  const result = (previewUrl: string): PendingAttachment => ({ kind: 'image', file, previewUrl });
  const choose = (isCurrent?: () => boolean) => preparation.choose(file, value => published.push(value), error => errors.push(error), isCurrent);
  return { preparation, pending, published, discarded, errors, result, choose };
}

test('slow first image cannot overwrite the latest attachment; its unused preview is released', async () => {
  const f = fixture();
  const first = f.choose(); const second = f.choose();
  const old = f.result('blob:old'); const latest = f.result('blob:latest');
  f.pending[1].resolve(latest); await second;
  f.pending[0].resolve(old); await first;
  assert.deepEqual(f.published, [latest]);
  assert.deepEqual(f.discarded, [old]);
});

test('removal, dialog close or unmount invalidates in-flight preparation without leaking its preview', async () => {
  const f = fixture(); const task = f.choose();
  f.preparation.invalidate();
  const result = f.result('blob:cancelled'); f.pending[0].resolve(result); await task;
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.discarded, [result]);
});

test('changed session context discards results and obsolete errors without suppressing current failures', async () => {
  const f = fixture(); let current = true;
  const first = f.choose(() => current); current = false;
  f.pending[0].resolve(f.result('blob:other-session')); await first;
  const second = f.choose(() => current); f.pending[1].reject(new Error('obsolete')); await second;
  assert.equal(f.discarded.length, 1); assert.equal(f.published.length, 0); assert.equal(f.errors.length, 0);
  const third = f.choose(); const error = new Error('invalid image'); f.pending[2].reject(error); await third;
  assert.deepEqual(f.errors, [error]);
});

test('an old failure does not replace the new selection with an error', async () => {
  const f = fixture(); const first = f.choose(); const second = f.choose();
  f.pending[0].reject(new Error('old')); await first;
  f.pending[1].resolve(f.result('blob:latest')); await second;
  assert.deepEqual(f.errors, []); assert.equal(f.published.length, 1);
});
