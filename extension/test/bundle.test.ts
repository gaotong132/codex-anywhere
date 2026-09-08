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
import { browserLinkContext } from '../../src/shared/browser-link.js';

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
  let nextTabId = 2;
  const removedTabs: number[] = [];
  const tabFlags = new Map<number, Frame>();
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
  // LinkeDOM omits browser default-value properties used by the edit guard.
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'defaultValue', { value: input.getAttribute('value') || '' });
    Object.defineProperty(input, 'defaultChecked', { value: input.hasAttribute('checked') });
    if (input.checked === undefined) input.checked = input.hasAttribute('checked');
  }
  for (const textarea of document.querySelectorAll('textarea')) Object.defineProperty(textarea, 'defaultValue', { value: textarea.textContent });
  for (const select of document.querySelectorAll('select')) {
    for (const [index, option] of Array.from(select.options).entries()) {
      Object.defineProperty(option, 'defaultSelected', { value: option.hasAttribute('selected') });
      option.selected = index === 0;
    }
  }
  for (const node of document.querySelectorAll('*')) Object.defineProperty(node, 'getBoundingClientRect', { value: () => ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, bottom: 30, right: 110 }) });
  document.querySelector('#safe')!.addEventListener('click', () => { clicks++; });
  Object.defineProperty(document, 'elementFromPoint', { value: () => document.querySelector('#safe') });
  const pageContext = createContext({ document, location: new URL(url), crypto, URL,
    Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_ELEMENT: 1 }, innerHeight: 800, innerWidth: 1200,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement,
    HTMLAnchorElement: window.HTMLAnchorElement, Event: window.Event,
    getComputedStyle: (element: HTMLElement) => ({ display: element.style.display || 'block', visibility: element.style.visibility || 'visible', opacity: element.style.opacity || '1', cursor: element.style.cursor || element.parentElement?.style.cursor || 'auto' }), window: { scrollBy: () => {} },
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
      create: async (options: Frame) => { const id = nextTabId++; createdTabs++; assert.ok(pages.has(options.openerTabId)); pages.set(id, makePage(id, nextRedirect ?? options.url)); nextRedirect = undefined; if (options.active) activeTab = id; return { id }; },
      remove: async (id: number) => { assert.notEqual(id, activeTab, 'cleanup never closes the active tab'); removedTabs.push(id); pages.delete(id); onRemoved(id); },
      update: async (id: number, options: Frame) => { assert.ok(pages.has(id)); if (options.active) activeTab = id; return { id }; },
      get: async (id: number) => ({ id, windowId: 1, active: id === activeTab, url: pages.get(id)!.url, status: 'complete', ...tabFlags.get(id) }),
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
  return { relay, broker, send, sender, receive: (...args: Parameters<typeof onMessage>) => onMessage(...args),
    sendPanel: (type: string, payload: Frame = {}) => send(type, payload, { id: extensionId, url: `chrome-extension://${extensionId}/sidepanel.html` }),
    onSessionList: (callback: () => void | Promise<void>) => { duringSessionsList = callback; },
    openPanel: (windowId: number) => onActionClicked({ id: activeTab, windowId }), openedPanels,
    pairUrl: `${origin}/#pair=${encodeBrowserPairingCredential(pairing.credential)}`, origin,
    local, session, badges, document, clicks: () => clicks, injections: () => injections,
    dropConnection: () => { for (const client of relay.clients.values()) client.close(1001, 'test disconnect'); },
    allowChildren: () => { sitePermission = true; }, createdTabs: () => createdTabs,
    removedTabs, pages, setTabFlags: (id: number, flags: Frame) => tabFlags.set(id, flags),
    injectedTabs, redirectNext: (url: string) => { nextRedirect = url; }, activeTab: () => activeTab,
    loseActiveTab: () => { activeTabPermission = false; },
    reloadWithoutOldTab: async () => {
      // Reload clears session storage but preserves the extension's paired key.
      // The old tab closes while no worker is present to deliver browser.revoke.
      for (const timer of intervals) clearInterval(timer);
      intervals.clear();
      for (const connection of sockets) { connection.onmessage = null; connection.onclose = null; connection.terminate(); }
      for (const key of Object.keys(session.values)) delete session.values[key];
      pages.delete(1); activeTab = 10; nextTabId = 11;
      pages.set(10, makePage(10, 'https://example.com/reopened'));
      startWorker();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await send('status')).result.connected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('reloaded_worker_did_not_reconnect');
    },
    manualTab: () => { const id = nextTabId++; pages.set(id, makePage(id, 'https://example.com/manual')); activeTab = id; return id; },
    urlChanged: (url: string, id = 1) => { pages.get(id)!.url = url; onUpdated(id, { url }); },
    navigate: (id = 1) => { pages.get(id)!.documentId += '-navigated'; onUpdated(id, { status: 'loading' }); },
    close: (id = 1) => onRemoved(id), replace: () => { pages.get(1)!.documentId = 'doc-b'; } };
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

test('one Web pairing links the built worker; reconnection keeps identity and never grants a page', async (t) => {
  const h = await harness(t);
  const webIdentity = createDeviceIdentity();
  const pending = h.relay.deviceRegistry.requestPairing({ role: 'client', address: 'fixture',
    device: { id: webIdentity.id, publicKey: webIdentity.publicKey, signature: '0'.repeat(128) } });
  h.relay.deviceRegistry.approve(pending.requestId);
  const channel = 'd'.repeat(32);
  await h.sendPanel('panel.connect', { origin: h.origin, windowId: 1, channel });
  let request: Frame | undefined;
  for (let i = 0; i < 100; i++) {
    request = (await h.sendPanel('status', { windowId: 1 })).result.linkRequest;
    if (request) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(request);
  assert.equal((await h.sendPanel('status', { windowId: 2 })).result.linkRequest, null);
  const sponsor = createDeviceAuthProof(webIdentity, { challenge: request.challenge, role: 'client',
    authProof: browserLinkContext(request.extensionOrigin, request.device) });
  assert.equal((await h.sendPanel('panel.link.complete', { windowId: 2, channel, requestId: request.requestId, sponsor })).ok, false);
  assert.equal((await h.sendPanel('panel.link.complete', { windowId: 1, channel, requestId: request.requestId, sponsor })).ok, true);
  for (let i = 0; i < 100 && !(await h.send('status')).result.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await h.send('status')).result.connected, true);
  assert.equal(h.injections(), 0);
  assert.equal(h.broker.status('task-a').authorized, false);
  const key = h.local.values.privateKey;
  assert.notEqual(key, webIdentity.privateKey);
  assert.equal(JSON.stringify(h.local.values).includes(webIdentity.privateKey), false);
  const registered = h.relay.deviceRegistry.listApproved().find((entry) => entry.id === request!.device.id);
  assert.equal(registered?.linkedFrom?.id, webIdentity.id);
  await h.reloadWithoutOldTab();
  assert.equal(h.local.values.privateKey, key);
  assert.equal((await h.send('status')).result.connected, true);
  assert.equal(h.relay.deviceRegistry.listApproved().length, 3);
  await h.send('disconnect');
  const paused = await h.sendPanel('panel.connect', { origin: h.origin, windowId: 1, channel });
  assert.equal(paused.result.autoConnectPaused, true);
  assert.equal(paused.result.linkRequest, null);
  assert.equal(paused.result.relayOnline, false);
  assert.equal(h.local.values.controlPaused, true);
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
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'click', ref: button.ref }), /browser_stale_element_read_again/);
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

test('SPA URL changes retain the exact document grant but replacement and cross-origin changes revoke it', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const original = (await h.send('status')).result.binding.grantId;
  for (const url of ['https://example.com/#details', 'https://example.com/items/1?view=details']) {
    h.urlChanged(url);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await h.send('status')).result.binding.grantId, original);
    const snapshot: any = await h.broker.execute('task-a', 'turn-spa', { method: 'snapshot' });
    assert.ok(snapshot.nodes.some((node: Frame) => node.text === 'Increment'));
  }
  h.replace(); h.urlChanged('https://example.com/replaced');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await h.send('status')).result.binding, null);
  await h.send('grant', { threadId: 'task-a' });
  h.urlChanged('https://foreign.example/replaced');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await h.send('status')).result.binding, null);
});

test('console controls expose nested labels and exact recoverable failures without losing page consent', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const button = h.document.querySelector('#safe')!;
  button.innerHTML = '<span>Save configuration</span><span hidden>private-button-marker</span>';
  for (const child of button.children) Object.defineProperty(child, 'getBoundingClientRect', { value: () => button.getBoundingClientRect() });
  let snapshot: any = await h.broker.execute('task-a', 'turn-controls', { method: 'snapshot' });
  assert.ok(snapshot.nodes.find((node: Frame) => node.tag === 'button' && node.text === 'Save configuration' && node.ref));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-button-marker|secret-password|secret-draft|secret-option/);
  const obscured = snapshot.nodes.find((node: Frame) => node.tag === 'input');
  await assert.rejects(h.broker.execute('task-a', 'turn-controls', { method: 'click', ref: obscured.ref }), { message: 'browser_element_obscured' });
  assert.equal(h.broker.status('task-a').authorized, true);
  button.setAttribute('disabled', '');
  snapshot = await h.broker.execute('task-a', 'turn-controls', { method: 'snapshot' });
  const disabled = snapshot.nodes.find((node: Frame) => node.tag === 'button');
  assert.equal(disabled.disabled, true);
  await assert.rejects(h.broker.execute('task-a', 'turn-controls', { method: 'click', ref: disabled.ref }), { message: 'browser_element_not_allowed' });
  assert.equal(h.clicks(), 0); assert.equal(h.broker.status('task-a').online, true);
  await assert.rejects(h.broker.execute('task-a', 'turn-controls', { method: 'scroll', ref: obscured.ref, deltaY: 100 }), { message: 'browser_stale_element_read_again' });
});

test('hidden console menus do not exhaust snapshots before visible controls', async (t) => {
  const h = await harness(t);
  for (const attributes of ['hidden', 'style="display:none"', 'style="opacity:0"', 'data-anywhere-private']) {
    const menu = h.document.createElement('div');
    menu.innerHTML = `<div ${attributes}>${'<span>private-menu-item</span>'.repeat(6000)}</div>`;
    h.document.body.prepend(menu);
  }
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const snapshot: any = await h.broker.execute('task-a', 'turn-menu', { method: 'snapshot' });
  assert.equal(snapshot.truncated, false);
  assert.ok(snapshot.scannedElements < 100, 'hidden descendants must not consume the scan budget');
  assert.doesNotMatch(JSON.stringify(snapshot), /private-menu-item|secret-option|secret-draft/);
  const button = snapshot.nodes.find((node: Frame) => node.tag === 'button' && node.text === 'Increment');
  assert.ok(button?.ref, 'a visible control after collapsed menus must remain actionable');
  await h.broker.execute('task-a', 'turn-menu', { method: 'click', ref: button.ref });
  assert.equal(h.clicks(), 1);
});

test('snapshot still bounds a large visible tree and explains truncation', async (t) => {
  const h = await harness(t);
  const wrapper = h.document.createElement('div');
  wrapper.innerHTML = '<div></div>'.repeat(6000);
  h.document.body.prepend(wrapper);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const snapshot: any = await h.broker.execute('task-a', 'turn-limit', { method: 'snapshot' });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.truncationReason, 'scan_limit');
  assert.equal(snapshot.scannedElements, 5000);
});

test('dense snapshots retain later rows and stay within both node and transport limits', async (t) => {
  const h = await harness(t);
  const list = h.document.createElement('div');
  h.document.body.prepend(list);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  for (const decorated of [false, true]) {
    list.innerHTML = Array.from({ length: 230 }, (_, i) => `<button${decorated ? ` role="${'r'.repeat(40)}" aria-checked="mixed" aria-expanded="true"` : ''}>Row ${i}</button>`).join('');
    for (const element of list.children) Object.defineProperty(element, 'getBoundingClientRect', { value: () => h.document.querySelector('#safe')!.getBoundingClientRect() });
    const snapshot: any = await h.broker.execute('task-a', 'turn-dense', { method: 'snapshot' });
    assert.equal(snapshot.truncated, true);
    assert.ok(JSON.stringify(snapshot).length < 24_000);
    assert.ok(snapshot.nodes.length <= 200);
    if (decorated) assert.equal(snapshot.truncationReason, 'result_limit');
    else { assert.equal(snapshot.nodes.length, 200); assert.ok(snapshot.nodes.some((node: Frame) => node.text === 'Row 150')); }
  }
});

test('nested navigation labels leave room for content and custom pointer tabs remain clickable', async (t) => {
  const h = await harness(t);
  const nav = h.document.createElement('nav');
  nav.innerHTML = Array.from({ length: 60 }, (_, i) => `<a href="https://example.com/item-${i}"><span>Navigation ${i}</span></a>`).join('');
  h.document.body.prepend(nav);
  const old = h.document.querySelector('#safe')!;
  const bounds = old.getBoundingClientRect();
  const tab = h.document.createElement('div'); tab.id = 'safe'; tab.style.cursor = 'pointer';
  tab.innerHTML = '<span>Basic information</span>';
  let clicked = 0; tab.addEventListener('click', () => { clicked++; }); old.replaceWith(tab);
  for (const element of [...nav.querySelectorAll('*'), tab, ...tab.children]) {
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => bounds });
  }
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const snapshot: any = await h.broker.execute('task-a', 'turn-tab', { method: 'snapshot' });
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.nodes.filter((node: Frame) => node.text === 'Navigation 0').length, 1);
  assert.equal(snapshot.nodes.find((node: Frame) => node.text === 'Navigation 0').tag, 'a');
  const tabs = snapshot.nodes.filter((node: Frame) => node.text === 'Basic information');
  assert.equal(tabs.length, 1); assert.ok(tabs[0].ref);
  assert.equal(snapshot.nodes.find((node: Frame) => node.tag === 'h1').ref, undefined);
  await h.broker.execute('task-a', 'turn-tab', { method: 'click', ref: tabs[0].ref });
  assert.equal(clicked, 1);
  const fresh: any = await h.broker.execute('task-a', 'turn-tab', { method: 'snapshot' });
  const wrapper = h.document.createElement('a'); wrapper.href = 'https://example.com/changed';
  tab.replaceWith(wrapper); wrapper.append(tab);
  await assert.rejects(h.broker.execute('task-a', 'turn-tab', { method: 'click', ref: fresh.nodes.find((node: Frame) => node.text === 'Basic information').ref }), /browser_stale_element_read_again/);
  assert.equal(clicked, 1);
});

test('deduplication preserves independently focusable children even when their label repeats', async (t) => {
  const h = await harness(t);
  const card = h.document.createElement('div'); card.style.cursor = 'pointer';
  card.innerHTML = '<div tabindex="0">Edit item</div><button>Edit item</button>';
  // LinkeDOM reports -1 for tabindex="0"; mirror the browser property in this fixture.
  Object.defineProperty(card.firstElementChild!, 'tabIndex', { value: 0 });
  h.document.body.prepend(card);
  for (const element of [card, ...card.children]) {
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => h.document.querySelector('#safe')!.getBoundingClientRect() });
  }
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const snapshot: any = await h.broker.execute('task-a', 'turn-nested', { method: 'snapshot' });
  const children = snapshot.nodes.filter((node: Frame) => node.text === 'Edit item' && node.ref);
  assert.equal(children.length, 2, 'both focusable div and native button retain independent refs');
  assert.ok(children.some((node: Frame) => node.tag === 'div'));
  assert.ok(children.some((node: Frame) => node.tag === 'button'));
});

test('anchors without href act as controls and cannot be opened as links', async (t) => {
  const h = await harness(t);
  const old = h.document.querySelector('#safe')!;
  const button = h.document.createElement('a'); button.id = 'safe'; button.setAttribute('role', 'button'); button.textContent = 'Show details';
  const bounds = old.getBoundingClientRect(); Object.defineProperty(button, 'getBoundingClientRect', { value: () => bounds });
  let clicks = 0; button.addEventListener('click', () => { clicks++; }); old.replaceWith(button);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  let snapshot: any = await h.broker.execute('task-a', 'turn-anchor', { method: 'snapshot' });
  await assert.rejects(h.broker.execute('task-a', 'turn-anchor', { method: 'open_link', ref: snapshot.nodes.find((node: Frame) => node.text === 'Show details').ref }), /browser_link_required/);
  snapshot = await h.broker.execute('task-a', 'turn-anchor', { method: 'snapshot' });
  await h.broker.execute('task-a', 'turn-anchor', { method: 'click', ref: snapshot.nodes.find((node: Frame) => node.text === 'Show details').ref });
  assert.equal(clicks, 1); assert.equal(h.createdTabs(), 0);
});

test('pointer cursor inheritance does not turn decorative icon descendants into controls', async (t) => {
  const h = await harness(t);
  const navigation = h.document.createElement('nav');
  navigation.innerHTML = Array.from({ length: 40 }, (_, i) => `<div style="cursor:pointer" aria-label="Icon action ${i}"><span><svg><g><path></path><path></path></g></svg></span></div>`).join('');
  h.document.body.prepend(navigation);
  for (const element of navigation.querySelectorAll('*')) {
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => h.document.querySelector('#safe')!.getBoundingClientRect() });
    (element as HTMLElement).style.cursor = 'pointer';
  }
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' });
  const snapshot: any = await h.broker.execute('task-a', 'turn-icons', { method: 'snapshot' });
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.nodes.filter((node: Frame) => node.ref && /^Icon action /.test(node.text)).length, 40);
  assert.equal(snapshot.nodes.filter((node: Frame) => ['svg', 'g', 'path'].includes(node.tag)).length, 0);
  assert.ok(snapshot.nodes.some((node: Frame) => node.text === 'Increment' && node.ref));
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
  const activeChild = h.session.values.bindings.find((binding: Frame) => binding.grantId === opened.pageId);
  assert.equal(h.activeTab(), activeChild.target.tabId, 'Chrome follows the newly opened managed page');
  assert.equal((await h.send('status')).result.currentManaged, true);
  const manualId = h.manualTab();
  assert.equal(h.broker.listPages('task-a', 'turn-1').total, 2);
  assert.equal((await h.send('status')).result.currentManaged, false);
  assert.ok(!h.session.values.bindings.some((binding: Frame) => binding.target.tabId === manualId));
  assert.match(JSON.stringify(await h.broker.execute('task-a', 'turn-1', { method: 'snapshot' }, opened.pageId)), /Fixture page 2/);
  await assert.rejects(h.broker.execute('task-a', 'turn-1', { method: 'click', ref: fresh.nodes.find((node: Frame) => node.tag === 'button').ref }, opened.pageId), /browser_stale_element_read_again/);
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
  assert.notEqual(h.activeTab(), activeChild.target.tabId, 'Chrome also follows destinations awaiting site consent');
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
    await assert.rejects(h.broker.execute('task-a', 'turn-link', { method: 'open_link', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref }), /browser_link_required|browser_navigation_not_allowed/);
    assert.equal(h.createdTabs(), 0);
    assert.equal(h.broker.listPages('task-a', 'turn-link').total, 1);
  }
});

test('repeated links reuse the same managed child without adopting a manual tab', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' }); h.allowChildren();
  const rootId = h.session.values.bindings[0].grantId;
  const open = async () => {
    const snapshot: any = await h.broker.execute('task-a', 'turn-reuse', { method: 'snapshot' }, rootId);
    return h.broker.execute('task-a', 'turn-reuse', { method: 'open_link', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref }, rootId) as Promise<any>;
  };
  const first = await open();
  h.manualTab();
  const reused = await open();
  assert.equal(reused.reused, true);
  assert.equal(reused.pageId, first.pageId);
  assert.equal(h.createdTabs(), 1);
  assert.equal(h.broker.listPages('task-a', 'turn-reuse').total, 2);
  assert.equal((await h.send('status')).result.currentManaged, true);
});

test('old ordinary children are closed and revoked while root, manual, pinned and edited pages survive', async (t) => {
  const h = await harness(t);
  await h.send('connect', { url: h.pairUrl }); await h.send('grant', { threadId: 'task-a' }); h.allowChildren();
  const rootId = h.session.values.bindings[0].grantId;
  const open = async (suffix: string) => {
    h.document.querySelector('a[target="_blank"]')!.setAttribute('href', `https://example.com/${suffix}`);
    const snapshot: any = await h.broker.execute('task-a', 'turn-cleanup', { method: 'snapshot' }, rootId);
    const result: any = await h.broker.execute('task-a', 'turn-cleanup', { method: 'open_link', ref: snapshot.nodes.find((node: Frame) => node.text === 'Open child').ref }, rootId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return h.session.values.bindings.find((binding: Frame) => binding.grantId === result.pageId);
  };
  const pinned = await open('pinned'); h.setTabFlags(pinned.target.tabId, { pinned: true });
  const edited = await open('edited');
  const doc = h.pages.get(edited.target.tabId)!.document;
  doc.querySelector('input')!.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
  const manual = h.manualTab();
  const ordinary: Frame[] = [];
  for (let i = 0; i < 7; i++) ordinary.push(await open(`ordinary-${i}`));
  for (let i = 0; i < 100 && h.removedTabs.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.removedTabs.length, 4);
  for (const binding of ordinary.slice(0, 4)) {
    assert.ok(!h.pages.has(binding.target.tabId));
    await assert.rejects(h.broker.execute('task-a', 'turn-cleanup', { method: 'snapshot' }, binding.grantId), /page_not_authorized/);
  }
  for (const id of [1, manual, pinned.target.tabId, edited.target.tabId, ...ordinary.slice(-3).map(b => b.target.tabId)]) assert.ok(h.pages.has(id));
  assert.equal(h.broker.listPages('task-a', 'turn-cleanup').total, 6);
  assert.equal(h.activeTab(), ordinary.at(-1)!.target.tabId);
});
