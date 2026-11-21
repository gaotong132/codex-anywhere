import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDesktopClient, supportsAppToolsInput } from '../src/connector/codex-desktop.js';
import { NativeRequestError } from '../src/connector/desktop-native-pipe.js';

const inputSchema = { type: 'object', properties: {
  threadId: { type: 'string' }, prompt: { type: 'string' }, hostId: { type: 'string' },
  model: { type: 'string' }, thinking: { type: 'string' },
}, required: ['threadId', 'prompt'], additionalProperties: false };

function fixture() {
  const desktop = new CodexDesktopClient();
  desktop.legacyInputAvailable = async () => false;
  const calls: any[] = [];
  const client = { tools: new Set(['send_message_to_thread', 'read_thread']),
    toolDefinitions: new Map([
      ['send_message_to_thread', { inputSchema: structuredClone(inputSchema) }],
      ['read_thread', { inputSchema: { properties: { includeTurns: { type: 'boolean' } } } }],
    ]),
    request: async (_method: string, params: any) => {
      calls.push(params);
      return { success: true, contentItems: [{ text: JSON.stringify(params.tool === 'read_thread'
        ? { thread: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } } }
        : { threadId: params.arguments.threadId }) }] };
    }, close() {},
  };
  desktop.getClient = async () => client as any;
  return { desktop, client, calls };
}
const message = { threadId: 'selected-thread', text: 'Actual user input', requestId: 'request-1' };
const modelConfig = { model: 'native', reasoningEffort: 'high', models: [{ model: 'astra',
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };

test('web model choices apply only to later new-transport sends and never mutate a native owner', async () => {
  const { desktop, calls } = fixture();
  try {
    await desktop.messageModels.update(message.threadId, { model: 'astra', reasoningEffort: 'low', fastMode: false }, modelConfig);
    assert.equal(calls.length, 0, 'saving only records web intent, without thread/settings/update or resume');
    const sending = desktop.sendMessage(message);
    await desktop.messageModels.update(message.threadId, { model: 'astra', reasoningEffort: 'high', fastMode: false }, modelConfig);
    await sending;
    assert.equal(calls[0].arguments.model, 'astra'); assert.equal(calls[0].arguments.thinking, 'low');
    await desktop.sendMessage({ ...message, threadId: 'unselected' });
    assert.equal(calls[1].arguments.model, undefined);
    await desktop.messageModels.reset(message.threadId, modelConfig);
    await desktop.sendMessage(message);
    assert.equal(calls[2].arguments.model, undefined);
    await desktop.messageModels.update(message.threadId, { model: 'astra', reasoningEffort: 'low', fastMode: false }, modelConfig);
    desktop.legacyInputAvailable = async () => true;
    let legacy: any;
    desktop.userInput.send = async input => { legacy = input; return {} as any; };
    await desktop.sendMessage(message);
    assert.equal(legacy.model, undefined); assert.equal(legacy.thinking, undefined);
    assert.equal(calls.length, 3, 'returning legacy owners remain authoritative');
  } finally { desktop.close(); }
});

test('changed thinking schemas reject saved preferences before a send is dispatched', async () => {
  const { desktop, client, calls } = fixture();
  try {
    await desktop.messageModels.update(message.threadId, { model: 'astra', reasoningEffort: 'low', fastMode: false }, modelConfig);
    (client.toolDefinitions.get('send_message_to_thread')!.inputSchema.properties.thinking as any).enum = ['high'];
    await assert.rejects(desktop.sendMessage(message), /desktop_input_settings_failed/);
    assert.equal(calls.length, 0);
    delete (client.toolDefinitions.get('send_message_to_thread')!.inputSchema.properties as any).model;
    const unavailable = await desktop.messageModels.read(message.threadId, modelConfig);
    assert.equal(unavailable.readOnly, true); assert.equal(unavailable.hasOverride, true);
    await desktop.messageModels.reset(message.threadId, modelConfig);
    await desktop.sendMessage(message);
    assert.equal(calls.length, 1, 'clearing an obsolete preference restores ordinary messaging');
    assert.equal(calls[0].arguments.model, undefined);
  } finally { desktop.close(); }
});

test('a Desktop without owner IPC advertises messaging separately from legacy controls and images', async () => {
  const { desktop } = fixture();
  try {
    const caps = await desktop.getCapabilities();
    assert.equal(caps.inputAvailable, true);
    assert.equal(caps.inputTransport, 'appTools');
    assert.equal(caps.controlsAvailable, false);
    assert.equal(caps.imagesAvailable, false);
  } finally { desktop.close(); }
});

test('new input uses the selected task as both destination and caller, with a matching acknowledgement', async () => {
  const { desktop, calls } = fixture();
  try {
    assert.deepEqual(await desktop.sendMessage({ ...message, model: 'astra', thinking: 'high' }), {
      threadId: message.threadId, delivery: 'desktop',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, { threadId: message.threadId, hostId: 'local', prompt: message.text, model: 'astra', thinking: 'high' });
    assert.equal(calls[0].threadId, message.threadId);
    assert.equal(calls[0].callerSource, 'codex');
    assert.match(calls[0].callId, /^bridge-input-[0-9a-f]{64}$/);
  } finally { desktop.close(); }
});

test('missing legacy endpoints select the new transport before dispatch, never after an uncertain send', async () => {
  const { desktop, calls } = fixture();
  delete (desktop as any).legacyInputAvailable;
  desktop.userInput.pipe.connect = async () => { throw new NativeRequestError('connect ENOENT pipe', false); };
  try {
    await desktop.sendMessage(message);
    assert.equal(calls.length, 1);
    desktop.userInput.pipe.connect = async () => {};
    desktop.userInput.send = async () => { throw new Error('desktop_delivery_unknown'); };
    await assert.rejects(desktop.sendMessage(message), /desktop_delivery_unknown/);
    assert.equal(calls.length, 1, 'no second transport may retry a dispatched operation');
    desktop.userInput.pipe.connect = async () => { throw new NativeRequestError('desktop input invalid initialization', false); };
    await assert.rejects(desktop.sendMessage(message), /invalid initialization/);
    assert.equal(calls.length, 1, 'an unknown legacy failure is not evidence of removal');
  } finally { desktop.close(); }
});

test('new transport timeouts, rejected or mismatched acknowledgements are uncertain and never retried', async () => {
  for (const outcome of ['timeout', 'rejected', 'wrong-thread', 'missing-id']) {
    const { desktop, client } = fixture(); let attempts = 0;
    client.request = async () => {
      attempts++;
      if (outcome === 'timeout') throw new NativeRequestError('tools/call timeout', true);
      return { success: outcome !== 'rejected', contentItems: [{ text: JSON.stringify(
        outcome === 'missing-id' ? {} : { threadId: 'another-thread' },
      ) }] };
    };
    try {
      await assert.rejects(desktop.sendMessage(message), /desktop_delivery_unknown/);
      assert.equal(attempts, 1);
    } finally { desktop.close(); }
  }
});

test('unknown required fields and changed field types fail before sending; optional additions remain compatible', async () => {
  const { desktop, client, calls } = fixture();
  const definition = client.toolDefinitions.get('send_message_to_thread')!;
  try {
    assert.equal(supportsAppToolsInput(client), true);
    (definition.inputSchema as any).properties.futureOptionalField = { type: 'boolean' };
    assert.equal(supportsAppToolsInput(client), true);
    definition.inputSchema.required.push('futureOptionalField');
    assert.equal((await desktop.getCapabilities()).inputAvailable, false);
    await assert.rejects(desktop.sendMessage(message), /desktop_input_unsupported/);
    definition.inputSchema.required.pop();
    definition.inputSchema.properties.prompt.type = 'number';
    await assert.rejects(desktop.sendMessage(message), /desktop_input_unsupported/);
    assert.equal(calls.length, 0);
  } finally { desktop.close(); }
});

test('new metadata reads omit turns, preserve approval waits and never claim a remotely stoppable turn', async () => {
  const { desktop, calls } = fixture();
  try {
    const state = await desktop.controls.read(message.threadId);
    assert.equal(state.status, 'active'); assert.equal(state.waitingOnApproval, true);
    assert.equal(state.canStop, false); assert.equal(state.turnId, null);
    assert.deepEqual(state.approvals, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.includeTurns, false);
    assert.equal(calls[0].arguments.threadId, calls[0].threadId);
    for (const operation of [
      () => desktop.controls.modelConfig(message.threadId, []),
      () => desktop.controls.updatePermissions(message.threadId, { mode: 'full' }, { allowFullAccess: true, networkAccess: true }),
      () => desktop.controls.stop(message.threadId, 'turn-id'),
      () => desktop.controls.respond(message.threadId, 'approval-id', true),
      () => desktop.controls.editMessage(message.threadId, 'turn-id', 'replacement'),
    ]) await assert.rejects(operation(), /desktop_controls_unsupported/);
    assert.equal(calls.length, 1, 'unsupported controls never mutate a thread or its permissions');
    await assert.rejects(desktop.sendMessage({ ...message, imagePath: '/original.png' }), /desktop_image_unsupported/);
    assert.equal(calls.length, 1, 'a raw native image must not be silently discarded');
  } finally { desktop.close(); }
});

test('new input preserves the per-thread send queue and snapshots browser values', async () => {
  const { desktop, client } = fixture();
  let release!: () => void; const calls: any[] = [];
  client.request = async (_method, params) => {
    calls.push(params.arguments);
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return { success: true, contentItems: [{ text: JSON.stringify({ threadId: message.threadId }) }] };
  };
  try {
    const input = { ...message };
    const first = desktop.sendMessage(input);
    input.text = 'changed after submission';
    const second = desktop.sendMessage({ ...message, text: 'second input', requestId: 'request-2' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.length, 1); assert.equal(calls[0].prompt, message.text);
    release(); await Promise.all([first, second]);
    assert.deepEqual(calls.map(call => call.prompt), [message.text, 'second input']);
  } finally { desktop.close(); }
});
