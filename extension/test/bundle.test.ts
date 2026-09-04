import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { WebSocket } from 'ws';
import { parseHTML } from 'linkedom';
import { createBridgeServer } from '../../src/server/server.js';
import { createDeviceAuthProof, createDeviceIdentity } from '../../src/shared/device-auth.js';
import { createConnectorAuthProof } from '../../src/shared/auth.js';
import { encodeBrowserPairingCredential } from '../../src/shared/pairing-auth.js';
import { requireCurrentProtocol } from '../../src/shared/protocol-contract.js';
import { ConnectorSecureChannels } from '../../src/connector/secure-channels.js';
import { BrowserSessionBroker } from '../../src/browser-control/session-broker.js';

type Frame = Record<string, any>;
const extensionId = 'a'.repeat(32);
const popup = `chrome-extension://${extensionId}/popup.html`;
const TOKEN = 'browser-integration-test-connector-token-123456';

async function harness(t: test.TestContext) {
  const relay = createBridgeServer({ connectorToken: TOKEN, extensionOrigins: [`chrome-extension://${extensionId}`] });
  const address = await relay.listen(0, '127.0.0.1');
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const connectorIdentity = createDeviceIdentity();
  const registration = relay.deviceRegistry.requestPairing({ role: 'connector', routeDeviceId: 'pc', address: '127.0.0.1',
    device: { ...connectorIdentity, signature: '0'.repeat(128) } });
  relay.deviceRegistry.approve(registration.requestId);
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`);
  const broker = new BrowserSessionBroker('pc', (frame) => channels.sendEvent(frame));
  const channels = new ConnectorSecureChannels({ identity: connectorIdentity, deviceId: 'pc',
    send: (frame) => { socket.send(JSON.stringify(frame)); return true; },
    handleRequest: async (frame) => {
      try {
        const p = frame.payload;
        const client = { clientId: frame.clientId, clientDeviceId: frame.clientDeviceId };
        let data: unknown;
        if (frame.action === 'connector.status') data = { capabilities: { browserControl: true } };
        else if (frame.action === 'sessions.list') data = { sessions: [{ id: 'task-a', title: 'Fixture A' }, { id: 'task-b', title: 'Fixture B' }] };
        else if (frame.action === 'browser.bind') data = broker.bind(client, p.threadId, p.target);
        else if (frame.action === 'browser.adopt') data = broker.adopt(client, p.operationRequestId, p.parentGrantId, p.target);
        else if (frame.action === 'browser.restore') data = broker.restore(client, p.grantId, p.target);
        else if (frame.action === 'browser.heartbeat') data = broker.heartbeat(client, p.grantId);
        else if (frame.action === 'browser.revoke') data = broker.revoke(client, p.grantId);
        else if (frame.action === 'browser.result') data = broker.result(client, p);
        else throw new Error('unexpected_action');
        return { type: 'response', clientId: frame.clientId, requestId: frame.requestId, ok: true, data };
      } catch (error) { return { type: 'response', clientId: frame.clientId, requestId: frame.requestId, ok: false, error: (error as Error).message }; }
    },
  });
  let authDone!: () => void;
  const authenticated = new Promise<void>((resolve) => { authDone = resolve; });
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'auth.challenge') {
      const proof = createConnectorAuthProof(TOKEN, frame.challenge, 'pc');
      socket.send(JSON.stringify({ type: 'auth.connector', role: 'connector', deviceId: 'pc', proof, protocol: requireCurrentProtocol(frame.protocol),
        device: createDeviceAuthProof(connectorIdentity, { challenge: frame.challenge, role: 'connector', routeDeviceId: 'pc', authProof: proof }) }));
    } else if (frame.type === 'auth.ok') authDone();
    else void channels.handle(frame);
  });
  await authenticated;
  let onMessage!: (message: Frame, sender: Frame, respond: (reply: Frame) => void) => boolean;
  let onUpdated!: (tabId: number, change: Frame) => void;
  let onRemoved!: (tabId: number) => void;
  let activeTab = 1;
  let sitePermission = false;
  let createdTabs = 0;
  let clicks = 0;
  let injections = 0;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const sockets: WebSocket[] = [];
  function makePage(id: number, url: string) {
  const { document, window } = parseHTML(`<html><body><h1>Fixture page ${id}</h1><button id="safe">Increment</button><a href="https://example.com/child" target="_blank">Open child</a><a href="https://foreign.example/child">Cross origin</a><input id="search" type="text" placeholder="Search"><input type="password" value="secret-password"><textarea>secret-draft</textarea><select><option>secret-option</option></select><div hidden>hidden-secret</div></body></html>`);
  for (const node of document.querySelectorAll('*')) Object.defineProperty(node, 'getBoundingClientRect', { value: () => ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, bottom: 30, right: 110 }) });
  document.querySelector('#safe')!.addEventListener('click', () => { clicks++; });
  Object.defineProperty(document, 'elementFromPoint', { value: () => document.querySelector('#safe') });
  const pageContext = createContext({ document, location: new URL(url), crypto, URL,
    Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_ELEMENT: 1 }, innerHeight: 800, innerWidth: 1200,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLAnchorElement: window.HTMLAnchorElement, Event: window.Event,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), window: { scrollBy: () => {} },
  });
  return { document, pageContext, documentId: id === 1 ? 'doc-a' : `doc-${id}`, url };
  }
  const pages = new Map([[1, makePage(1, 'https://example.com/private?secret=query')]]);
  const document = pages.get(1)!.document;
  const storage = () => {
    const values: Frame = {};
    return { values, setAccessLevel: async (value: Frame) => assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'),
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])),
      set: async (data: Frame) => Object.assign(values, data), remove: async (key: string) => { delete values[key]; } };
  };
  const local = storage(); const session = storage();
  const badges: Frame[] = [];
  const chrome = {
    permissions: { contains: async () => sitePermission },
    storage: { local, session },
    action: { setBadgeText: async (value: Frame) => { badges.push(value); }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    runtime: { id: extensionId, getURL: () => popup, onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } } },
    tabs: { query: async () => [{ id: activeTab, url: pages.get(activeTab)!.url }],
      create: async (options: Frame) => { const id = pages.size + 1; createdTabs++; assert.ok(pages.has(options.openerTabId)); pages.set(id, makePage(id, options.url)); return { id }; },
      get: async (id: number) => ({ id, url: pages.get(id)!.url, status: 'complete' }),
      onUpdated: { addListener: (listener: typeof onUpdated) => { onUpdated = listener; } }, onRemoved: { addListener: (listener: typeof onRemoved) => { onRemoved = listener; } } },
    scripting: { executeScript: async (options: Frame) => {
      assert.equal(options.world, 'ISOLATED');
      const fixture = pages.get(options.target.tabId)!;
      assert.ok(fixture, 'only known fixture tabs may be injected');
      const { pageContext, documentId } = fixture;
      if (options.target.documentIds && options.target.documentIds[0] !== documentId) throw new Error('document_replaced');
      injections++;
      pageContext.args = options.args ?? [];
      let result;
      try { result = runInContext(`(${options.func.toString()})(...args)`, pageContext, { timeout: 1000 }); }
      catch (error) { t.diagnostic(`Fixture ${options.args?.[0]?.operation?.method}: ${(error as Error).message}`); throw error; }
      return [{ documentId, result }];
    } },
  };
  class BrowserSocket extends WebSocket {
    constructor(url: string) { super(url, { origin: `chrome-extension://${extensionId}` }); sockets.push(this); }
  }
  const context = createContext({ chrome, URL, crypto, TextEncoder, TextDecoder, WebSocket: BrowserSocket, AbortController,
    setTimeout, clearTimeout, setInterval: (callback: () => void, delay: number) => { const timer = setInterval(callback, delay); intervals.add(timer); return timer; },
    clearInterval: (timer: ReturnType<typeof setInterval>) => { clearInterval(timer); intervals.delete(timer); },
  });
  runInContext(await readFile('extension/dist/background.js', 'utf8'), context, { timeout: 1000 });
  const sender = { id: extensionId, url: popup };
  const send = (type: string, payload: Frame = {}) => new Promise<Frame>((resolve, reject) => {
    if (!onMessage({ type, ...payload }, sender, resolve)) reject(new Error('popup_rejected'));
  });
  t.after(async () => {
    await send('disconnect');
    for (const timer of intervals) clearInterval(timer);
    for (const connection of sockets) connection.terminate();
    broker.clear(); channels.clear(); socket.terminate(); await relay.close();
  });
  const pairing = relay.deviceRegistry.createBrowserPairing();
  return { broker, send, sender, receive: (...args: Parameters<typeof onMessage>) => onMessage(...args),
    pairUrl: `${origin}/#pair=${encodeBrowserPairingCredential(pairing.credential)}`, origin,
    local, session, badges, document, clicks: () => clicks, injections: () => injections,
    dropConnection: () => { for (const client of relay.clients.values()) client.close(1001, 'test disconnect'); },
    allowChildren: () => { sitePermission = true; }, createdTabs: () => createdTabs,
    manualTab: () => { const id = pages.size + 1; pages.set(id, makePage(id, 'https://example.com/manual')); activeTab = id; return id; },
    navigate: (id = 1) => onUpdated(id, { status: 'loading' }), close: (id = 1) => onRemoved(id), replace: () => { pages.get(1)!.documentId = 'doc-b'; } };
}

test('built extension pairs over real WS/E2E, selects original Session, reads/clicks/fills, and revokes', async (t) => {
  const h = await harness(t);
  const connected = await h.send('connect', { url: h.pairUrl });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  assert.equal(connected.result.connected, true);
  assert.deepEqual(JSON.parse(JSON.stringify(connected.result.devices)), ['pc']);
  assert.doesNotMatch(JSON.stringify(h.local.values), /pair=|v1\./);
  assert.equal((await h.send('grant', { threadId: 'task-a' })).ok, true);
  const snapshot: any = await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' });
  assert.match(JSON.stringify(snapshot), /Fixture page/);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private|query/);
  const button = snapshot.nodes.find((node: Frame) => node.tag === 'button');
  await assert.rejects(h.broker.execute('task-b', 'turn-2', { method: 'click', ref: button.ref }), /not_authorized/);
  await h.broker.execute('task-a', 'turn-1', { method: 'click', ref: button.ref }); assert.equal(h.clicks(), 1);
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'click', ref: button.ref }), /operation_failed/);
  const fresh: any = await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' });
  await h.broker.execute('task-a', 'turn-1', { method: 'fill', ref: fresh.nodes.find((node: Frame) => node.tag === 'input').ref, text: 'test-query' });
  assert.equal((h.document.querySelector('#search') as HTMLInputElement).value, 'test-query');
  assert.ok(h.badges.every((badge) => badge.tabId === 1 && badge.text !== 'READ'));
  await h.send('revoke');
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }), /not_authorized/);
  assert.equal(h.session.values.binding, undefined);
});

test('built worker rejects website senders and revokes on document replacement/navigation/close', async (t) => {
  const h = await harness(t);
  for (const sender of [{ ...h.sender, tab: { id: 1 } }, { ...h.sender, url: 'https://example.com' }, { ...h.sender, id: 'other' }]) {
    assert.equal(h.receive({ type: 'grant', threadId: 'task-a' }, sender, () => assert.fail('untrusted sender')), false);
  }
  await h.send('connect', { url: h.pairUrl });
  for (const action of ['navigate', 'close', 'replace'] as const) {
    assert.equal((await h.send('grant', { threadId: 'task-a' })).ok, true);
    h[action]();
    await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }), /not_authorized|authorization_changed|operation_failed/);
  }
});

test('bad pairing exits pending state and can pair again; cancellation returns promptly', async (t) => {
  const h = await harness(t);
  const bad = h.pairUrl.slice(0, -1) + (h.pairUrl.endsWith('A') ? 'B' : 'A');
  assert.equal((await h.send('connect', { url: bad })).ok, false);
  assert.equal((await h.send('status')).result.connecting, false);
  assert.equal((await h.send('connect', { url: h.pairUrl })).ok, true);
  const pending = h.send('connect', { url: h.origin });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await h.send('cancel')).ok, true);
  await pending;
  assert.equal((await h.send('status')).result.connecting, false);
});

test('transport reconnect rotates the grant for the same Session and document, never replays a click', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl });
  await h.send('grant', { threadId: 'task-a' });
  const original = h.session.values.bindings[0].grantId;
  h.dropConnection();
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = await h.send('status');
    if (current.result.connected && !current.result.connecting && h.session.values.bindings[0]?.grantId !== original) break;
  }
  assert.notEqual(h.session.values.bindings[0].grantId, original);
  assert.equal(h.session.values.bindings[0].threadId, 'task-a');
  assert.equal(h.session.values.bindings[0].target.documentId, 'doc-a');
  assert.equal(h.clicks(), 0);
  assert.match(JSON.stringify(await h.broker.execute('task-a', 'turn-2', { method: 'snapshot' })), /Fixture page/);
  await h.send('revoke'); h.dropConnection();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(h.session.values.binding, undefined);
  assert.equal(h.broker.status('task-a').authorized, false);
});

test('one root adopts only AI-created same-origin child tabs, preserves them across reconnect and revokes the tree', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const snapshot: any = await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' });
  const ref = snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref;
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'open_link', ref }), /child_permission_required/);
  assert.equal(h.createdTabs(), 0);
  h.allowChildren();
  const fresh: any = await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' });
  const opened: any = await h.broker.execute('task-a', 'turn-1', { method: 'open_link', ref: fresh.nodes.find((node: Frame) => node.text === 'Open child').ref });
  assert.equal(h.createdTabs(), 1); assert.equal(opened.opened, true);
  assert.equal(h.broker.listPages('task-a', 'turn-1').total, 2);
  const manualId = h.manualTab();
  assert.equal(h.broker.listPages('task-a', 'turn-1').total, 2);
  assert.equal((await h.send('status')).result.currentManaged, false);
  assert.ok(!h.session.values.bindings.some((binding: Frame) => binding.target.tabId === manualId));
  assert.match(JSON.stringify(await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }, opened.pageId)), /Fixture page 2/);
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'click', ref: fresh.nodes.find((node: Frame) => node.tag === 'button').ref }, opened.pageId), /operation_failed/);
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }), /selection_required/);
  const originalIds = h.session.values.bindings.map((binding: Frame) => binding.grantId);
  h.dropConnection();
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = (await h.send('status')).result;
    if (status.connected && !status.connecting && h.session.values.bindings.every((binding: Frame) => !originalIds.includes(binding.grantId))) break;
  }
  assert.equal(h.session.values.bindings.length, 2);
  assert.equal(h.createdTabs(), 1, 'reconnect must not replay tab creation');
  const child = h.broker.listPages('task-a', 'turn-2').pages.find((page) => page.kind === 'ai-opened')!;
  const childSnapshot: any = await h.broker.execute('task-a', 'turn-2', { method: 'snapshot' }, child.pageId);
  await assert.rejects(h.broker.execute('task-a', 'turn-2', { method: 'open_link', ref: childSnapshot.nodes.find((node: Frame) => node.text === 'Cross origin').ref }, child.pageId), /child_origin_denied/);
  assert.equal(h.createdTabs(), 1);
  h.navigate();
  await assert.rejects(h.broker.execute('task-a', 'turn-2', { method: 'snapshot' }, child.pageId), /not_authorized|authorization_changed|operation_failed/);
  assert.equal(h.broker.listPages('task-a', 'turn-2').total, 0);
});

test('manual authorization replaces the one root; child navigation never revokes its root', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' }); h.allowChildren();
  const snapshot: any = await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' });
  // Ordinary AI clicks on target=_blank links use the same controlled creation path.
  const opened: any = await h.broker.execute('task-a', 'turn-1', { method: 'click', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref });
  h.navigate(2);
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }, opened.pageId), /not_authorized|authorization_changed|operation_failed/);
  assert.match(JSON.stringify(await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' })), /Fixture page 1/);
  h.manualTab(); await h.send('grant', { threadId: 'task-b' });
  assert.equal(h.broker.status('task-a').authorized, false);
  assert.equal(h.broker.listPages('task-b', 'turn-1').total, 1);
});
