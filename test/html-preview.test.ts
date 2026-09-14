import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from 'linkedom';
import { isHtmlFilePath, prepareHtmlPreview } from '../web/src/html-preview';
import { createBridgeServer } from '../src/server/server.js';

test('HTML preview resolves only declared local links and raster images, keeping source markup intact', () => {
  const original = globalThis.DOMParser;
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
  try {
    const source = '<html><head><base href="https://example.com/"></head><body><style>body{color:red}</style>'
      + '<a href="../slides/index.html">slides</a><a href="#section">anchor</a><a href="https://example.com/">external</a>'
      + '<img src="../images/slide.png" srcset="../secret.png 2x"><img src="data:image/png;base64,AA==">'
      + '<span data-anywhere-image="99" data-anywhere-link="99">untrusted marker</span></body></html>';
    const result = prepareHtmlPreview(source, 'D:\\reports\\review\\index.html');
    assert.deepEqual(result.links, ['D:\\reports\\review\\..\\slides\\index.html']);
    assert.deepEqual(result.images, ['D:\\reports\\review\\..\\images\\slide.png']);
    assert.match(result.html, /<style>body\{color:red\}<\/style>/);
    assert.match(result.html, /href="#section"/);
    assert.match(result.html, /href="https:\/\/example.com\/"/);
    assert.doesNotMatch(result.html, /<base|srcset=|data-anywhere-(?:image|link)="99"/);
    assert.match(result.html, /data-anywhere-image="0"/);
    assert.equal(isHtmlFilePath('INDEX.HTM'), true);
    assert.equal(isHtmlFilePath('index.html.txt'), false);
  } finally { globalThis.DOMParser = original; }
});

test('the empty HTML renderer is sandboxed while the application keeps its strict CSP', async t => {
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const server = createBridgeServer({ connectorToken: 'html-preview-test-token-at-least-32-characters', extensionOrigins: [extensionOrigin] });
  const address = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const frame = await fetch(origin + '/html-preview');
  assert.equal(frame.status, 200);
  const policy = frame.headers.get('content-security-policy')!;
  assert.match(policy, /sandbox allow-scripts;/);
  assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, new RegExp(`frame-ancestors 'self' ${extensionOrigin}`));
  assert.equal(frame.headers.get('x-frame-options'), null);
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.match(await frame.text(), /event.source !== parent/);
  const head = await fetch(origin + '/html-preview', { method: 'HEAD' });
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  const app = await fetch(origin + '/config.js');
  assert.match(app.headers.get('content-security-policy')!, /style-src 'self'; script-src 'self';/);
  assert.equal(app.headers.get('x-frame-options'), 'DENY');
});
