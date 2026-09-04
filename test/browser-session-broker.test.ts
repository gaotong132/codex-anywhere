import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { createBrowserMcpServer } from '../src/browser-control/mcp-server.js';
import { startBrowserEndpoint } from '../src/browser-control/local-endpoint.js';
import { codexCaller, parseOperation } from '../src/browser-control/operations.js';
import { internals } from '../src/server/server.js';

const client = { clientId: 'client-1', clientDeviceId: 'browser-1' };
const target = { browserDeviceId: 'browser-1', tabId: 1, documentId: 'document-1', origin: 'https://example.com' };
function setup(timeout = 1000) {
  let now = 1_000_000;
  const events: any[] = [];
  const broker = new BrowserSessionBroker('pc', (event) => { events.push(event); return true; }, () => now, timeout);
  const grant = broker.bind(client, 'thread-1', target);
  broker.heartbeat(client, grant.grantId);
  return { broker, grant, events, advance: (time: number) => { now += time; } };
}
test('browser broker binds only the authenticated device and one target per Session', () => {
  const { broker } = setup();
  assert.throws(() => broker.bind({ ...client, clientDeviceId: 'other' }, 'thread-2', target), /device_mismatch/);
  assert.throws(() => broker.bind(client, 'thread-1', { ...target, tabId: 2 }), /session_already_bound/);
  assert.deepEqual(broker.status('thread-2'), { authorized: false, online: false });
});
test('a delayed Session validation cannot overwrite newer consent or survive connector disconnect', async () => {
  for (const action of ['replace', 'disconnect'] as const) {
    const { broker } = setup();
    let release!: () => void;
    const old = broker.validateAndBind(client, 'old-task', target, () => new Promise<void>((resolve) => { release = resolve; }));
    const rejected = assert.rejects(old, /authorization_changed/);
    if (action === 'replace') await broker.validateAndBind(client, 'new-task', target, async () => ({}));
    else broker.clear();
    release(); await rejected;
    assert.equal(broker.status('old-task').authorized, false);
    assert.equal(broker.status('new-task').authorized, action === 'replace');
  }
});
test('browser consent survives ten minutes and heartbeat timeout only marks offline', async () => {
  const { broker, grant, advance } = setup(); advance(11 * 60_000);
  assert.equal(broker.status('thread-1').authorized, true);
  await assert.rejects(broker.execute('thread-1', 'turn-1', { method: 'snapshot' }), /browser_offline/);
  broker.heartbeat(client, grant.grantId);
  assert.equal(broker.status('thread-1').online, true);
});
test('a registered grant cannot operate until the page confirms readiness', async () => {
  const { broker } = setup();
  const grant = broker.bind(client, 'thread-1', target);
  assert.equal(broker.status('thread-1').online, false);
  await assert.rejects(broker.execute('thread-1', 'turn-1', { method: 'snapshot' }), /offline/);
  broker.heartbeat(client, grant.grantId);
  assert.equal(broker.status('thread-1').online, true);
});
test('matching Session and browser IDs in another environment cannot inherit authority', async () => {
  const { broker: pc } = setup();
  const ecs = new BrowserSessionBroker('ecs', () => assert.fail('unauthorized environment dispatched'));
  assert.equal(pc.status('thread-1').authorized, true);
  await assert.rejects(ecs.execute('thread-1', 'turn-1', { method: 'snapshot' }), /not_authorized/);
  assert.equal(ecs.status('thread-1').authorized, false);
});
test('wrong Session never dispatches; wrong client cannot inject operation results', async () => {
  const { broker, grant, events } = setup();
  await assert.rejects(broker.execute('other-thread', 'turn-1', { method: 'click', ref: 'ref-1' }), /not_authorized_for_this_session/);
  assert.equal(events.length, 0);
  const pending = broker.execute('thread-1', 'turn-1', { method: 'snapshot' });
  const result = { requestId: events[0].payload.requestId, grantId: grant.grantId, ok: true, result: { text: 'fixture' } };
  assert.throws(() => broker.result({ ...client, clientId: 'foreign' }, result), /not_authorized/);
  broker.result(client, result); assert.deepEqual(await pending, { text: 'fixture' });
  assert.throws(() => broker.result(client, result), /request_expired/);
});
test('revocation, rebinding and disconnect cancel pending operations', async () => {
  for (const action of ['revoke', 'bind', 'clear'] as const) {
    const { broker, grant, events } = setup();
    const pending = broker.execute('thread-1', 'turn-1', { method: 'snapshot' });
    const rejected = assert.rejects(pending, /authorization_changed/);
    if (action === 'revoke') broker.revoke(client, grant.grantId);
    if (action === 'bind') broker.bind(client, 'thread-2', target);
    if (action === 'clear') broker.clear();
    await rejected;
    assert.throws(() => broker.result(client, { requestId: events[0].payload.requestId, grantId: grant.grantId }), /request_expired/);
  }
});
test('one in-flight operation, bounded result, timeout and no automatic write retries', async () => {
  const { broker, grant, events } = setup(20);
  const pending = broker.execute('thread-1', 'turn-1', { method: 'click', ref: 'ref-1' });
  await assert.rejects(broker.execute('thread-1', 'turn-1', { method: 'snapshot' }), /browser_busy/);
  assert.throws(() => broker.result(client, { requestId: events[0].payload.requestId, grantId: grant.grantId, result: 'x'.repeat(25_000) }), /too_large/);
  await assert.rejects(pending, /timeout_do_not_retry/); assert.equal(events.length, 1);
});
test('MCP caller context is host metadata, never model arguments or a default Session', () => {
  assert.deepEqual(codexCaller({ 'x-codex-turn-metadata': { thread_id: 'thread-1', turn_id: 'turn-1' } }), { threadId: 'thread-1', turnId: 'turn-1' });
  for (const meta of [undefined, {}, { threadId: 'thread-1' }, { threadId: 'wrong', 'x-codex-turn-metadata': { thread_id: 'thread-1', turn_id: 'turn-1' } }]) assert.throws(() => codexCaller(meta));
  assert.throws(() => parseOperation({ method: 'snapshot', threadId: 'other' }));
  assert.throws(() => parseOperation({ method: 'evaluate', code: 'alert(1)' }));
  assert.throws(() => parseOperation({ method: 'fill', ref: 'r', text: 'x'.repeat(4001) }));
});
test('Relay allows only exact configured extension Origins; web-origin policy is unchanged', () => {
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const request = (origin: string) => ({ headers: { origin, host: 'example.com' } }) as any;
  assert.equal(internals.originAllowed(request(origin)), false);
  assert.equal(internals.originAllowed(request(origin), [origin]), true);
  assert.equal(internals.originAllowed(request(origin + '/'), [origin]), false);
  assert.equal(internals.originAllowed(request('https://evil.com'), [origin]), false);
  assert.equal(internals.originAllowed(request('https://example.com'), [origin]), true);
});
test('official MCP SDK → private loopback → exact Session broker round trip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anywhere-browser-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let broker: BrowserSessionBroker;
  broker = new BrowserSessionBroker('pc', (event: any) => {
    queueMicrotask(() => broker.result(client, { ...event.payload, ok: true, result: { text: 'fixture-only', method: event.payload.operation.method } })); return true;
  });
  const grant = broker.bind(client, 'thread-1', target);
  broker.heartbeat(client, grant.grantId);
  const stateFile = join(dir, 'endpoint.json');
  const endpoint = await startBrowserEndpoint(broker, stateFile); t.after(() => endpoint.close());
  assert.match(await readFile(stateFile, 'utf8'), /127|port/);
  const server = createBrowserMcpServer(stateFile);
  const sdk = new Client({ name: 'browser-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), sdk.connect(right)]);
  t.after(async () => { await sdk.close(); await server.close(); });
  const tools = await sdk.listTools(); assert.equal(tools.tools.length, 4);
  const _meta = { 'x-codex-turn-metadata': { thread_id: 'thread-1', turn_id: 'turn-1' } };
  const result = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: {}, _meta });
  assert.match(JSON.stringify(result), /fixture-only/); assert.notEqual(result.isError, true);
  const denied = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: {} }); assert.equal(denied.isError, true);
  const wrong = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread_id: 'other', turn_id: 'turn-1' } } });
  assert.equal(wrong.isError, true);
  const spoof = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: { threadId: 'other' }, _meta }); assert.equal(spoof.isError, true);
});
