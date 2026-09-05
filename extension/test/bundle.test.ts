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
  let duringSessionsList: (() => void | Promise<void>) | undefined;
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
        if (frame.action === 'connector.status') data = { capabilities: { browserControl: true, browserGrantReplacement: true } };
        else if (frame.action === 'sessions.list') { await duringSessionsList?.(); data = { sessions: [{ id: 'task-a', title: 'Fixture A' }, { id: 'task-b', title: 'Fixture B' }] }; }
        else if (frame.action === 'browser.bind') data = broker.bind(client, p.threadId, p.target, {
          replaceExisting: p.replaceExisting === true, recoverOnly: p.recoverOnly === true,
        });
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
  let activeTabPermission = true;
  let createdTabs = 0;
  let clicks = 0;
  let injections = 0;
  const injectedTabs: number[] = [];
  let nextRedirect: string | undefined;
  let onActionClicked!: (tab: Frame) => void;
  const openedPanels: Frame[] = [];
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
  let workerGeneration = 0;
  const badges: Frame[] = [];
  const chrome = {
    permissions: { contains: async () => sitePermission },
    storage: { local, session },
    sidePanel: { open: async (options: Frame) => { openedPanels.push(options); } },
    action: { onClicked: { addListener: (callback: typeof onActionClicked) => { onActionClicked = callback; } }, setBadgeText: async (value: Frame) => { badges.push(value); }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } } },
    tabs: { query: async () => [{ id: activeTab, windowId: 1, active: true, url: pages.get(activeTab)!.url }],
      create: async (options: Frame) => { const id = pages.size + 1; createdTabs++; assert.ok(pages.has(options.openerTabId)); pages.set(id, makePage(id, nextRedirect ?? options.url)); nextRedirect = undefined; if (options.active) activeTab = id; return { id }; },
      update: async (id: number, options: Frame) => { assert.ok(pages.has(id)); if (options.active) activeTab = id; return { id }; },
      get: async (id: number) => ({ id, windowId: 1, active: id === activeTab, url: pages.get(id)!.url, status: 'complete' }),
      onUpdated: { addListener: (listener: typeof onUpdated) => { onUpdated = listener; } }, onRemoved: { addListener: (listener: typeof onRemoved) => { onRemoved = listener; } } },
    scripting: { executeScript: async (options: Frame) => {
      if (!activeTabPermission && !sitePermission) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
      assert.equal(options.world, 'ISOLATED');
      const fixture = pages.get(options.target.tabId)!;
      assert.ok(fixture, 'only known fixture tabs may be injected');
      const { pageContext, documentId } = fixture;
      if (options.target.documentIds && options.target.documentIds[0] !== documentId) throw new Error('document_replaced');
      injections++;
      injectedTabs.push(options.target.tabId);
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
  const workerSource = await readFile('extension/dist/background.js', 'utf8');
  const startWorker = () => {
    const generation = ++workerGeneration;
    const context = createContext({ chrome, URL, crypto, TextEncoder, TextDecoder, WebSocket: BrowserSocket, AbortController,
    setTimeout: (callback: () => void, delay: number) => setTimeout(() => { if (generation === workerGeneration) callback(); }, delay),
    clearTimeout, setInterval: (callback: () => void, delay: number) => { const timer = setInterval(callback, delay); intervals.add(timer); return timer; },
    clearInterval: (timer: ReturnType<typeof setInterval>) => { clearInterval(timer); intervals.delete(timer); },
  });
    runInContext(workerSource, context, { timeout: 1000 });
  };
  startWorker();
  const sender = { id: extensionId, url: popup };
  const send = (type: string, payload: Frame = {}, from = sender) => new Promise<Frame>((resolve, reject) => {
    if (!onMessage({ type, ...payload }, from, resolve)) reject(new Error('popup_rejected'));
  });
  t.after(async () => {
    await send('disconnect');
    for (const timer of intervals) clearInterval(timer);
    for (const connection of sockets) connection.terminate();
    broker.clear(); channels.clear(); socket.terminate(); await relay.close();
  });
  const pairing = relay.deviceRegistry.createBrowserPairing();
  return { broker, send, sender, receive: (...args: Parameters<typeof onMessage>) => onMessage(...args),
    sendPanel: (type: string, payload: Frame = {}) => send(type, payload, { id: extensionId, url: `chrome-extension://${extensionId}/sidepanel.html` }),
    onSessionList: (callback: () => void | Promise<void>) => { duringSessionsList = callback; },
    openPanel: (windowId: number) => onActionClicked({ id: activeTab, windowId }), openedPanels,
    pairUrl: `${origin}/#pair=${encodeBrowserPairingCredential(pairing.credential)}`, origin,
    local, session, badges, document, clicks: () => clicks, injections: () => injections,
    dropConnection: () => { for (const client of relay.clients.values()) client.close(1001, 'test disconnect'); },
    allowChildren: () => { sitePermission = true; }, createdTabs: () => createdTabs,
    injectedTabs, redirectNext: (url: string) => { nextRedirect = url; }, activeTab: () => activeTab,
    loseActiveTab: () => { activeTabPermission = false; },
    reloadWithoutOldTab: async () => {
      // Reload clears session storage but preserves the extension's paired key.
      // The old tab closes while no worker is present to deliver browser.revoke.
      for (const timer of intervals) clearInterval(timer);
      intervals.clear();
      for (const connection of sockets) { connection.onmessage = null; connection.onclose = null; connection.terminate(); }
      for (const key of Object.keys(session.values)) delete session.values[key];
      pages.delete(1); activeTab = 10;
      pages.set(10, makePage(10, 'https://example.com/reopened'));
      startWorker();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await send('status')).result.connected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('reloaded_worker_did_not_reconnect');
    },
    manualTab: () => { const id = pages.size + 1; pages.set(id, makePage(id, 'https://example.com/manual')); activeTab = id; return id; },
    navigate: (id = 1) => onUpdated(id, { status: 'loading' }), close: (id = 1) => onRemoved(id), replace: () => { pages.get(1)!.documentId = 'doc-b'; } };
}

test('connection status stays pending until environment initialization finishes', async (t) => {
  const h = await harness(t);
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.onSessionList(() => { started(); return gate; });
  const connecting = h.send('connect', { url: h.pairUrl });
  await entered;
  try {
    const state = (await h.send('status')).result;
    assert.equal(state.relayOnline, true);
    assert.equal(state.connecting, true);
    assert.equal(state.connected, false);
  } finally { release(); }
  const result = await connecting;
  assert.equal(result.ok, true);
  assert.equal(result.result.connecting, false);
  assert.equal(result.result.connected, true);
});

test('side panel grants only the explicitly selected original Session and keeps it when the panel reopens', async (t) => {
  const h = await harness(t);
  assert.equal((await h.send('connect', { url: h.pairUrl })).ok, true);
  const payload = { relayOrigin: h.origin, environmentId: 'pc', threadId: 'task-b',
    tabId: 1, windowId: 1, url: 'https://example.com/private?secret=query' };
  assert.equal(h.receive({ type: 'panel.grant', ...payload }, h.sender, () => {}), false);
  assert.equal((await h.sendPanel('panel.grant', { ...payload, relayOrigin: 'https://wrong.example' })).ok, false);
  assert.equal((await h.sendPanel('panel.grant', { ...payload, windowId: 9 })).ok, false);
  assert.equal((await h.sendPanel('panel.grant', payload)).ok, true);
  assert.equal(h.broker.status('task-b').authorized, true);
  assert.equal(h.broker.status('task-a').authorized, false);
  const before = (await h.sendPanel('status', { windowId: 1 })).result.binding.grantId;
  const after = (await h.sendPanel('status', { windowId: 1 })).result.binding.grantId;
  assert.equal(before, after);
  const snapshot: any = await h.broker.execute('task-b', 'turn-panel', { method: 'snapshot' });
  assert.ok(snapshot.nodes.length > 0);
  await h.sendPanel('revoke');
  assert.equal(h.broker.status('task-b').authorized, false);
});

test('side panel refuses a replacement document even at the same URL after a network wait', async (t) => {
  const h = await harness(t);
  assert.equal((await h.send('connect', { url: h.pairUrl })).ok, true);
  h.onSessionList(h.replace);
  const result = await h.sendPanel('panel.grant', { relayOrigin: h.origin, environmentId: 'pc', threadId: 'task-a',
    tabId: 1, windowId: 1, url: 'https://example.com/private?secret=query' });
  assert.equal(result.ok, false);
  assert.equal(h.broker.status('task-a').authorized, false);
  assert.equal(h.clicks(), 0);
});

test('a reloaded extension with a closed old tab can authorize the current page without its lost grant record', async (t) => {
  const h = await harness(t);
  assert.equal((await h.sendPanel('connect', { url: h.pairUrl })).ok, true);
  assert.equal((await h.sendPanel('panel.grant', { relayOrigin: h.origin, environmentId: 'pc', threadId: 'task-b',
    tabId: 1, windowId: 1, url: 'https://example.com/private?secret=query' })).ok, true);
  const oldGrant = h.broker.listPages('task-b', 'turn-reload').pages[0].pageId;
  const deviceKey = h.local.values.privateKey;
  await h.reloadWithoutOldTab();
  assert.equal(h.local.values.privateKey, deviceKey, 'pairing must survive reload');
  assert.equal((await h.sendPanel('status', { windowId: 1 })).result.binding, null);
  assert.equal(h.broker.status('task-b').authorized, true, 'the missed close event leaves a Connector-side grant');
  const result = await h.sendPanel('panel.grant', { relayOrigin: h.origin, environmentId: 'pc', threadId: 'task-b',
    tabId: 10, windowId: 1, url: 'https://example.com/reopened' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const pages = h.broker.listPages('task-b', 'turn-reload').pages;
  assert.equal(pages.length, 1); assert.notEqual(pages[0].pageId, oldGrant);
  const snapshot = await h.broker.execute('task-b', 'turn-reload', { method: 'snapshot' });
  assert.match(JSON.stringify(snapshot), /Fixture page 10/);
  assert.equal(h.broker.status('task-a').authorized, false);
});

test('side panel controls a normal site after explicit host access even without a toolbar activeTab grant', async (t) => {
  const h = await harness(t);
  assert.equal((await h.sendPanel('connect', { url: h.pairUrl })).ok, true);
  h.loseActiveTab();
  const payload = { relayOrigin: h.origin, environmentId: 'pc', threadId: 'task-b',
    tabId: 1, windowId: 1, url: 'https://example.com/private?secret=query' };
  assert.equal((await h.sendPanel('panel.grant', payload)).ok, false);
  assert.equal(h.broker.status('task-b').authorized, false);
  h.allowChildren(); // Chrome's explicit current-site permission now permits injection.
  assert.equal((await h.sendPanel('panel.grant', payload)).ok, true);
  assert.equal(h.broker.status('task-a').authorized, false);
  const snapshot: any = await h.broker.execute('task-b', 'turn-host-permission', { method: 'snapshot' });
  assert.match(JSON.stringify(snapshot), /Fixture page/);
});

test('built extension pairs over real WS/E2E, selects original Session, reads/clicks/fills, and revokes', async (t) => {
  const h = await harness(t);
  const connected = await h.send('connect', { url: h.pairUrl });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  h.openPanel(7);
  assert.deepEqual(JSON.parse(JSON.stringify(h.openedPanels)), [{ windowId: 7 }]);
  assert.equal(h.injections(), 0, 'opening the side panel must not inject into or authorize a page');
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
  const handoff: any = await h.broker.execute('task-a', 'turn-2', { method: 'open_link', ref: childSnapshot.nodes.find((node: Frame) => node.text === 'Cross origin').ref }, child.pageId);
  assert.equal(handoff.authorizationRequired, true);
  assert.equal(handoff.pageId, undefined);
  assert.equal(h.createdTabs(), 2);
  assert.equal(h.broker.listPages('task-a', 'turn-2').total, 2);
  assert.ok(!h.injectedTabs.includes(h.activeTab()), 'a foreign destination must not be injected');
  h.navigate();
  await assert.rejects(h.broker.execute('task-a', 'turn-2', { method: 'snapshot' }, child.pageId), /not_authorized|authorization_changed|operation_failed/);
  assert.equal(h.broker.listPages('task-a', 'turn-2').total, 0);
});

test('missing site permission and cross-origin redirects open a visible handoff without adopting or reading it', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  for (const redirect of [false, true]) {
    if (redirect) { h.allowChildren(); h.redirectNext('https://login.example/auth'); }
    const snapshot: any = await h.broker.execute('task-a', 'turn-handoff', { method: 'snapshot' });
    const result: any = await h.broker.execute('task-a', 'turn-handoff', { method: 'click', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref });
    assert.equal(result.opened, true); assert.equal(result.authorizationRequired, true);
    assert.equal(result.origin, redirect ? 'https://login.example' : 'https://example.com');
    assert.equal(result.pageId, undefined);
    assert.ok(!h.injectedTabs.includes(h.activeTab()));
    assert.equal(h.broker.listPages('task-a', 'turn-handoff').total, 1);
    assert.equal(h.session.values.bindings.length, 1);
  }
});

test('manual authorization replaces the one root; child navigation never revokes its root', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' }); h.allowChildren();
  h.document.querySelector('a[target="_blank"]')!.removeAttribute('target');
  const snapshot: any = await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' });
  // Same-tab links also keep their parent authorized by using controlled creation.
  const opened: any = await h.broker.execute('task-a', 'turn-1', { method: 'click', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref });
  h.navigate(2);
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }, opened.pageId), /not_authorized|authorization_changed|operation_failed/);
  assert.match(JSON.stringify(await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' })), /Fixture page 1/);
  h.manualTab(); await h.send('grant', { threadId: 'task-b' });
  assert.equal(h.broker.status('task-a').authorized, false);
  assert.equal(h.broker.listPages('task-b', 'turn-1').total, 1);
});

test('link handoff rejects scripts, embedded credentials and downloads before creating a tab', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const link = h.document.querySelector('a[target="_blank"]')!;
  for (const href of ['javascript:alert(1)', 'file:///private', 'https://user:secret@foreign.example/path', 'https://example.com/download']) {
    link.setAttribute('href', href);
    if (href.endsWith('/download')) link.setAttribute('download', 'file');
    const snapshot: any = await h.broker.execute('task-a', 'turn-link', { method: 'snapshot' });
    await assert.rejects(h.broker.execute('task-a', 'turn-link', { method: 'open_link', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref }), /operation_failed/);
    assert.equal(h.createdTabs(), 0);
    assert.equal(h.broker.listPages('task-a', 'turn-link').total, 1);
  }
});
