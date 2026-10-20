import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDesktopClient, internals } from '../src/connector/codex-desktop.js';
import { NativePipeClient, NativeRequestError, encodeNativeFrame, MAX_FRAME_BYTES } from '../src/connector/desktop-native-pipe.js';
import { friendlyError } from '../web/src/app-utils.js';

const tools = ['send_message_to_thread', 'read_thread', 'list_threads', 'set_thread_title', 'set_thread_archived'];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function host(run: (request: any, socket: net.Socket) => void, body: (client: NativePipeClient, path: string) => Promise<void>) {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\anywhere-test-${randomUUID()}` : join(tmpdir(), `anywhere-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= 4 + data.readUInt32LE(0)) {
        const length = data.readUInt32LE(0);
        const request = JSON.parse(data.subarray(4, length + 4).toString());
        data = data.subarray(length + 4);
        run(request, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = new NativePipeClient(path);
  client.tools = new Set(tools);
  try { await body(client, path); }
  finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function desktopFor(client: NativePipeClient) {
  const desktop = new CodexDesktopClient({ timeoutMs: 1_000 });
  desktop.getClient = async () => client;
  return desktop;
}

function reply(socket: net.Socket, id: number, result: unknown) {
  socket.write(encodeNativeFrame({ jsonrpc: '2.0', id, result }));
}

test('concurrent discovery shares one client; closing during discovery disposes late results', async () => {
  const desktop = new CodexDesktopClient();
  let probes = 0;
  let resolveProbe!: (client: NativePipeClient) => void;
  desktop.discoverClient = async () => { probes++; return new Promise(resolve => { resolveProbe = resolve; }); };
  const requests = Array.from({ length: 8 }, () => desktop.getClient());
  const first = new NativePipeClient('unused');
  resolveProbe(first);
  assert.equal(new Set(await Promise.all(requests)).size, 1);
  assert.equal(probes, 1);
  const late = desktop.getClient();
  desktop.close();
  const second = new NativePipeClient('unused');
  resolveProbe(second);
  await assert.rejects(late, /desktop_app_unavailable/);
  await assert.rejects(second.connect(100), /closed/);
  assert.equal(desktop.client, null);
});

test('business RPC failure does not cancel a simultaneous send', async () => {
  let sending: { socket: net.Socket; id: number } | undefined;
  await host((request, socket) => {
    if (request.params.tool === 'send_message_to_thread') sending = { socket, id: request.id };
    else {
      socket.write(encodeNativeFrame({ jsonrpc: '2.0', id: request.id, error: { message: 'read rejected' } }));
      reply(sending!.socket, sending!.id, { success: true });
    }
  }, async client => {
    const desktop = desktopFor(client);
    const send = desktop.sendMessage({ threadId: 'fixture', text: 'one', requestId: 'one' });
    const read = desktop.readThreadState({ threadId: 'fixture' });
    await assert.rejects(read, /read rejected/);
    assert.equal((await send).delivery, 'desktop');
    assert.equal(client.connected, true);
  });
});

test('individual timeout and its late response leave another request usable', async () => {
  let slow: { socket: net.Socket; id: number } | undefined;
  await host((request, socket) => {
    if (request.method === 'slow') slow = { socket, id: request.id };
    else {
      reply(slow!.socket, slow!.id, 'late');
      reply(socket, request.id, 'ok');
    }
  }, async client => {
    await assert.rejects(client.request('slow', {}, 30), error => error instanceof NativeRequestError && error.dispatched);
    assert.equal(await client.request('next', {}, 500), 'ok');
    assert.equal(client.connected, true);
  });
});

for (const mode of ['close', 'disconnect', 'timeout'] as const) {
  test(`send ${mode} after dispatch reports unknown delivery without retry`, async () => {
    let received = 0;
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    await host((_request, socket) => {
      received++;
      accepted();
      if (mode === 'disconnect') socket.destroy();
    }, async client => {
      const desktop = desktopFor(client);
      const send = desktop.sendMessage({ threadId: 'fixture', text: 'one', requestId: 'one' });
      const rejected = assert.rejects(send, /desktop_delivery_unknown/);
      await acceptance;
      if (mode === 'close') client.close();
      // Explicit close should settle promptly, not after the request timeout.
      await Promise.race([rejected, pause(mode === 'timeout' ? 1500 : 300).then(() => { throw new Error('pending request leaked'); })]);
      assert.equal(received, 1);
    });
  });
}

test('closing a connecting pipe rejects immediately and cannot resurrect it', async () => {
  await host(() => {}, async client => {
    const connecting = client.connect(1000);
    client.close();
    await assert.rejects(connecting, /closed/);
    await pause(20);
    assert.equal(client.connected, false);
    assert.equal(client.socket, null);
  });
});

test('failure before dispatch is unavailable, not unknown delivery', async () => {
  const desktop = new CodexDesktopClient();
  desktop.getClient = async () => { throw new NativeRequestError('connect timeout', false); };
  await assert.rejects(desktop.sendMessage({ threadId: 'fixture', text: 'one', requestId: 'one' }), /^Error: desktop_app_unavailable$/);
});

test('probe requires the correct namespace and operation dispatch checks cached capabilities', async () => {
  let namespace = 'foreign';
  let calls = 0;
  await host((request, socket) => {
    calls++;
    reply(socket, request.id, { tools: [{ namespace, name: 'send_message_to_thread' }] });
  }, async (_client, path) => {
    assert.equal(await internals.probePipe(path, 500), null);
    namespace = 'codex_app';
    const client = await internals.probePipe(path, 500);
    assert.ok(client);
    try {
      const desktop = desktopFor(client);
      assert.deepEqual(await desktop.getCapabilities(), { available: true, tools: ['send_message_to_thread'] });
      await assert.rejects(desktop.readThreadState({ threadId: 'fixture' }), /desktop_tool_unavailable:read_thread/);
      assert.equal(calls, 2, 'unsupported operation never reaches the host');
    } finally { client.close(); }
  });
});

test('frames between 4 and 8 MiB work with fragmented headers and coalesced responses', async () => {
  await host((request, socket) => {
    const response = encodeNativeFrame({ jsonrpc: '2.0', id: request.id, result: request.params.text });
    socket.write(response.subarray(0, 2));
    socket.write(Buffer.concat([response.subarray(2), encodeNativeFrame({ jsonrpc: '2.0', id: 999, result: 'late' })]));
  }, async client => {
    const text = 'x'.repeat(5 * 1024 * 1024);
    assert.equal(await client.request('echo', { text }, 5000), text);
    await assert.rejects(client.request('echo', { text: 'x'.repeat(MAX_FRAME_BYTES) }, 500), error =>
      error instanceof NativeRequestError && !error.dispatched && error.message === 'desktop_request_too_large');
    assert.equal(await client.request('echo', { text: 'still connected' }, 500), 'still connected');
  });
});

test('oversized or malformed responses reject pending requests promptly', async () => {
  for (const oversized of [true, false]) {
    await host((_request, socket) => {
      const frame = Buffer.alloc(5);
      frame.writeUInt32LE(oversized ? MAX_FRAME_BYTES + 1 : 1, 0);
      frame[4] = 0x7b;
      socket.write(frame);
    }, async client => {
      await assert.rejects(client.request('read', {}, 1000), error => error instanceof NativeRequestError && error.dispatched && /invalid/.test(error.message));
      assert.equal(client.connected, false);
    });
  }
});

test('unknown delivery guidance warns about duplicates without claiming the message was not sent', () => {
  assert.match(friendlyError(new Error('desktop_delivery_unknown')), /可能已经送达/);
  assert.match(friendlyError(new Error('desktop_delivery_timeout')), /避免重复发送/);
});
