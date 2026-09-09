import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { browserContext } from '../src/shared/browser-context.js';

const client = { clientId: 'extension', clientDeviceId: 'browser' };
const target = { browserDeviceId: 'browser', tabId: 1, documentId: 'document', origin: 'https://example.com' };
const echo = async (text: unknown) => text;
const expected = (pages: number, online: number) => `Read\n\n${browserContext(pages, online)}`;
function setup() {
  let now = 1000;
  const events: any[] = [];
  const broker = new BrowserSessionBroker('pc', (event) => { events.push(event); return true; }, () => now);
  const grant = broker.bind(client, 'task', target);
  broker.heartbeat(client, grant.grantId);
  const read = () => broker.withContext('task', 'Read', echo);
  return { broker, grant, read, events, advance: (ms: number) => { now += ms; } };
}

test('stable browser state is delivered once, including one final zero-page notice', async () => {
  const { broker, grant, read, advance } = setup();
  assert.equal(await broker.withContext('unrelated', undefined, echo), undefined);
  assert.equal(await read(), expected(1, 1));
  for (let i = 0; i < 10; i++) {
    advance(10_000); broker.heartbeat(client, grant.grantId);
    assert.equal(await read(), 'Read');
  }
  broker.revoke(client, grant.grantId);
  assert.equal(await read(), expected(0, 0));
  assert.equal(await read(), 'Read');
});

test('heartbeat expiry and recovery refresh liveness without expiring consent', async () => {
  const { broker, grant, read, advance } = setup();
  await read(); advance(45_000);
  assert.equal(await read(), expected(1, 0));
  assert.equal(await read(), 'Read');
  broker.heartbeat(client, grant.grantId);
  assert.equal(await read(), expected(1, 1));
  assert.equal(await read(), 'Read');
});

test('navigation, replacement and reconnect refresh changed page IDs even with unchanged counts', async () => {
  const { broker, grant, read } = setup();
  await read();
  const navigated = broker.navigate(client, grant.grantId, { ...target, documentId: 'next' });
  broker.heartbeat(client, navigated.grantId);
  assert.equal(await read(), expected(1, 1));
  const restored = broker.restore(client, navigated.grantId, navigated.target);
  broker.heartbeat(client, restored.grantId);
  assert.equal(await read(), expected(1, 1));
  const replaced = broker.bind(client, 'task', { ...target, tabId: 2 }, { replaceExisting: true });
  broker.heartbeat(client, replaced.grantId);
  assert.equal(await read(), expected(1, 1));
  broker.clear();
  assert.equal(await read(), expected(0, 0));
  assert.equal(await read(), 'Read');
  const reconnected = broker.bind(client, 'task', target);
  broker.heartbeat(client, reconnected.grantId);
  assert.equal(await read(), expected(1, 1));
  assert.equal(await read(), 'Read');
});

test('a different online page refreshes the inventory even when both counts stay the same', async () => {
  const { broker, grant, events, read, advance } = setup();
  const opening = broker.execute('task', 'turn', { method: 'open_link', ref: 'link' });
  const child = broker.adopt(client, events[0].payload.requestId, grant.grantId, { ...target, tabId: 2, documentId: 'child' });
  broker.result(client, { ...events[0].payload, ok: true }); await opening;
  assert.equal(await read(), expected(2, 1));
  advance(45_000); broker.heartbeat(client, child.grantId);
  assert.equal(await read(), expected(2, 1));
  assert.equal(await read(), 'Read');
});

test('failed sends do not consume context or trigger an automatic message retry', async () => {
  const { broker, read } = setup();
  let calls = 0;
  await assert.rejects(broker.withContext('task', 'Read', async (text) => {
    calls++; assert.equal(text, expected(1, 1)); throw new Error('delivery_timeout');
  }), /delivery_timeout/);
  assert.equal(calls, 1);
  assert.equal(await read(), expected(1, 1));
  assert.equal(await read(), 'Read');
});

test('late completion cannot overwrite a newer delivered state', async () => {
  const { broker, grant, read } = setup();
  let finish!: () => void;
  const first = broker.withContext('task', 'Read', (text) => {
    assert.equal(text, expected(1, 1));
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  broker.revoke(client, grant.grantId);
  assert.equal(await read(), expected(0, 0));
  finish(); await first;
  assert.equal(await read(), 'Read');
});

test('pending delivery does not suppress another message and changes during send stay pending', async () => {
  const { broker, grant, read } = setup();
  let finish!: () => void;
  const pending = broker.withContext('task', 'Read', () => new Promise<void>((resolve) => { finish = resolve; }));
  assert.equal(await read(), expected(1, 1));
  broker.revoke(client, grant.grantId);
  finish(); await pending;
  assert.equal(await read(), expected(0, 0));
});

test('bounded context retention does not let a late send resurrect an evicted task', async () => {
  const { broker } = setup();
  let finish!: () => void;
  const pending = broker.withContext('task', 'Read', () => new Promise<void>((resolve) => { finish = resolve; }));
  for (let i = 0; i < 64; i++) {
    const id = `other-${i}`;
    broker.bind(client, id, target);
    await broker.withContext(id, 'Read', echo);
  }
  finish(); await pending;
  assert.equal(await broker.withContext('task', 'Read', echo), 'Read');
  const again = broker.bind(client, 'task', target);
  broker.heartbeat(client, again.grantId);
  assert.equal(await broker.withContext('task', 'Read', echo), expected(1, 1));
});
