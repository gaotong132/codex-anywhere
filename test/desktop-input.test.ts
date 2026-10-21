import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopInputPipe } from '../src/connector/desktop-input-pipe.js';
import { DesktopUserInput } from '../src/connector/desktop-user-input.js';
import { NativeRequestError, encodeNativeFrame, MAX_FRAME_BYTES } from '../src/connector/desktop-native-pipe.js';

async function host(run: (r: any, s: net.Socket) => void, body: (pipe: DesktopInputPipe) => Promise<void>) {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\anywhere-input-${randomUUID()}` : join(tmpdir(), `anywhere-input-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
        run(request, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const pipe = new DesktopInputPipe(path);
  try { await body(pipe); } finally { pipe.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); }
}
function reply(socket: net.Socket, r: any, result: any, owner = 'owner') {
  socket.write(encodeNativeFrame({ type: 'response', requestId: r.requestId, resultType: 'success', method: r.method, handledByClientId: owner, result }));
}
function fail(socket: net.Socket, r: any, error: string) { socket.write(encodeNativeFrame({ type: 'response', requestId: r.requestId, resultType: 'error', error })); }
function standard(r: any, socket: net.Socket) {
  if (r.method === 'initialize') { assert.equal(r.version, 0); assert.equal(r.sourceClientId, 'initializing-client'); reply(socket, r, { clientId: 'bridge-client' }); return true; }
  assert.equal(r.sourceClientId, 'bridge-client');
  if (r.method === 'thread-owner-discovery') { assert.deepEqual(r.params, { hostId: 'local', conversationId: 'fixture' }); reply(socket, r, {}); return true; }
  if (r.method === 'thread-follower-read-model-settings') { assert.equal(r.targetClientId, 'owner'); reply(socket, r, { settings: { model: 'gpt-6-astra', reasoningEffort: 'high', resumeState: 'resumed' } }); return true; }
  return false;
}
const message = { threadId: 'fixture', text: '真实用户输入', requestId: 'one' };

test('concurrent owner reads coalesce without caching stale settings or extending their budget', async () => {
  const pipe = new DesktopInputPipe('unused');
  const input = new DesktopUserInput(async () => assert.fail(), 1000, pipe);
  let calls = 0, release!: () => void;
  pipe.request = async method => {
    calls++;
    if (method === 'thread-owner-discovery') { await new Promise<void>(r => { release = r; }); return { handledByClientId: 'owner' }; }
    return { result: { settings: { model: 'astra', resumeState: 'resumed' } } };
  };
  try {
    const first = input.owner('fixture'), second = input.owner('fixture');
    assert.equal(calls, 1); release();
    assert.equal((await first).id, 'owner'); await second; assert.equal(calls, 2);
    const third = input.owner('fixture'); assert.equal(calls, 3); release(); await third;
  } finally { input.close(); }
});

test('an oversized follower snapshot cannot abort a concurrent native message or model read', async () => {
  await host((r, socket) => {
    if (standard(r, socket)) return;
    if (r.method === 'thread-stream-following-changed') {
      if (r.params.following) {
        const header = Buffer.alloc(4); header.writeUInt32LE(MAX_FRAME_BYTES + 1);
        socket.write(header);
      }
    } else if (r.method === 'thread-follower-steer-turn') {
      setTimeout(() => reply(socket, r, { result: { turnId: 'still-delivered' } }), 30);
    }
  }, async pipe => {
    let disconnected = 0;
    pipe.on('disconnected', () => disconnected++);
    const input = new DesktopUserInput(async () => assert.fail(), 1000, pipe);
    try {
      await Promise.all([
        assert.rejects(input.state.read('fixture', 'owner', 1000), /desktop_state_unavailable/),
        input.send(message),
      ]);
      assert.equal((await input.owner('fixture', false)).settings.model, 'gpt-6-astra');
      assert.equal(disconnected, 0);
    } finally { input.close(); }
  });
});

test('native image inputs carry a localImage part for both running and idle delivery', async () => {
  const sent: any[] = [];
  await host((r, socket) => {
    if (standard(r, socket)) return;
    sent.push(r);
    if (r.method === 'thread-follower-steer-turn') fail(socket, r, 'Cannot steer conversation fixture because its active turn already ended');
    else reply(socket, r, { result: { turn: { id: 'image-turn' } } });
  }, async pipe => {
    const input = new DesktopUserInput(async () => assert.fail(), 1000, pipe);
    await input.send({ ...message, imagePath: 'C:/uploads/validated.png' });
    assert.deepEqual(sent[0].params.input.at(-1), { type: 'localImage', path: 'C:/uploads/validated.png' });
    assert.deepEqual(sent[1].params.turnStart.request.input, sent[0].params.input);
    input.close();
  });
});

test('idle input uses the existing owner and normal input, without toolOutput or a second writer', async () => {
  const writes: any[] = [];
  await host((r, socket) => {
    if (standard(r, socket)) return;
    writes.push(r);
    if (r.method === 'thread-follower-steer-turn') fail(socket, r, 'Cannot steer conversation fixture because its active turn already ended');
    else reply(socket, r, { result: { turn: { id: 'turn-1' } } });
  }, async pipe => {
    const input = new DesktopUserInput(async () => assert.fail('already owned'), 1000, pipe);
    await input.send(message);
    assert.deepEqual(writes.map(r => [r.method, r.version]), [['thread-follower-steer-turn', 1], ['thread-follower-start-turn', 2]]);
    for (const r of writes) { assert.equal(r.targetClientId, 'owner'); assert.equal(r.params.conversationId, 'fixture'); assert.equal(r.hostId, undefined); }
    const start = writes[1].params.turnStart;
    assert.deepEqual(start.request.input, [{ type: 'text', text: message.text, text_elements: [] }]);
    assert.equal(start.request.threadId, 'fixture'); assert.equal(start.context.inheritThreadSettings, true);
    assert.equal(start.context.usePermissionSelection, true, 'native permission selection cannot replay the previous turn profile');
    assert.equal(start.request.clientUserMessageId, writes[0].params.clientUserMessageId);
    assert.doesNotMatch(JSON.stringify(writes), /toolOutput|send_message_to_thread|approvalPolicy|sandboxPolicy|source_thread_id/);
  });
});

test('running input steers exactly once and explicit model changes target the same owner', async () => {
  const writes: any[] = [];
  await host((r, s) => {
    if (standard(r, s)) return;
    writes.push(r);
    reply(s, r, r.method === 'thread-follower-update-thread-settings' ? { applied: true } : { result: { turnId: 'running' } });
  }, async pipe => {
    await new DesktopUserInput(async () => assert.fail(), 1000, pipe).send({ ...message, thinking: 'xhigh' });
    assert.deepEqual(writes.map(r => r.method), ['thread-follower-update-thread-settings', 'thread-follower-steer-turn']);
    assert.deepEqual(writes[0].params.threadSettings, { model: 'gpt-6-astra', effort: 'xhigh' });
  });
});

for (const mode of ['disconnect', 'timeout', 'close', 'host-error', 'wrong-owner', 'invalid-ack'] as const) {
  test(`native input ${mode} never falls back or retries an uncertain submission`, async () => {
    let mutations = 0;
    let activePipe: DesktopInputPipe;
    await host((r, s) => {
      if (standard(r, s)) return;
      mutations++;
      if (mode === 'disconnect') s.destroy();
      if (mode === 'close') activePipe.close();
      if (mode === 'host-error') fail(s, r, 'owner failed after dispatch');
      if (mode === 'wrong-owner') reply(s, r, { result: { turnId: 'running' } }, 'unrelated-owner');
      if (mode === 'invalid-ack') reply(s, r, { result: {} });
    }, async pipe => {
      activePipe = pipe;
      await assert.rejects(new DesktopUserInput(async () => assert.fail(), 80, pipe).send(message), /desktop_delivery_unknown/);
      assert.equal(mutations, 1);
    });
  });
}

test('cold thread is opened only by Desktop, then uses its discovered owner', async () => {
  let opened = 0, mutations = 0;
  await host((r, s) => {
    if (r.method === 'thread-owner-discovery' && !opened) { fail(s, r, 'no-client-found'); return; }
    if (standard(r, s)) return;
    mutations++; reply(s, r, { result: { turnId: 'running' } });
  }, async pipe => {
    await new DesktopUserInput(async id => { assert.equal(id, 'fixture'); opened++; }, 1000, pipe).send(message);
    assert.equal(opened, 1); assert.equal(mutations, 1);
  });
});

test('failed discovery/settings never attempts a user message', async () => {
  for (const stage of ['initialize', 'thread-owner-discovery', 'thread-follower-update-thread-settings']) {
    const methods: string[] = [];
    await host((r, s) => { methods.push(r.method); if (r.method === stage) fail(s, r, 'unsupported'); else if (!standard(r, s)) assert.fail(r.method); }, async pipe => {
      await assert.rejects(new DesktopUserInput(async () => assert.fail(), 1000, pipe).send({ ...message, model: 'gpt-6-astra' }), /desktop_input_(unavailable|settings_failed)/);
      assert.ok(!methods.includes('thread-follower-steer-turn'));
    });
  }
});

test('concurrent initialization is single-flight and we never advertise thread ownership', async () => {
  let initializes = 0, declined = false;
  await host((r, s) => {
    if (r.type === 'client-discovery-response') { assert.deepEqual(r.response, { canHandle: false }); declined = true; return; }
    if (r.method === 'initialize') { initializes++; reply(s, r, { clientId: 'bridge-client' }); s.write(encodeNativeFrame({ type: 'client-discovery-request', requestId: 'discover', request: {} })); }
    else reply(s, r, {});
  }, async pipe => {
    await Promise.all(Array.from({ length: 4 }, () => pipe.request('thread-owner-discovery', {}, 1000)));
    assert.equal(initializes, 1); assert.equal(declined, true);
  });
});

test('a failed read and a late response do not break another native request', async () => {
  let late: any;
  await host((r, s) => {
    if (r.method === 'initialize') { reply(s, r, { clientId: 'bridge-client' }); return; }
    if (r.params.late) late = r;
    else if (r.params.reject) fail(s, r, 'read failed');
    else { reply(s, late, {}); reply(s, r, { ok: true }); }
  }, async pipe => {
    await assert.rejects(pipe.request('thread-owner-discovery', { late: true }, 40), e => e instanceof NativeRequestError && e.dispatched);
    await assert.rejects(pipe.request('thread-owner-discovery', { reject: true }, 1000), /read failed/);
    assert.equal((await pipe.request('thread-owner-discovery', {}, 1000)).result.ok, true);
  });
});

test('native frames are bounded, fragmented/coalesced frames work, closed connect cannot resurrect', async () => {
  await host((r, s) => {
    if (r.method === 'initialize') { reply(s, r, { clientId: 'bridge-client' }); return; }
    const frame = encodeNativeFrame({ type: 'response', requestId: r.requestId, resultType: 'success', method: r.method, handledByClientId: 'owner', result: { text: r.params.text } });
    s.write(frame.subarray(0, 2)); s.write(Buffer.concat([frame.subarray(2), encodeNativeFrame({ type: 'broadcast', params: {} })]));
  }, async pipe => {
    const text = 'x'.repeat(5 * 1024 * 1024);
    assert.equal((await pipe.request('thread-owner-discovery', { text }, 5000)).result.text, text);
    await assert.rejects(pipe.request('thread-owner-discovery', { text: 'x'.repeat(MAX_FRAME_BYTES) }, 1000), /desktop_request_too_large/);
    pipe.close(); await assert.rejects(pipe.connect(100), /closed/);
  });
  const pipe = new DesktopInputPipe('not-a-real-pipe');
  const connecting = pipe.connect(1000); pipe.close(); await assert.rejects(connecting, /closed/);
});

test('same-thread submissions serialize while unrelated threads are independent', async () => {
  const pipe = new DesktopInputPipe('unused');
  let release!: () => void, first = true;
  const order: string[] = [];
  pipe.request = async (method, params) => {
    const thread = params.conversationId;
    if (method === 'thread-owner-discovery') return { handledByClientId: thread, result: {} };
    if (method === 'thread-follower-read-model-settings') return { result: { settings: { resumeState: 'resumed' } } };
    order.push(params.input[0].text);
    if (thread === 'a' && first) { first = false; await new Promise<void>(r => { release = r; }); }
    return { result: { result: { turnId: 'running' } } };
  };
  const input = new DesktopUserInput(async () => assert.fail(), 1000, pipe);
  const one = input.send({ ...message, threadId: 'a', text: 'a1' });
  const two = input.send({ ...message, threadId: 'a', text: 'a2' });
  await input.send({ ...message, threadId: 'b', text: 'b' });
  assert.deepEqual(order, ['a1', 'b']); release(); await Promise.all([one, two]); assert.deepEqual(order, ['a1', 'b', 'a2']);
});
