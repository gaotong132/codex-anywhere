import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceIdentity } from '../src/shared/device-auth.js';
import { ExtensionConnection } from '../extension/src/connection.js';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  closed = false;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  constructor(_url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; this.readyState = 3; }
  send(_data: string) {}
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

test('late errors from a replaced extension socket cannot close the active connection', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const connection = new ExtensionConnection(createDeviceIdentity(), () => {}, () => {});
  t.after(() => { connection.close(); globalThis.WebSocket = original; FakeSocket.instances = []; });
  const first = connection.connect('https://example.com');
  const stale = FakeSocket.instances.at(-1)!;
  stale.receive({ type: 'auth.ok', devices: ['pc'] });
  await first;
  const second = connection.connect('https://example.com');
  const current = FakeSocket.instances.at(-1)!;
  current.receive({ type: 'auth.ok', devices: ['pc', 'pc', 3, null] });
  await second;
  stale.onerror?.(); stale.onclose?.();
  assert.equal(connection.online, true);
  assert.equal(current.closed, false);
  assert.deepEqual(connection.devices, ['pc']);
  assert.throws(() => connection.connect('http://insecure.example'), /browser_https_url_required/);
  assert.equal(current.closed, false, 'invalid input should not destroy a working connection');
  const selecting = connection.select('pc');
  current.receive({ type: 'presence', devices: [] });
  await assert.rejects(selecting, /browser_environment_changed/);
  connection.close();
  assert.deepEqual(connection.devices, []);
  assert.equal(connection.environmentId, '');
});
