import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { createBrowserMcpServer } from '../src/browser-control/mcp-server.js';
import { startBrowserEndpoint } from '../src/browser-control/local-endpoint.js';
import { parseOperation } from '../src/browser-control/operations.js';
import { parseScreenshot, SCREENSHOT_MAX_BYTES, SCREENSHOT_TIMEOUT_MS } from '../src/browser-control/screenshot.js';

const client = { clientId: 'client-1', clientDeviceId: 'browser-1' };
const target = { browserDeviceId: 'browser-1', tabId: 7, documentId: 'document-1', origin: 'https://example.com' };
const jpeg = await sharp(randomBytes(320 * 240 * 3), { raw: { width: 320, height: 240, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
const screenshot = { kind: 'screenshot', mimeType: 'image/jpeg', data: jpeg.toString('base64'), width: 320, height: 240,
  origin: target.origin, redactedRegions: 2 };

test('screenshot boundary accepts a real JPEG and rejects invalid encodings, dimensions, origins and fields', () => {
  assert.ok(screenshot.data.length > 32_000, 'fixture exercises the larger image transport');
  assert.deepEqual(parseScreenshot(screenshot), screenshot);
  const noScan = jpeg.subarray(0, jpeg.indexOf(Buffer.from([255, 218])));
  for (const change of [
    { data: 'not base64' }, { data: Buffer.from('not an image').toString('base64') },
    { data: Buffer.concat([noScan, Buffer.from([255, 217])]).toString('base64') },
    { data: jpeg.subarray(0, -2).toString('base64') }, { data: Buffer.alloc(SCREENSHOT_MAX_BYTES + 1).toString('base64') },
    { width: 1921 }, { width: 319 }, { height: 0 }, { height: 239 }, { redactedRegions: -1 }, { redactedRegions: 20_001 },
    { origin: 'https://example.com/path' }, { origin: 'chrome://settings' }, { mimeType: 'image/png' }, { path: '/private/image.jpg' },
  ]) assert.throws(() => parseScreenshot({ ...screenshot, ...change }), /browser_screenshot_invalid/);
  assert.deepEqual(parseOperation({ method: 'screenshot' }), { method: 'screenshot' });
  for (const field of ['tabId', 'threadId', 'fullPage', 'code', 'format']) {
    assert.throws(() => parseOperation({ method: 'screenshot', [field]: true }));
  }
});

test('broker carries image bytes only for screenshot and binds the result to the authorized origin', async () => {
  const events: any[] = [];
  const now = 1_000_000;
  const broker = new BrowserSessionBroker('pc', event => { events.push(event); return true; }, () => now);
  const grant = broker.bind(client, 'thread-1', target); broker.heartbeat(client, grant.grantId);
  try {
    await assert.rejects(broker.execute('foreign-thread', 'turn-1', { method: 'screenshot' }), /not_authorized/);
    assert.equal(events.length, 0);
    const pending = broker.execute('thread-1', 'turn-1', { method: 'screenshot' }, grant.grantId);
    assert.equal(events[0].payload.deadline, now + SCREENSHOT_TIMEOUT_MS);
    assert.deepEqual(events[0].payload.target, target);
    assert.throws(() => broker.result(client, { ...events[0].payload, ok: true, result: { ...screenshot, origin: 'https://other.example' } }), /screenshot_invalid/);
    broker.result(client, { ...events[0].payload, ok: true, result: screenshot });
    assert.deepEqual(await pending, screenshot);
    const text = broker.execute('thread-1', 'turn-1', { method: 'snapshot' });
    const rejected = assert.rejects(text, /authorization_changed/);
    assert.throws(() => broker.result(client, { ...events[1].payload, ok: true, result: screenshot }), /too_large/);
    broker.clear(); await rejected;
  } finally { broker.clear(); }
});

test('revoking or replacing the document discards an in-flight screenshot', async () => {
  for (const action of ['revoke', 'replace', 'disconnect']) {
    const events: any[] = [];
    const broker = new BrowserSessionBroker('pc', event => { events.push(event); return true; });
    const grant = broker.bind(client, 'thread-1', target); broker.heartbeat(client, grant.grantId);
    const pending = broker.execute('thread-1', 'turn-1', { method: 'screenshot' });
    const rejected = assert.rejects(pending, /authorization_changed/);
    if (action === 'revoke') broker.revoke(client, grant.grantId);
    else if (action === 'replace') broker.bind(client, 'thread-1', { ...target, documentId: 'new-document' }, { replaceExisting: true });
    else broker.clear();
    await rejected;
    assert.throws(() => broker.result(client, { ...events[0].payload, ok: true, result: screenshot }), /request_expired/);
    broker.clear();
  }
});

test('official MCP client receives native image content through the private endpoint, never Base64 text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-screenshot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let response: unknown = screenshot;
  let count = 0;
  const broker = new BrowserSessionBroker('pc', event => {
    count++;
    queueMicrotask(() => {
      try { broker.result(client, { ...event.payload, ok: true, result: response }); }
      catch (error) { broker.result(client, { ...event.payload, ok: false, errorCode: (error as Error).message }); }
    });
    return true;
  });
  t.after(() => broker.clear());
  const grant = broker.bind(client, 'thread-1', target); broker.heartbeat(client, grant.grantId);
  const file = join(directory, 'endpoint.json');
  const endpoint = await startBrowserEndpoint(broker, file); t.after(() => endpoint.close());
  const server = createBrowserMcpServer(file), sdk = new Client({ name: 'screenshot-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), sdk.connect(right)]);
  t.after(async () => { await sdk.close(); await server.close(); });
  const tool = (await sdk.listTools()).tools.find(tool => tool.name === 'anywhere_browser_screenshot');
  assert.ok(tool); assert.equal(tool.annotations?.readOnlyHint, true);
  const _meta = { 'x-codex-turn-metadata': { thread_id: 'thread-1', turn_id: 'turn-1' } };
  const call = (args: Record<string, unknown>, meta: any = _meta) => sdk.callTool({ name: tool.name, arguments: args, _meta: meta });
  const result = await call({ pageId: grant.grantId });
  assert.notEqual(result.isError, true);
  const content = result.content as any[];
  assert.equal(content[1].type, 'image'); assert.equal(content[1].mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(content[1].data, 'base64'), jpeg);
  assert.ok(content[0].text.length < 500); assert.doesNotMatch(content[0].text, /"data"/);
  assert.equal((result.structuredContent as any).untrustedBrowserResult.pageId, grant.grantId);
  assert.equal((result.structuredContent as any).untrustedBrowserResult.width, 320);
  const before = count;
  for (const args of [{ tabId: 7 }, { threadId: 'thread-1' }, { fullPage: true }, { code: 'x' }, { pageId: 'foreign' }]) {
    assert.equal((await call(args)).isError, true);
  }
  assert.equal((await call({}, {})).isError, true);
  assert.equal((await call({}, { 'x-codex-turn-metadata': { thread_id: 'foreign', turn_id: 'turn-1' } })).isError, true);
  assert.equal(count, before, 'invalid requests never reach the browser');
  response = { ...screenshot, width: 1 };
  const invalid = await call({});
  assert.equal(invalid.isError, true); assert.ok(!(invalid.content as any[]).some(item => item.type === 'image'));
  assert.match(JSON.stringify(invalid), /browser_screenshot_invalid/);
});
