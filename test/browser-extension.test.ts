import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseBrowserTarget } from '../src/browser-control/contracts.js';
import { parseConnectionUrl } from '../extension/src/connection.js';

test('extension keeps explicit activeTab grants, no broad host, debugger or content-script access', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  for (const field of ['host_permissions', 'externally_connectable', 'web_accessible_resources', 'content_scripts']) assert.equal(manifest[field], undefined);
  const connectSources = manifest.content_security_policy.extension_pages.split(';')
    .map((directive: string) => directive.trim().split(/\s+/)).find((directive: string[]) => directive[0] === 'connect-src');
  // No invalid IPv6 literal or broad ws: fallback: plaintext is loopback-only.
  assert.deepEqual(connectSources, ['connect-src', 'wss:', 'ws://127.0.0.1:*', 'ws://localhost:*']);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval|https?:\/\/\*/);
  const popup = await readFile('extension/popup.html', 'utf8');
  assert.doesNotMatch(popup, /10 分钟|读取页面|停止并清除|只读预览/);
  assert.match(popup, /继续哪个 Session/);
  const source = await readFile('extension/src/background.ts', 'utf8');
  assert.match(source, /sender\.url !== chrome\.runtime\.getURL\('popup.html'\)/);
  assert.match(source, /documentIds: \[target.documentId\]/);
  assert.match(source, /chrome\.tabs\.onRemoved/);
  assert.match(source, /chrome\.tabs\.onUpdated/);
});
test('tab coordinates and remote connection addresses reject unsafe or ambiguous input', () => {
  const target = { browserDeviceId: 'browser', tabId: 1, documentId: 'doc', origin: 'https://example.com' };
  assert.deepEqual(parseBrowserTarget(target), target);
  for (const patch of [{ tabId: -1 }, { tabId: 1.5 }, { documentId: '' }, { origin: 'file:///tmp' }, { origin: 'https://example.com/path' }, { origin: 'https://user:secret@example.com' }, { threadId: 'spoof' }]) assert.throws(() => parseBrowserTarget({ ...target, ...patch }));
  assert.equal(parseConnectionUrl('https://example.com/').socketUrl, 'wss://example.com/ws');
  assert.equal(parseConnectionUrl('http://127.0.0.1:3300/').socketUrl, 'ws://127.0.0.1:3300/ws');
  assert.equal(parseConnectionUrl('http://localhost:3300/').socketUrl, 'ws://localhost:3300/ws');
  assert.equal(parseConnectionUrl('https://[::1]:3300/').socketUrl, 'wss://[::1]:3300/ws');
  for (const url of ['http://example.com/', 'https://user:secret@example.com', 'file:///tmp', 'https://example.com/?secret=test']) assert.throws(() => parseConnectionUrl(url));
});

test('HTTP IPv6 literals fail before opening a WebSocket that CSP would block', () => {
  for (const url of ['http://[::1]:3300/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/']) {
    assert.throws(() => parseConnectionUrl(url), { message: 'browser_https_url_required' });
  }
});
