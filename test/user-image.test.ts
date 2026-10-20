import assert from 'node:assert/strict';
import test from 'node:test';
import { userImageAttachment } from '../src/shared/user-image.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { ownsPendingSubmission, canStopOwnedTurn } from '../web/src/app-utils.js';
test('pending Desktop or undiscovered delivery cannot expose a connector stop before native acknowledgement', () => {
  for (const mode of ['desktop', undefined] as const) {
    const owned = ownsPendingSubmission(true, mode);
    assert.equal(canStopOwnedTurn(owned, owned ? 'selected' : null, 'selected'), false);
  }
  assert.equal(ownsPendingSubmission(true, 'headless'), true);
  assert.equal(ownsPendingSubmission(false, 'desktop'), true);
});
test('native user image history retains original path without leaking inline image bytes', () => {
  const native = [{ type: 'text', text: 'Look' }, { type: 'localImage', path: 'C:/uploads/test.png' }];
  const canonical = [{ type: 'input_text', text: '<image name=[Image #1] path="C:/uploads/test.png">' },
    { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE' }, { type: 'input_text', text: '</image>' }];
  assert.deepEqual(userImageAttachment(native), userImageAttachment(canonical));
  const turns = mapTurns([{ id: 'turn', items: [{ type: 'userMessage', content: native }] }]);
  assert.equal(turns[0].items[0].attachment.path, 'C:/uploads/test.png');
  assert.equal(turns[0].items[0].text, 'Look');
  assert.equal(userImageAttachment([{ type: 'input_image', image_url: 'data:image/png;base64,PRIVATE' }]), undefined);
});
