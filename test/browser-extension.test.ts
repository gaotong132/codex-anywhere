import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { collectLocalSnapshot } from '../extension/src/snapshot.js';

function page(body: string): Document {
  const { document } = parseHTML(`<html><head></head><body>${body}</body></html>`);
  Object.defineProperty(document, 'location', { value: new URL('https://example.com/path?secret=test#private') });
  return document;
}

test('browser extension is local-only and requests only explicit tab access', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  for (const field of ['host_permissions', 'externally_connectable', 'web_accessible_resources', 'content_scripts']) assert.equal(manifest[field], undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  const source = await readFile('extension/src/background.ts', 'utf8');
  assert.match(source, /sender\.url !== chrome\.runtime\.getURL\('popup.html'\)/);
  assert.match(source, /documentIds: \[target.documentId\]/);
  assert.match(source, /chrome\.tabs\.onRemoved/);
  assert.match(source, /chrome\.tabs\.onUpdated/);
});

test('local snapshot excludes form values, editable and private regions, and URL secrets', () => {
  const doc = page('<h1>Public title</h1><p>Hello <b>world</b></p><input value="password-secret"><textarea>textarea-secret</textarea><select><option>option-secret</option></select><div contenteditable>draft-secret</div><div hidden>hidden-secret</div><div aria-hidden="true">aria-secret</div><div data-anywhere-private>marked-secret</div><script>script-secret</script><iframe srcdoc="frame-secret"></iframe>');
  const result = collectLocalSnapshot({ maxNodes: 100, maxChars: 8_000 }, doc);
  const text = JSON.stringify(result);
  assert.match(text, /Public title/);
  assert.match(text, /world/);
  assert.doesNotMatch(text, /secret|private|\/path/);
  assert.equal(result.origin, 'https://example.com');
});

test('local snapshot treats markup as text and bounds traversal and output', () => {
  const doc = page('<p></p><p>Later</p>');
  doc.querySelector('p')!.textContent = '<script>alert(1)</script>';
  const result = collectLocalSnapshot({ maxNodes: 2, maxChars: 12 }, doc);
  assert.ok(result.nodes.reduce((sum, node) => sum + node.text.length, 0) <= 12);
  assert.equal(result.truncated, true);
  assert.match(result.nodes[0].text, /<script>/);
  const long = collectLocalSnapshot({ maxNodes: 2, maxChars: 100 }, page('<p>One</p><p>Two</p><p>Three</p>'));
  assert.equal(long.nodes.length, 2);
  assert.equal(long.truncated, true);
  const deep = collectLocalSnapshot({ maxNodes: 200, maxChars: 16_000 }, page('<div></div>'.repeat(5_010) + '<p>too late</p>'));
  assert.equal(deep.truncated, true);
  assert.equal(deep.nodes.length, 0);
});

test('snapshot injection does not depend on module closures', () => {
  const isolated = new Function(`return (${collectLocalSnapshot.toString()})`)() as typeof collectLocalSnapshot;
  assert.equal(isolated({ maxNodes: 10, maxChars: 100 }, page('<p>Standalone</p>')).nodes[0].text, 'Standalone');
});

test('snapshot marks depth/whitespace limits and excludes CSS-hidden ancestors', () => {
  const options = { maxNodes: 100, maxChars: 8_000 };
  const deep = collectLocalSnapshot(options, page('<div>'.repeat(70) + 'too deep' + '</div>'.repeat(70)));
  assert.equal(deep.nodes.length, 0);
  assert.equal(deep.truncated, true);
  const whitespace = collectLocalSnapshot(options, page(`<p>${' '.repeat(8_002)}unread</p>`));
  assert.equal(whitespace.nodes.length, 0);
  assert.equal(whitespace.truncated, true);
  const doc = page('<div class="hidden"><p>hidden-secret</p></div><p>Visible</p>');
  Object.defineProperty(doc, 'defaultView', { value: {
    getComputedStyle: (element: Element) => ({ display: element.classList.contains('hidden') ? 'none' : 'block' }),
  } });
  const result = collectLocalSnapshot(options, doc);
  assert.match(JSON.stringify(result), /Visible/);
  assert.doesNotMatch(JSON.stringify(result), /hidden-secret/);
});
