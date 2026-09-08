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

test('same-origin navigation rotates only its document, cancels old results and retains child lineage', async () => {
  const { broker, grant, events } = setup();
  const opening = broker.execute('thread-1', 'turn-1', { method: 'open_link', ref: 'link' });
  const child = broker.adopt(client, events[0].payload.requestId, grant.grantId, { ...target, tabId: 2, documentId: 'child' });
  broker.result(client, { ...events[0].payload, ok: true }); await opening;
  broker.heartbeat(client, child.grantId);
  const pending = broker.execute('thread-1', 'turn-1', { method: 'screenshot' }, grant.grantId);
  const rejected = assert.rejects(pending, /authorization_changed/);
  const next = broker.navigate(client, grant.grantId, { ...target, documentId: 'next' });
  await rejected;
  assert.notEqual(next.grantId, grant.grantId);
  assert.throws(() => broker.result(client, { ...events[1].payload, ok: true }), /request_expired/);
  await assert.rejects(broker.execute('thread-1', 'turn-1', { method: 'snapshot' }, next.grantId), /offline/);
  broker.heartbeat(client, next.grantId);
  assert.equal(broker.listPages('thread-1', 'turn-1').total, 2);
  assert.equal(broker.listPages('thread-2', 'turn-1').total, 0);
  broker.revoke(client, next.grantId);
  assert.equal(broker.listPages('thread-1', 'turn-1').total, 0);
  assert.throws(() => broker.heartbeat(client, child.grantId), /not_authorized/);
});

test('navigation cannot recreate consent, change tab/origin/device or borrow another connection', () => {
  const { broker, grant } = setup();
  const next = { ...target, documentId: 'next' };
  for (const invalid of [target, { ...next, tabId: 2 }, { ...next, origin: 'https://foreign.example' }, { ...next, browserDeviceId: 'other' }]) {
    assert.throws(() => broker.navigate(client, grant.grantId, invalid), /navigation_not_allowed/);
  }
  assert.throws(() => broker.navigate({ ...client, clientId: 'other-connection' }, grant.grantId, next), /not_authorized/);
  const ecs = new BrowserSessionBroker('ecs', () => false);
  assert.throws(() => ecs.navigate(client, grant.grantId, next), /not_authorized/);
  broker.revoke(client, grant.grantId);
  assert.throws(() => broker.navigate(client, grant.grantId, next), /not_authorized/);
});

test('explicit replacement recovers the same browser orphan and revokes its children and pending operations', async () => {
  const { broker, grant, events } = setup();
  const opening = broker.execute('thread-1', 'turn-1', { method: 'open_link', ref: 'link' });
  const child = broker.adopt(client, events[0].payload.requestId, grant.grantId, { ...target, tabId: 2, documentId: 'child' });
  broker.result(client, { ...events[0].payload, ok: true }); await opening;
  broker.heartbeat(client, child.grantId);
  const pending = broker.execute('thread-1', 'turn-1', { method: 'snapshot' }, child.grantId);
  const rejected = assert.rejects(pending, /authorization_changed/);
  const reconnected = { ...client, clientId: 'new-connection' };
  const next = await broker.validateAndBind(reconnected, 'thread-1', { ...target, tabId: 3, documentId: 'new-page' }, async () => ({}), { replaceExisting: true });
  await rejected;
  assert.equal(broker.status('thread-1').pageCount, 1);
  assert.equal(broker.status('thread-1').online, false, 'new document must acknowledge authorization first');
  broker.heartbeat(reconnected, next.grantId);
  assert.equal(broker.status('thread-1').online, true);
  assert.throws(() => broker.heartbeat(client, grant.grantId), /not_authorized/);
  assert.throws(() => broker.restore(client, grant.grantId, target), /restore_unavailable/);
  assert.throws(() => broker.heartbeat(client, child.grantId), /not_authorized/);
  assert.throws(() => broker.result(client, { ...events[1].payload, ok: true }), /request_expired/);
});

test('a different browser can replace only an entirely stale grant tree on explicit authorization', async () => {
  const { broker, grant, events, advance } = setup();
  const other = { clientId: 'other-client', clientDeviceId: 'other-browser' };
  const nextTarget = { ...target, browserDeviceId: other.clientDeviceId, tabId: 99 };
  const opening = broker.execute('thread-1', 'turn-1', { method: 'open_link', ref: 'link' });
  const child = broker.adopt(client, events[0].payload.requestId, grant.grantId, { ...target, tabId: 2, documentId: 'child' });
  broker.result(client, { ...events[0].payload, ok: true }); await opening;
  assert.throws(() => broker.bind(other, 'thread-1', nextTarget, { replaceExisting: true }), /session_already_bound/);
  advance(45_000); broker.heartbeat(client, child.grantId);
  assert.throws(() => broker.bind(other, 'thread-1', nextTarget, { replaceExisting: true }), /session_already_bound/);
  advance(45_000);
  assert.throws(() => broker.bind(other, 'thread-1', nextTarget), /session_already_bound/, 'offline does not expire consent');
  const next = broker.bind(other, 'thread-1', nextTarget, { replaceExisting: true });
  assert.equal(broker.status('thread-1').pageCount, 1);
  assert.equal(broker.listPages('thread-1', 'turn-1').pages[0].pageId, next.grantId);
  assert.throws(() => broker.restore(client, grant.grantId, target), /restore_unavailable/);
});

test('fresh unacknowledged grants cannot be taken by another browser and recovery cannot overwrite newer consent', () => {
  const { broker, grant } = setup();
  const other = { clientId: 'other-client', clientDeviceId: 'other-browser' };
  const fresh = broker.bind(client, 'thread-1', target);
  assert.throws(() => broker.bind(other, 'thread-1', { ...target, browserDeviceId: other.clientDeviceId }, { replaceExisting: true }), /session_already_bound/);
  assert.throws(() => broker.bind(client, 'thread-1', target, { recoverOnly: true }), /restore_unavailable/);
  assert.throws(() => broker.bind(client, 'another-thread', target, { recoverOnly: true }), /restore_unavailable/);
  assert.equal(broker.listPages('thread-1', 'turn-1').pages[0].pageId, fresh.grantId);
  broker.clear();
  const recovered = broker.bind(client, 'thread-1', target, { recoverOnly: true });
  assert.notEqual(recovered.grantId, grant.grantId);
});

test('failed validation preserves the old root and a delayed cross-tab replacement cannot override a newer click', async () => {
  const { broker, grant } = setup();
  await assert.rejects(broker.validateAndBind(client, 'thread-1', { ...target, tabId: 2 }, async () => { throw new Error('session_unavailable'); }, { replaceExisting: true }));
  assert.equal(broker.listPages('thread-1', 'turn-1').pages[0].pageId, grant.grantId);
  let release!: () => void;
  const delayed = broker.validateAndBind(client, 'thread-1', { ...target, tabId: 2 }, () => new Promise<void>((resolve) => { release = resolve; }), { replaceExisting: true });
  const rejected = assert.rejects(delayed, /authorization_changed/);
  const newest = await broker.validateAndBind(client, 'thread-1', { ...target, tabId: 3 }, async () => ({}), { replaceExisting: true });
  release(); await rejected;
  assert.equal(broker.listPages('thread-1', 'turn-1').pages[0].pageId, newest.grantId);
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
  const receivedOperations: unknown[] = [];
  broker = new BrowserSessionBroker('pc', (event: any) => {
    receivedOperations.push(event.payload.operation);
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
  const tools = await sdk.listTools(); assert.equal(tools.tools.length, 8);
  const guidanceChars = sdk.getInstructions()!.length + tools.tools.reduce((sum, tool) => sum + (tool.description?.length || 0), 0);
  assert.ok(guidanceChars < 4500, 'shared guidance and tool descriptions stay within the compact prose budget');
  const zoomTool = tools.tools.find(tool => tool.name === 'anywhere_browser_zoom')!;
  assert.equal(zoomTool.annotations?.readOnlyHint, false); assert.equal(zoomTool.annotations?.idempotentHint, true);
  assert.match(sdk.getInstructions()!, /prefer anywhere_browser_zoom/);
  assert.match(sdk.getInstructions()!, /NOT Codex in-app CUA/);
  const _meta = { 'x-codex-turn-metadata': { thread_id: 'thread-1', turn_id: 'turn-1' } };
  const result = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: {}, _meta });
  assert.match(JSON.stringify(result), /fixture-only/); assert.notEqual(result.isError, true);
  const denied = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: {} }); assert.equal(denied.isError, true);
  const wrong = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread_id: 'other', turn_id: 'turn-1' } } });
  assert.equal(wrong.isError, true);
  const spoof = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: { threadId: 'other' }, _meta }); assert.equal(spoof.isError, true);
  const pages = await sdk.callTool({ name: 'anywhere_browser_list_pages', arguments: {}, _meta });
  assert.equal(JSON.parse((pages.content as any[])[0].text).untrustedBrowserResult.state, 'ready');
  assert.match(JSON.stringify(pages), /authorized-root/);
  assert.match(JSON.stringify(pages), new RegExp(grant.grantId));
  const badPage = await sdk.callTool({ name: 'anywhere_browser_snapshot', arguments: { pageId: 'other' }, _meta });
  assert.equal(badPage.isError, true);
  assert.match(JSON.stringify(badPage), /list_pages/);
  const listSpoof = await sdk.callTool({ name: 'anywhere_browser_list_pages', arguments: { threadId: 'thread-1' }, _meta });
  assert.equal(listSpoof.isError, true);
  const unbound = await sdk.callTool({ name: 'anywhere_browser_list_pages', arguments: {},
    _meta: { 'x-codex-turn-metadata': { thread_id: 'unbound', turn_id: 'turn-1' } } });
  assert.notEqual(unbound.isError, true);
  assert.match(JSON.stringify(unbound), /no_authorized_page/);
  assert.doesNotMatch(JSON.stringify(unbound), new RegExp(grant.grantId));
  assert.doesNotMatch(JSON.stringify(unbound), /example\.com/);
  const panelScroll = await sdk.callTool({ name: 'anywhere_browser_scroll', arguments: { ref: 'panel-ref', deltaY: 200 }, _meta });
  assert.notEqual(panelScroll.isError, true);
  assert.match(JSON.stringify(panelScroll), /scroll/);
  const horizontal = await sdk.callTool({ name: 'anywhere_browser_scroll', arguments: { pageId: grant.grantId, ref: 'table-ref', deltaX: -450, deltaY: 0 }, _meta });
  assert.notEqual(horizontal.isError, true);
  assert.deepEqual(receivedOperations.at(-1), { method: 'scroll', ref: 'table-ref', deltaX: -450, deltaY: 0 });
  for (const percent of [50, 67, 80, 100, 125, 200]) {
    assert.deepEqual(parseOperation({ method: 'zoom', percent }), { method: 'zoom', percent });
    assert.notEqual((await sdk.callTool({ name: 'anywhere_browser_zoom', arguments: { pageId: grant.grantId, percent }, _meta })).isError, true);
    assert.deepEqual(receivedOperations.at(-1), { method: 'zoom', percent });
  }
  const beforeInvalid = receivedOperations.length;
  for (const args of [{}, { percent: 0 }, { percent: 49 }, { percent: 201 }, { percent: 80.5 }, { percent: '80' }, { percent: 80, tabId: 1 }, { percent: 80, threadId: 'other' }]) {
    assert.throws(() => parseOperation({ method: 'zoom', ...args }));
    assert.equal((await sdk.callTool({ name: 'anywhere_browser_zoom', arguments: args, _meta })).isError, true);
  }
  assert.equal((await sdk.callTool({ name: 'anywhere_browser_zoom', arguments: { percent: 80, pageId: 'wrong' }, _meta })).isError, true);
  assert.equal((await sdk.callTool({ name: 'anywhere_browser_zoom', arguments: { percent: 80 }, _meta: { 'x-codex-turn-metadata': { thread_id: 'other', turn_id: 'turn-1' } } })).isError, true);
  for (const args of [{ deltaX: 2001, deltaY: 0 }, { deltaX: 1.5, deltaY: 0 }, { deltaX: 10 }, { deltaX: 10, deltaY: 0, threadId: 'other' }]) {
    assert.equal((await sdk.callTool({ name: 'anywhere_browser_scroll', arguments: args, _meta })).isError, true);
  }
  assert.equal(receivedOperations.length, beforeInvalid, 'invalid MCP arguments never reach the browser');
  assert.equal((await sdk.callTool({ name: 'anywhere_browser_scroll', arguments: { deltaX: 100, deltaY: 0 },
    _meta: { 'x-codex-turn-metadata': { thread_id: 'other', turn_id: 'turn-1' } } })).isError, true);
});

test('page inventory distinguishes missing consent, offline grants and empty pagination without crossing Sessions', () => {
  const { broker, grant, advance } = setup();
  assert.equal(broker.listPages('thread-1', 'turn-1').state, 'ready');
  const emptyPage = broker.listPages('thread-1', 'turn-1', 10);
  assert.equal(emptyPage.pages.length, 0);
  assert.equal(emptyPage.state, 'ready'); assert.equal(emptyPage.total, 1);
  const other = broker.listPages('unbound', 'turn-1');
  assert.equal(other.state, 'no_authorized_page'); assert.equal(other.environmentId, 'pc');
  assert.equal(other.onlinePageCount, 0); assert.doesNotMatch(JSON.stringify(other), /example\.com|browser-1|thread-1/);
  advance(45_001);
  assert.equal(broker.listPages('thread-1', 'turn-1').state, 'authorized_pages_offline');
  broker.heartbeat(client, grant.grantId);
  assert.equal(broker.listPages('thread-1', 'turn-1').onlinePageCount, 1);
  broker.revoke(client, grant.grantId);
  assert.equal(broker.listPages('thread-1', 'turn-1').state, 'no_authorized_page');
});

test('specific page failures survive routing but arbitrary exception messages never reach the model', async () => {
  for (const code of ['browser_stale_element_read_again', 'browser_element_obscured', 'browser_number_value_invalid',
    'browser_option_not_available', 'browser_scroll_target_not_scrollable', 'browser_zoom_unavailable', 'browser_zoom_interrupted', 'browser_private_value', 'secret fixture']) {
    const { broker, grant, events } = setup();
    const pending = broker.execute('thread-1', 'turn-1', { method: 'fill', ref: 'fixture', text: '443' });
    const expected = ['browser_private_value', 'secret fixture'].includes(code) ? 'browser_operation_failed_or_authorization_changed' : code;
    const rejected = assert.rejects(pending, { message: expected });
    broker.result(client, { requestId: events[0].payload.requestId, grantId: grant.grantId, ok: false, errorCode: code });
    await rejected; broker.clear();
  }
  assert.deepEqual(parseOperation({ method: 'scroll', ref: 'panel', deltaY: 100 }), { method: 'scroll', ref: 'panel', deltaY: 100 });
  assert.deepEqual(parseOperation({ method: 'scroll', ref: 'panel', deltaY: 0, deltaX: -2000 }), { method: 'scroll', ref: 'panel', deltaY: 0, deltaX: -2000 });
  for (const patch of [{ ref: '' }, { deltaY: 2001 }, { deltaX: 2001 }, { deltaX: -2001 }, { deltaX: 0.5 }, { deltaX: '100' }, { deltaX: NaN }, { deltaX: null }, { text: 'wrong field' }, { ref: 'https://example.com' }]) {
    assert.throws(() => parseOperation({ method: 'scroll', deltaY: 100, ...patch }));
  }
});

test('only a live AI open operation can adopt same-origin children; root remains singular', async () => {
  const { broker, grant, events } = setup();
  const childTarget = { ...target, tabId: 2, documentId: 'child-doc' };
  assert.throws(() => broker.adopt(client, 'missing', grant.grantId, childTarget), /child_operation_required/);
  const opening = broker.execute('thread-1', 'turn-1', { method: 'open_link', ref: 'link-ref' });
  const event = events[0].payload;
  assert.throws(() => broker.adopt(client, event.requestId, grant.grantId, { ...childTarget, origin: 'https://other.com' }), /child_origin_denied/);
  const child = broker.adopt(client, event.requestId, grant.grantId, childTarget);
  assert.throws(() => broker.adopt(client, event.requestId, grant.grantId, { ...childTarget, tabId: 3 }), /child_operation_required/);
  broker.heartbeat(client, child.grantId);
  broker.result(client, { ...event, ok: true, result: { opened: true, pageId: child.grantId } });
  await opening;
  const listed = broker.listPages('thread-1', 'turn-1', 0, 1);
  assert.equal(listed.total, 2); assert.equal(listed.nextOffset, 1);
  assert.equal(broker.listPages('thread-1', 'turn-1', 1, 1).pages[0].kind, 'ai-opened');
  await assert.rejects(broker.execute('thread-1', 'turn-1', { method: 'snapshot' }), /selection_required/);
  await assert.rejects(broker.execute('other-thread', 'turn-1', { method: 'snapshot' }, child.grantId), /not_authorized/);
  assert.throws(() => broker.bind(client, 'thread-1', { ...target, tabId: 3 }), /session_already_bound/);
  const reading = broker.execute('thread-1', 'turn-1', { method: 'snapshot' }, child.grantId);
  assert.equal(events[1].payload.target.tabId, 2);
  const rejected = assert.rejects(reading, /authorization_changed/);
  broker.revoke(client, grant.grantId); await rejected;
  assert.equal(broker.listPages('thread-1', 'turn-1').total, 0);
});

test('authenticated reconnect preserves child provenance but rotates IDs; restart cannot restore unknown children', async () => {
  const { broker, grant, events } = setup();
  const opening = broker.execute('thread-1', 'turn-1', { method: 'open_link', ref: 'r' });
  const childTarget = { ...target, tabId: 2, documentId: 'child-doc' };
  const child = broker.adopt(client, events[0].payload.requestId, grant.grantId, childTarget);
  broker.result(client, { ...events[0].payload, ok: true }); await opening;
  const reconnected = { ...client, clientId: 'client-2' };
  assert.throws(() => broker.restore({ ...reconnected, clientDeviceId: 'other' }, child.grantId, childTarget), /restore_unavailable/);
  const rootNext = broker.restore(reconnected, grant.grantId, target);
  const childNext = broker.restore(reconnected, child.grantId, childTarget);
  assert.notEqual(rootNext.grantId, grant.grantId); assert.notEqual(childNext.grantId, child.grantId);
  assert.equal(broker.status('thread-1').lastToolSuccessAt, null);
  await assert.rejects(broker.execute('thread-1', 'turn-1', { method: 'snapshot' }, child.grantId), /not_authorized/);
  broker.revoke(reconnected, rootNext.grantId);
  assert.equal(broker.listPages('thread-1', 'turn-1').total, 0);
  assert.throws(() => broker.restore(reconnected, childNext.grantId, childTarget), /restore_unavailable/);
});
