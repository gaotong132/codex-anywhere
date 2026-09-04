import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PairingDialog } from '../web/src/pairing-dialog.js';
import { PENDING_PAIRING_KEY, pairingFailureMessage, takePairingInput } from '../web/src/pairing-input.js';
import { createBrowserPairingCredential, browserPairingFragment, encodeBrowserPairingCredential, parseBrowserPairingCredential } from '../src/shared/pairing-auth.js';

function locationFixture(hash: string, stored: string | null = null) {
  const location = { hash, pathname: '/', search: '?view=pairing' };
  const replacements: string[] = [];
  const removed: string[] = [];
  return {
    location, replacements, removed,
    history: { state: { keep: true }, replaceState(_state, _unused, url) {
      replacements.push(String(url)); location.hash = '';
    } },
    storage: {
      getItem() { return stored; },
      removeItem(key) { removed.push(key); stored = null; },
    },
  };
}

test('a generated pairing URL fills the form and is scrubbed before rendering', () => {
  const credential = createBrowserPairingCredential();
  const url = new URL('https://bridge.example.test/');
  url.hash = browserPairingFragment(credential);
  const fixture = locationFixture(url.hash);
  const value = takePairingInput(fixture.location, fixture.history, fixture.storage);
  assert.equal(value, encodeBrowserPairingCredential(credential));
  assert.deepEqual(parseBrowserPairingCredential(value!), credential);
  assert.deepEqual(fixture.replacements, ['/?view=pairing']);
  assert.deepEqual(fixture.removed, [PENDING_PAIRING_KEY]);
  // React gets this captured value as a prop, so repeated renders do not
  // consume the fragment a second time or depend on sessionStorage access.
  for (let render = 0; render < 2; render += 1) {
    const markup = renderToStaticMarkup(createElement(PairingDialog, {
      ...dialogProps(), value: value!,
    }));
    assert.ok(markup.includes(`value="${value}"`));
  }
});

test('URL fragment decoding works and new links supersede stale pending codes', () => {
  const value = encodeBrowserPairingCredential(createBrowserPairingCredential());
  const fixture = locationFixture(`#pair=${encodeURIComponent(value)}`, 'old-invalid-code');
  assert.equal(takePairingInput(fixture.location, fixture.history, fixture.storage), value);
  fixture.location.hash = '#pair=another-code';
  assert.equal(takePairingInput(fixture.location, fixture.history, fixture.storage), 'another-code');
});

test('malformed and empty pairing values remain editable rather than disappearing', () => {
  for (const value of ['bad-code', '']) {
    const fixture = locationFixture(`#pair=${value}`);
    assert.equal(takePairingInput(fixture.location, fixture.history, fixture.storage), value);
    assert.equal(fixture.location.hash, '');
  }
});

test('blocked storage cannot lose a URL code and pending credentials are consumed once', () => {
  const fixture = locationFixture('#pair=editable-code');
  const blocked = { getItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(takePairingInput(fixture.location, fixture.history, blocked), 'editable-code');
  const legacy = locationFixture('', 'previous-attempt');
  assert.equal(takePairingInput(legacy.location, legacy.history, legacy.storage), 'previous-attempt');
  assert.equal(takePairingInput(legacy.location, legacy.history, legacy.storage), null);
  assert.equal(takePairingInput(legacy.location, legacy.history, blocked), null);
});

function dialogProps() {
  return { open: true, value: 'editable-code', pairing: false, status: '', error: '',
    onValueChange() {}, onCancel() {}, onClose() {}, onPair() {} };
}

test('pairing stays cancellable while busy and failed attempts remain editable', () => {
  const busy = renderToStaticMarkup(createElement(PairingDialog, {
    ...dialogProps(), pairing: true, status: 'Connecting',
  }));
  assert.match(busy, /取消配对/);
  assert.match(busy, /role="status"/);
  assert.match(busy, /disabled=""/);
  const failed = renderToStaticMarkup(createElement(PairingDialog, {
    ...dialogProps(), error: pairingFailureMessage(4003),
  }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /无效、已使用或已过期/);
  assert.doesNotMatch(failed, /disabled=""/);
  assert.match(failed, /value="editable-code"/);
});

test('pairing timeouts, protocol failures and throttling have actionable errors', () => {
  assert.match(pairingFailureMessage(4001), /超时/);
  assert.match(pairingFailureMessage(4429), /15 分钟/);
  assert.match(pairingFailureMessage(4406), /刷新页面/);
  assert.match(pairingFailureMessage(4407), /身份验证失败/);
  assert.match(pairingFailureMessage(1006), /连接中断/);
});
