import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestHandler } from '../src/connector/request-handler.js';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';

function createDependencies(overrides = {}) {
  return {
    codex: {
      child: {},
      activeTurns: new Map(),
      getActiveTurn(threadId) { return this.activeTurns.get(threadId) || null; },
      listSessions: async () => [],
      readSession: async () => ({}),
      renameSession: async (threadId, name) => ({ threadId, title: name }),
      deleteSession: async (threadId) => ({ threadId, deleted: true }),
      listSessionTurns: async () => ({}),
      readTurnDiff: async (threadId, turnId) => ({ threadId, turnId, content: 'diff' }),
      readModelConfig: async () => ({ model: 'gpt-default' }),
      updateModelConfig: async (_threadId, value) => value,
      readPermissionMode: async () => ({ mode: 'ask' }),
      updatePermissionMode: async (_threadId, mode) => ({ mode }),
      startTurn: async () => ({ threadId: 'started-thread' }),
      steerTurn: async ({ threadId }) => ({ threadId, turnId: 'turn-1', steered: true }),
      stopTurn: async () => ({ stopped: true }),
      listApprovals: () => ({ approvals: [] }),
      respondApproval: async () => ({}),
      getDesktopTurnOverrides: () => ({}),
      isLargeSession: async () => false,
      canOwnSession: () => true,
      needsDesktopPermissionRecovery: async () => false,
      ...overrides.codex,
    },
    desktop: {
      getCapabilities: async () => ({ available: true, tools: ['send_message_to_thread', 'read_thread', 'set_thread_archived', 'navigate_to_codex_page'] }),
      listThreads: async () => [],
      readThreadState: async () => ({ status: 'idle', waitingOnApproval: false }),
      sendMessage: async ({ threadId }) => ({ threadId, delivery: 'desktop' }),
      renameThread: async ({ threadId, name }) => ({ threadId, title: name }),
      ...overrides.desktop,
    },
    attachments: {
      save: async () => ({}),
      read: async () => ({}),
      ...overrides.attachments,
    },
    visualizations: {
      read: async () => ({}),
      ...overrides.visualizations,
    },
    downloads: {
      open: async () => ({}),
      read: async () => ({}),
      readMarkdown: async () => ({}),
      readText: async () => ({}),
      close: async () => ({}),
      ...overrides.downloads,
    },
    deviceId: 'personal-pc',
    onSessionStatuses: overrides.onSessionStatuses,
    deviceLabel: overrides.deviceLabel || 'My computer',
    mode: overrides.mode || 'desktop',
    networkAccess: overrides.networkAccess || false,
    allowFullAccess: overrides.allowFullAccess || false,
  };
}

function request(action, payload = {}) {
  return { action, payload, requestId: 'request-1', clientId: 'client-1' };
}

test('Desktop controls route native models, exact-turn stop and request-scoped approval without app-server mutations', async () => {
  const calls: any[] = [];
  const native = { read: async id => ({ threadId: id, approvals: [], waitingOnApproval: false }),
    modelConfig: async (id, models) => ({ model: (await models)[0].model, threadId: id }),
    updateModel: async (...args) => { calls.push(['model', ...args]); return { model: 'native' }; },
    stop: async (...args) => { calls.push(['stop', ...args]); return { stopped: true }; },
    respond: async (...args) => { calls.push(['approval', ...args]); return { resolved: true }; } };
  const handle = createRequestHandler(createDependencies({ codex: { listModels: async () => [{ model: 'native' }],
    readModelConfig: async () => assert.fail(), updateModelConfig: async () => assert.fail(),
    stopTurn: async () => assert.fail(), respondApproval: async () => assert.fail() }, desktop: { controls: native } }));
  assert.equal((await handle(request('session.model-config.read', { threadId: 'selected' }))).data.model, 'native');
  await handle(request('session.model-config.update', { threadId: 'selected', model: 'native' }));
  await handle(request('turn.stop', { threadId: 'selected', source: 'desktop', expectedTurnId: 't1' }));
  await handle(request('approval.respond', { threadId: 'selected', approvalId: 'desktop:id', approved: true }));
  assert.deepEqual(calls[1], ['stop', 'selected', 't1']);
  assert.deepEqual(calls[2], ['approval', 'selected', 'desktop:id', true]);
  const unsupported = createRequestHandler(createDependencies());
  assert.equal((await unsupported(request('session.model-config.update', { threadId: 'selected' }))).error, 'desktop_input_unsupported');
});

test('cold Desktop model reads share the catalog and fall back only to saved metadata', async () => {
  let catalogs = 0, savedReads = 0, live = false;
  const handle = createRequestHandler(createDependencies({ codex: {
    listModels: async () => { catalogs++; return [{ model: 'catalog-default' }]; },
    readModelConfig: async () => assert.fail('must not infer Desktop settings from defaults'),
    readStoredModelConfig: async (id, catalog) => {
      assert.equal(id, 'cold'); savedReads++;
      return { model: 'saved-astra', reasoningEffort: 'high', readOnly: true, source: 'persisted', models: await catalog };
    },
  }, desktop: { controls: { modelConfig: async () => {
    if (!live) throw new Error('desktop_input_not_ready');
    return { model: 'live-astra', source: 'desktop' };
  } }, openThread: async () => assert.fail('model reads must not navigate') } }));
  const first = await handle(request('session.model-config.read', { threadId: 'cold' }));
  assert.equal(first.data.model, 'saved-astra'); assert.equal(first.data.source, 'persisted');
  assert.equal(first.data.readOnly, true); assert.equal(catalogs, 1);
  live = true;
  assert.equal((await handle(request('session.model-config.read', { threadId: 'cold' }))).data.model, 'live-astra');
  assert.equal(savedReads, 1, 'live native settings take precedence');
});

test('native images are validated before delivery and never resolve arbitrary browser paths', async () => {
  let sent: any;
  const handle = createRequestHandler(createDependencies({ attachments: { nativeInput: async image => {
    if (image.path !== 'uploaded') throw new Error('attachment_path_not_allowed'); return 'validated.png';
  } }, desktop: { sendMessage: async message => { sent = message; return { threadId: message.threadId }; } } }));
  assert.equal((await handle(request('turn.start', { threadId: 'selected', text: 'image', image: { path: 'secret' } }))).error, 'attachment_path_not_allowed');
  assert.equal(sent, undefined);
  assert.equal((await handle(request('turn.start', { threadId: 'selected', text: 'image', image: { path: 'uploaded' } }))).ok, true);
  assert.equal(sent.imagePath, 'validated.png');
});

test('desktop archive requires confirmation, protects owned turns, and advertises only supported nodes', async () => {
  const calls: string[] = [];
  const deps = createDependencies({ desktop: { archiveThread: async ({ threadId }) => {
    calls.push(threadId); return { threadId, archived: true };
  } } });
  const handler = createRequestHandler(deps);
  assert.equal((await handler(request('connector.status'))).data.capabilities.sessionArchive, true);
  assert.equal((await handler(request('session.archive', { threadId: 'target', confirm: 'true' }))).error, 'session_archive_confirmation_required');
  assert.equal((await handler(request('session.archive', { confirm: true }))).error, 'thread_id_required');
  deps.codex.activeTurns.set('target', { threadId: 'target' });
  assert.equal((await handler(request('session.archive', { threadId: 'target', confirm: true }))).error, 'session_archive_not_idle');
  deps.codex.activeTurns.clear();
  assert.equal((await handler(request('session.archive', { threadId: 'target', confirm: true }))).ok, true);
  assert.deepEqual(calls, ['target']);
  const headless = createRequestHandler({ ...deps, mode: 'headless' });
  assert.equal((await headless(request('connector.status'))).data.capabilities.sessionArchive, undefined);
  assert.equal((await headless(request('session.archive', { threadId: 'target', confirm: true }))).error, 'session_archive_unsupported');
  assert.deepEqual(calls, ['target']);
});

test('session deletion requires headless mode and explicit confirmation', async () => {
  const deleted: string[] = [];
  const codex = { deleteSession: async (threadId: string) => { deleted.push(threadId); return { threadId, deleted: true }; } };
  const desktop = createRequestHandler(createDependencies({ codex }));
  assert.equal((await desktop(request('session.delete', { threadId: 'a', confirm: true }))).error, 'session_delete_headless_only');
  const headless = createRequestHandler(createDependencies({ codex, mode: 'headless' }));
  assert.equal((await headless(request('connector.status'))).data.capabilities.sessionDelete, true);
  for (const confirm of [undefined, false, 'true', 1]) {
    assert.equal((await headless(request('session.delete', { threadId: 'a', confirm }))).error, 'session_delete_confirmation_required');
  }
  assert.deepEqual(deleted, []);
  assert.deepEqual((await headless(request('session.delete', { threadId: 'a', confirm: true }))).data, { threadId: 'a', deleted: true });
  assert.deepEqual(deleted, ['a']);
});

test('file upload RPCs use the authenticated device owner and advertise support only when enabled', async () => {
  const calls: any[] = [];
  const fileUploads = Object.fromEntries(['begin', 'chunk', 'complete', 'cancel'].map((method) => [method,
    async (payload, owner) => { calls.push({ method, owner, payload }); return { uploaded: true }; },
  ]));
  const handler = createRequestHandler({ ...createDependencies(), fileUploads });
  const status = await handler(request('connector.status'));
  assert.equal(status.data.capabilities.fileUpload, true);
  for (const method of ['begin', 'chunk', 'complete', 'cancel']) {
    const result = await handler({ ...request(`file.upload.${method}`, { owner: 'spoofed' }), clientDeviceId: 'approved-device' });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(calls.map((call) => call.owner), Array(4).fill('approved-device'));
  const unsupported = createRequestHandler(createDependencies());
  assert.equal((await unsupported(request('connector.status'))).data.capabilities.fileUpload, undefined);
  assert.equal((await unsupported(request('file.upload.begin'))).error, 'file_upload_unsupported');
});

test('browser context follows exact PC/headless state changes without repeating on steer', async () => {
  for (const mode of ['desktop', 'headless'] as const) {
    const calls: any[] = [];
    const dependencies = createDependencies({ mode, codex: {
      startTurn: async (payload: any) => { calls.push(payload); return {}; },
      steerTurn: async (payload: any) => { calls.push(payload); return {}; },
    }, desktop: { sendMessage: async (payload: any) => { calls.push(payload); return {}; } } });
    const browser = new BrowserSessionBroker(mode, () => true);
    const client = { clientId: 'extension', clientDeviceId: 'browser-a' };
    const root = browser.bind(client, 'bound', { browserDeviceId: 'browser-a', tabId: 1, documentId: 'doc-a', origin: 'https://private.example.com' });
    browser.heartbeat(client, root.grantId);
    const handler = createRequestHandler({ ...dependencies, browser });
    for (const action of ['turn.start', 'turn.steer']) {
      assert.equal((await handler(request(action, { threadId: 'bound', text: 'Inspect current page', turnId: 'turn-1' }))).ok, true);
      assert.equal((await handler(request(action, { threadId: 'other', text: 'Unrelated task', turnId: 'turn-1' }))).ok, true);
    }
    assert.equal(calls.length, 4);
    {
      const payload = calls[0];
      assert.equal(payload.threadId, 'bound');
      assert.match(payload.text, /^Inspect current page\n\n\[Anywhere browser:/);
      assert.match(payload.text, /1 authorized/);
      assert.match(payload.text, /anywhere_browser_list_pages/);
      assert.doesNotMatch(payload.text, /private\.example|browser-a|doc-a/);
    }
    assert.equal(calls[2].text, 'Inspect current page', 'unchanged state is not repeated on steer');
    assert.equal(calls[1].text, 'Unrelated task'); assert.equal(calls[3].text, 'Unrelated task');
    browser.revoke(client, root.grantId);
    await handler(request('turn.start', { threadId: 'bound', text: 'Continue' }));
    assert.match(calls[4].text, /0 authorized/);
    assert.equal(browser.status('bound').online, false);
  }
});

test('failed Desktop, headless and steer deliveries retain browser context for the next user send', async () => {
  for (const [mode, action] of [['desktop', 'turn.start'], ['headless', 'turn.start'], ['desktop', 'turn.steer']] as const) {
    const texts: unknown[] = [];
    const deliver = async (payload: any) => {
      texts.push(payload.text);
      if (texts.length === 1) throw new Error('delivery_timeout');
      return { threadId: payload.threadId };
    };
    const dependencies = createDependencies({ mode, codex: { startTurn: deliver, steerTurn: deliver }, desktop: { sendMessage: deliver } });
    const browser = new BrowserSessionBroker(mode, () => true);
    const client = { clientId: 'extension', clientDeviceId: 'browser' };
    browser.bind(client, 'task', { browserDeviceId: 'browser', tabId: 1, documentId: 'doc', origin: 'https://example.com' });
    const handle = createRequestHandler({ ...dependencies, browser });
    const send = () => handle(request(action, { threadId: 'task', turnId: 'turn', text: 'Read' }));
    assert.equal((await send()).ok, false);
    assert.equal(texts.length, 1, 'no automatic resend');
    assert.equal((await send()).ok, true);
    assert.equal(texts[0], texts[1]);
    assert.match(String(texts[1]), /Anywhere browser:/);
    assert.equal((await send()).ok, true);
    assert.equal(texts[2], 'Read');
  }
});

test('browser authorization validates an existing Session without sending or creating a turn', async () => {
  const reads: string[] = [];
  const dependencies = createDependencies({ codex: {
    readSession: async (threadId: string) => { reads.push(threadId); if (threadId === 'missing') throw new Error('session_not_found'); return {}; },
    startTurn: async () => assert.fail('binding must not create or resume a writer'),
  }, desktop: { sendMessage: async () => assert.fail('binding must not send any message') } });
  const browser = new BrowserSessionBroker('personal-pc', () => true);
  const handle = createRequestHandler({ ...dependencies, browser });
  const capability = await handle({ ...request('connector.status'), clientDeviceId: 'browser-a' });
  assert.equal((capability as any).data.capabilities.browserGrantReplacement, true);
  const payload = { threadId: 'original', target: { browserDeviceId: 'browser-a', tabId: 1, documentId: 'doc-a', origin: 'https://example.com' } };
  const bound = await handle({ ...request('browser.bind', payload), clientDeviceId: 'browser-a' });
  assert.equal(bound.ok, true); assert.deepEqual(reads, ['original']);
  assert.equal(browser.status('original').authorized, true);
  const nextPayload = { ...payload, target: { ...payload.target, tabId: 2, documentId: 'doc-b' } };
  assert.equal((await handle({ ...request('browser.bind', nextPayload), clientDeviceId: 'browser-a' })).ok, false);
  assert.equal((await handle({ ...request('browser.bind', { ...nextPayload, replaceExisting: 'true' }), clientDeviceId: 'browser-a' })).ok, false);
  const replacement = await handle({ ...request('browser.bind', { ...nextPayload, replaceExisting: true }), clientDeviceId: 'browser-a' });
  assert.equal(replacement.ok, true);
  assert.equal(browser.status('original').pageCount, 1);
  assert.equal((await handle({ ...request('browser.bind', { ...nextPayload, recoverOnly: true }), clientDeviceId: 'browser-a' })).ok, false);
  assert.equal((await handle({ ...request('browser.bind', { ...payload, threadId: 'missing' }), clientDeviceId: 'browser-a' })).ok, false);
  assert.equal(browser.status('missing').authorized, false);
  assert.equal((await handle(request('browser.bind', payload))).ok, false);
  const navigation = { grantId: (replacement as any).data.grantId, target: { ...nextPayload.target, documentId: 'next-document' } };
  const navigated = await handle({ ...request('browser.navigate', navigation), clientDeviceId: 'browser-a' });
  assert.equal(navigated.ok, true);
  assert.equal(browser.status('original').pageCount, 1);
  assert.equal((await handle({ ...request('browser.navigate', navigation), clientDeviceId: 'browser-a' })).ok, false, 'old grant cannot be reused');
  const disabled = createRequestHandler(dependencies);
  assert.equal((await disabled({ ...request('browser.bind', payload), clientDeviceId: 'browser-a' })).ok, false);
  assert.equal((await disabled({ ...request('browser.navigate', navigation), clientDeviceId: 'browser-a' })).ok, false);
});

test('file downloads stay authorized to the stable browser identity across relay reconnects', async () => {
  const owners = [];
  const handle = createRequestHandler(createDependencies({
    downloads: {
      open: async (_payload, owner) => { owners.push(owner); return {}; },
      read: async (_payload, owner) => { owners.push(owner); return {}; },
      close: async (_payload, owner) => { owners.push(owner); return {}; },
    },
  }));
  for (const action of ['file.download.open', 'file.download.chunk', 'file.download.close']) {
    await handle({
      action, payload: {}, requestId: action,
      clientId: `relay-${action}`, clientDeviceId: 'approved-browser-device',
    });
  }
  assert.deepEqual(owners, [
    'approved-browser-device', 'approved-browser-device', 'approved-browser-device',
  ]);
});

test('request handler keeps connector routing independent from process startup', async () => {
  const handle = createRequestHandler(createDependencies());
  assert.deepEqual(await handle(request('connector.status')), {
    type: 'response',
    clientId: 'client-1',
    requestId: 'request-1',
    ok: true,
    data: {
      deviceId: 'personal-pc', deviceLabel: 'My computer', mode: 'desktop',
      platform: process.platform, codexOnline: true, activeTurn: false,
      desktopOnline: true, desktopInputOnline: false, desktopTools: ['send_message_to_thread', 'read_thread', 'set_thread_archived', 'navigate_to_codex_page'],
      capabilities: { networkAccess: false, fullAccess: false, sessionDelete: false },
    },
  });
});

test('headless permission modes stay behind connector capabilities', async () => {
  const calls = [];
  const handle = createRequestHandler(createDependencies({
    mode: 'headless',
    networkAccess: true,
    allowFullAccess: true,
    codex: {
      readPermissionMode: async (threadId) => { calls.push(['read', threadId]); return { mode: 'ask' }; },
      updatePermissionMode: async (threadId, mode) => {
        calls.push(['update', threadId, mode]); return { mode };
      },
    },
  }));
  const read = await handle(request('session.permissions.read', { threadId: 'thread-1' }));
  assert.deepEqual(read.data, {
    mode: 'ask', editable: true, networkAccess: true, allowFullAccess: true,
  });
  const updated = await handle(request('session.permissions.update', {
    threadId: 'thread-1', mode: 'auto',
  }));
  assert.equal(updated.data.mode, 'auto');
  assert.deepEqual(calls, [['read', 'thread-1'], ['update', 'thread-1', 'auto']]);
});

test('headless dispatch steers only its target and lists every concurrent task as active', async () => {
  const calls: any[] = [];
  const handle = createRequestHandler(createDependencies({ mode: 'headless', codex: {
    activeTurns: new Map(['a', 'b'].map(threadId => [threadId, { threadId, turnId: `turn-${threadId}`, state: 'running' }])),
    listSessions: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    startTurn: async payload => { calls.push(['start', payload.threadId]); return { threadId: payload.threadId }; },
    steerTurn: async payload => { calls.push(['steer', payload.threadId]); return { threadId: payload.threadId }; },
  } }));
  assert.equal((await handle(request('connector.status'))).data.activeTurn, true);
  assert.deepEqual((await handle(request('sessions.list'))).data.sessions, [
    { id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'c' },
  ]);
  await Promise.all(['b', 'c'].map(threadId => handle(request('turn.start', { threadId, text: 'Continue' }))));
  assert.deepEqual(calls, [['steer', 'b'], ['start', 'c']]);
});

test('Desktop permission updates never fall back to an independent app-server writer', async () => {
  let updates = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { updatePermissionMode: async () => { updates += 1; return { mode: 'full' }; } },
  }));
  const response = await handle(request('session.permissions.update', {
    threadId: 'thread-1', mode: 'full',
  }));
  assert.equal(response.ok, false);
  assert.match(response.error, /desktop_permission_mode_managed_on_computer/);
  assert.equal(updates, 0);
});

test('Desktop permission routes use native controls and connector capabilities', async () => {
  const calls: any[] = [];
  const handle = createRequestHandler(createDependencies({ networkAccess: false, allowFullAccess: true,
    codex: { readPermissionMode: async () => assert.fail('must use live native settings'),
      updatePermissionMode: async () => assert.fail('must not acquire Desktop writer') },
    desktop: { controls: {
      permissions: async (...args: any[]) => { calls.push(args); return { mode: 'custom', source: 'desktop', editable: true, settingsToken: 'before' }; },
      updatePermissions: async (...args: any[]) => { calls.push(args); return { mode: 'auto', source: 'desktop', editable: true, settingsToken: 'after' }; },
    } as any },
  }));
  assert.equal((await handle(request('session.permissions.read', { threadId: 'native' }))).data.mode, 'custom');
  assert.equal((await handle(request('session.permissions.update', { threadId: 'native', mode: 'auto', settingsToken: 'before' }))).data.mode, 'auto');
  assert.deepEqual(calls, [['native', { networkAccess: false, allowFullAccess: true }],
    ['native', { threadId: 'native', mode: 'auto', settingsToken: 'before' }, { networkAccess: false, allowFullAccess: true }]]);
});

test('Desktop permissions refresh persisted state and expose navigation only for a capable Desktop connector', async () => {
  const calls: any[] = [];
  const dependencies = createDependencies({
    codex: { readPermissionMode: async (...args) => { calls.push(args); return { mode: 'full' }; } },
    desktop: { openThread: async (args) => { calls.push(args); return { opened: true }; } },
  });
  const handle = createRequestHandler(dependencies);
  const read = await handle(request('session.permissions.read', { threadId: 'thread-1' }));
  assert.equal(read.data.editable, false);
  assert.equal(read.data.canOpenOnDesktop, true);
  assert.deepEqual(calls[0], ['thread-1', { fresh: true }]);
  const opened = await handle(request('session.desktop.open', { threadId: 'thread-1', hostId: 'elsewhere' }));
  assert.equal(opened.ok, true);
  assert.deepEqual(calls[1], { threadId: 'thread-1' });
  for (const candidate of [createDependencies(), { ...dependencies, mode: 'headless' as const }]) {
    const unavailable = createRequestHandler(candidate);
    assert.equal((await unavailable(request('session.permissions.read', { threadId: 'thread-1' }))).data.canOpenOnDesktop, undefined);
    assert.equal((await unavailable(request('session.desktop.open', { threadId: 'thread-1' }))).error, 'desktop_app_unavailable');
  }
  assert.equal(calls.length, 3, 'only permission read reaches the headless gateway');
});

test('session rename stays inside the selected execution environment', async () => {
  const desktopCalls = [];
  const desktopHandle = createRequestHandler(createDependencies({
    desktop: { renameThread: async (value) => { desktopCalls.push(value); return { title: value.name }; } },
  }));
  const desktopResponse = await desktopHandle(request('session.rename', {
    threadId: 'desktop-thread', name: 'Desktop task',
  }));
  assert.equal(desktopResponse.data.title, 'Desktop task');
  assert.deepEqual(desktopCalls, [{
    threadId: 'desktop-thread', name: 'Desktop task',
  }]);

  const headlessCalls = [];
  const headlessHandle = createRequestHandler(createDependencies({
    mode: 'headless',
    codex: {
      renameSession: async (threadId, name) => {
        headlessCalls.push([threadId, name]);
        return { threadId, title: name };
      },
    },
  }));
  const headlessResponse = await headlessHandle(request('session.rename', {
    threadId: 'ecs-thread', name: 'ECS task',
  }));
  assert.equal(headlessResponse.data.title, 'ECS task');
  assert.deepEqual(headlessCalls, [['ecs-thread', 'ECS task']]);
});

test('headless connectors resume existing sessions through their own app-server', async () => {
  let started;
  let desktopCalls = 0;
  const handle = createRequestHandler(createDependencies({
    mode: 'headless',
    codex: { startTurn: async (message) => { started = message; return { threadId: message.threadId }; } },
    desktop: { sendMessage: async () => { desktopCalls += 1; return {}; } },
  }));

  const response = await handle(request('turn.start', { threadId: 'ecs-thread', text: 'continue' }));
  assert.deepEqual(started, {
    threadId: 'ecs-thread', text: 'continue', requestId: 'request-1', clientId: 'client-1',
  });
  assert.equal(desktopCalls, 0);
  assert.equal(response.ok, true);
  assert.equal(response.data.delivery, 'appServer');
});

test('visualization reads stay on the dedicated bounded connector path', async () => {
  let payload;
  const handle = createRequestHandler(createDependencies({
    visualizations: { read: async (value) => {
      payload = value;
      return { name: 'concept.html', size: 20, content: '<main>concept</main>' };
    } },
  }));
  const response = await handle(request('visualization.read', { path: 'C:\\artifact.html' }));
  assert.deepEqual(payload, { path: 'C:\\artifact.html' });
  assert.equal(response.data.name, 'concept.html');
});

test('Markdown previews use the bounded local file reader', async () => {
  let payload;
  const handle = createRequestHandler(createDependencies({
    downloads: { readMarkdown: async (value) => {
      payload = value;
      return { name: 'README.md', size: 8, content: '# Readme' };
    } },
  }));
  const response = await handle(request('file.markdown.read', { path: 'D:\\project\\README.md' }));
  assert.deepEqual(payload, { path: 'D:\\project\\README.md' });
  assert.equal(response.data.content, '# Readme');
});

test('code previews use the bounded local text reader', async () => {
  let payload;
  const handle = createRequestHandler(createDependencies({
    downloads: { readText: async (value) => {
      payload = value;
      return {
        name: 'worker.ts', size: 18, content: 'export const ok = 1;',
        kind: 'code', language: 'typescript',
      };
    } },
  }));
  const response = await handle(request('file.text.read', { path: 'D:\\project\\worker.ts' }));
  assert.deepEqual(payload, { path: 'D:\\project\\worker.ts' });
  assert.equal(response.data.language, 'typescript');
});

test('turn diffs route through the bounded session and turn lookup', async () => {
  const calls = [];
  const handle = createRequestHandler(createDependencies({
    codex: {
      readTurnDiff: async (threadId, turnId) => {
        calls.push({ threadId, turnId });
        return { threadId, turnId, size: 4, content: 'diff', truncated: false };
      },
    },
  }));
  const response = await handle(request('session.turn.diff.read', {
    threadId: 'thread-1', turnId: 'turn-2', ignoredPath: 'D:\\private',
  }));
  assert.deepEqual(calls, [{ threadId: 'thread-1', turnId: 'turn-2' }]);
  assert.equal(response.data.content, 'diff');
});

test('headless model configuration stays on the app-server control path', async () => {
  const calls = [];
  const handle = createRequestHandler(createDependencies({
    mode: 'headless',
    codex: {
      readModelConfig: async (threadId) => {
        calls.push({ action: 'read', threadId });
        return { model: 'gpt-5.6-sol', reasoningEffort: 'high', fastMode: false, models: [] };
      },
      updateModelConfig: async (threadId, value) => {
        calls.push({ action: 'update', threadId, value });
        return { ...value, serviceTier: 'fast', models: [] };
      },
    },
  }));
  const read = await handle(request('session.model-config.read', { threadId: 'thread-1' }));
  assert.equal(read.data.model, 'gpt-5.6-sol');
  const updated = await handle(request('session.model-config.update', {
    threadId: 'thread-1', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', fastMode: true,
  }));
  assert.equal(updated.data.serviceTier, 'fast');
  assert.deepEqual(calls.map((call) => call.action), ['read', 'update']);
});

test('session listing returns immediately and merges asynchronously cached Desktop status', async () => {
  const sessions = [{ id: 'thread-1', status: 'notLoaded' }];
  let resolveDesktopStatus;
  const available = createRequestHandler(createDependencies({
    codex: { listSessions: async () => sessions },
    desktop: { listThreads: () => new Promise((resolve) => { resolveDesktopStatus = resolve; }) },
  }));
  assert.equal((await available(request('sessions.list'))).data.sessions[0].status, 'notLoaded');
  resolveDesktopStatus([{ id: 'thread-1', status: 'active' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await available(request('sessions.list'))).data.sessions[0].status, 'active');

  const unavailable = createRequestHandler(createDependencies({
    codex: { listSessions: async () => sessions },
    desktop: { listThreads: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  assert.deepEqual((await unavailable(request('sessions.list'))).data.sessions, sessions);

  const locallyActive = createRequestHandler(createDependencies({
    codex: {
      activeTurns: new Map([['thread-1', { threadId: 'thread-1' }]]),
      listSessions: async () => sessions,
    },
    desktop: { listThreads: async () => [{ id: 'thread-1', status: 'notLoaded' }] },
  }));
  assert.equal((await locallyActive(request('sessions.list'))).data.sessions[0].status, 'active');
});

test('session listing coalesces Desktop status refreshes while one is in flight', async () => {
  const sessions = [{ id: 'thread-1', status: 'notLoaded' }];
  let desktopCalls = 0;
  let resolveDesktopStatus;
  const handle = createRequestHandler(createDependencies({
    codex: { listSessions: async () => sessions },
    desktop: {
      getCapabilities: async () => ({ available: true, tools: ['send_message_to_thread', 'read_thread', 'set_thread_archived', 'navigate_to_codex_page'] }),
      listThreads: () => {
        desktopCalls += 1;
        return new Promise((resolve) => { resolveDesktopStatus = resolve; });
      },
    },
  }));

  await Promise.all([
    handle(request('sessions.list')),
    handle(request('sessions.list')),
    handle(request('sessions.list')),
  ]);
  assert.equal(desktopCalls, 1);
  resolveDesktopStatus([{ id: 'thread-1', status: 'active' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await handle(request('sessions.list'))).data.sessions[0].status, 'active');
  assert.equal(desktopCalls, 1, 'completed refreshes are also shared across browser clients');
});

test('Desktop status changes push immediately without another list request; unchanged rows do not push', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const updates: any[] = [];
  let calls = 0;
  let status = 'active';
  const handler = createRequestHandler(createDependencies({
    onSessionStatuses: snapshot => updates.push(snapshot),
    codex: { listSessions: async () => [{ id: 'thread-1', status: 'notLoaded' }] },
    desktop: { listThreads: async options => {
      assert.equal(options.limit, 50);
      calls++;
      return [{ id: 'thread-1', status }];
    } },
  }));
  const first = await handler(request('sessions.list'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.data.desktopStatuses, null);
  assert.deepEqual(updates, [{ revision: 1, threads: [{ id: 'thread-1', status: 'active' }] }]);
  await Promise.all(Array.from({ length: 20 }, () => handler(request('sessions.list'))));
  assert.equal(calls, 1);
  context.mock.timers.tick(6_000);
  await handler(request('sessions.list'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1, 'identical status suppresses broadcasts');
  status = 'idle';
  context.mock.timers.tick(6_000);
  await handler(request('sessions.list'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates[1].threads[0].status, 'idle');
  assert.equal(updates[1].revision, 3);
});

test('Desktop failures are throttled and expired status does not persist as running', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let calls = 0;
  const handler = createRequestHandler(createDependencies({
    codex: { listSessions: async () => [{ id: 'thread-1', status: 'notLoaded' }] },
    desktop: { listThreads: async () => {
      if (++calls > 1) throw new Error('timeout');
      return [{ id: 'thread-1', status: 'active' }];
    } },
  }));
  await handler(request('sessions.list'));
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(6_000);
  await handler(request('sessions.list'));
  await new Promise(resolve => setImmediate(resolve));
  await handler(request('sessions.list'));
  assert.equal(calls, 2);
  context.mock.timers.tick(10_000);
  const expired = await handler(request('sessions.list'));
  assert.equal(expired.data.desktopStatuses, null);
  assert.equal(expired.data.sessions[0].status, 'notLoaded');
});

test('existing sessions are always delivered through Desktop without bridge takeover', async () => {
  let delivered;
  let appServerCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => { appServerCalls += 1; return {}; } },
    desktop: { sendMessage: async (message) => {
      delivered = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', { threadId: 'target-thread', text: 'hello' }));
  assert.deepEqual(delivered, {
    threadId: 'target-thread', text: 'hello', requestId: 'request-1',
  });
  assert.equal(appServerCalls, 0);
  assert.equal(response.ok, true);
  assert.equal(response.data.delivery, 'desktop');
});

test('active Desktop sessions receive follow-up messages immediately through Desktop', async () => {
  let delivered;
  let appServerCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => { appServerCalls += 1; return {}; } },
    desktop: { sendMessage: async (message) => {
      delivered = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', {
    threadId: 'target-thread', text: 'adjust this now', preferDesktop: true,
    model: 'stale-model', reasoningEffort: 'low',
  }));
  assert.deepEqual(delivered, {
    threadId: 'target-thread', text: 'adjust this now', requestId: 'request-1',
  });
  assert.equal(appServerCalls, 0);
  assert.deepEqual(response.data, { threadId: 'target-thread', delivery: 'desktop' });
});

test('browser fields and model settings cannot override the Desktop destination or source', async () => {
  let sent;
  const handle = createRequestHandler(createDependencies({
    codex: {
      getDesktopTurnOverrides: async () => ({
        model: 'gpt-5.6-sol', thinking: 'high',
        threadId: 'another-project', callerThreadId: 'production-thread',
        text: 'unexpected text', requestId: 'unexpected-request',
      }),
    },
    desktop: { sendMessage: async (message) => { sent = message; return { threadId: message.threadId }; } },
  }));
  const response = await handle(request('turn.start', {
    threadId: 'selected-thread', text: 'User input', callerThreadId: 'production-thread',
    sourceThreadId: 'another-project', requestId: 'browser-request',
  }));
  assert.equal(response.ok, true);
  assert.deepEqual(sent, {
    threadId: 'selected-thread', text: 'User input', requestId: 'request-1',
  });
});

test('delayed runtime preparation cannot move a message to a later selected session', async () => {
  let resolveFirst;
  const firstSettings = new Promise((resolve) => { resolveFirst = resolve; });
  const sent = [];
  const handle = createRequestHandler(createDependencies({
    codex: { prepareDesktopTurn: (() => { let count = 0; return () => ++count === 1 ? firstSettings : Promise.resolve(); })() },
    desktop: { sendMessage: async (message) => { sent.push(message); return { threadId: message.threadId }; } },
  }));
  const first = handle(request('turn.start', { threadId: 'thread-a', text: 'A' }));
  await handle(request('turn.start', { threadId: 'thread-b', text: 'B' }));
  resolveFirst({});
  await first;
  assert.deepEqual(sent.map(({ threadId, text }) => [threadId, text]), [['thread-b', 'B'], ['thread-a', 'A']]);
  assert.ok(sent.every((message) => !Object.hasOwn(message, 'callerThreadId')));
});

test('turn stop stays bound to the selected connector-owned thread', async () => {
  let stoppedThreadId;
  const handle = createRequestHandler(createDependencies({
    codex: {
      stopTurn: async (threadId) => {
        stoppedThreadId = threadId;
        return { stopped: true };
      },
    },
  }));
  const response = await handle(request('turn.stop', { threadId: 'thread-1' }));
  assert.equal(stoppedThreadId, 'thread-1');
  assert.deepEqual(response.data, { stopped: true });
});

test('Desktop delivery inherits native settings instead of applying stale Connector overrides', async () => {
  let delivered;
  const handle = createRequestHandler(createDependencies({
    codex: {
      getDesktopTurnOverrides: () => ({ model: 'gpt-5.6-sol', thinking: 'xhigh' }),
    },
    desktop: { sendMessage: async (message) => {
      delivered = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', {
    threadId: 'target-thread', text: 'continue', preferDesktop: true,
    model: 'stale-model', reasoningEffort: 'low',
  }));
  assert.deepEqual(delivered, {
    threadId: 'target-thread', text: 'continue', requestId: 'request-1',
  });
  assert.equal(response.ok, true);
});

test('active Web-owned sessions steer the in-flight app-server turn', async () => {
  let steered;
  const handle = createRequestHandler(createDependencies({
    codex: { steerTurn: async (message) => {
      steered = message;
      return { threadId: message.threadId, turnId: 'turn-1', steered: true };
    } },
  }));
  const response = await handle(request('turn.steer', { threadId: 'target-thread', text: 'focus tests' }));
  assert.deepEqual(steered, {
    threadId: 'target-thread', text: 'focus tests', requestId: 'request-1', clientId: 'client-1',
  });
  assert.deepEqual(response.data, {
    threadId: 'target-thread', turnId: 'turn-1', steered: true, delivery: 'appServer',
  });
});

test('existing sessions do not replay stored Desktop turn overrides', async () => {
  let sent;
  let appServerCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: {
      getDesktopTurnOverrides: () => ({ model: 'gpt-5.6-sol', thinking: 'high' }),
      startTurn: async () => { appServerCalls += 1; return { threadId: 'target-thread' }; },
    },
    desktop: { sendMessage: async (message) => {
      sent = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', { threadId: 'target-thread', text: 'continue' }));
  assert.deepEqual(sent, {
    threadId: 'target-thread', text: 'continue', requestId: 'request-1',
  });
  assert.equal(response.data.delivery, 'desktop');
  assert.equal(appServerCalls, 0);
});

test('active Desktop sessions preserve the explicit destination without a caller override', async () => {
  let sent;
  let appServerCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => { appServerCalls += 1; throw new Error('thread_active_writer_conflict'); } },
    desktop: { sendMessage: async (message) => {
      sent = message;
      return { threadId: message.threadId, delivery: 'desktop' };
    } },
  }));
  const response = await handle(request('turn.start', { threadId: 'target-thread', text: 'hello' }));
  assert.deepEqual(sent, {
    threadId: 'target-thread', text: 'hello', requestId: 'request-1',
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.delivery, 'desktop');
  assert.equal(appServerCalls, 0);
});

test('Desktop absence never lets the bridge take over an existing session', async () => {
  let startCalls = 0;
  const fallback = createRequestHandler(createDependencies({
    codex: { startTurn: async (message) => {
      startCalls += 1;
      throw new Error('thread_active_writer_conflict');
    } },
    desktop: { sendMessage: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  const response = await fallback(request('turn.start', { threadId: 'thread-1', text: 'continue' }));
  assert.equal(response.ok, false);
  assert.equal(response.error, 'desktop_app_unavailable');
  assert.equal(startCalls, 0);

  const large = createRequestHandler(createDependencies({
    codex: { isLargeSession: async () => true },
    desktop: { sendMessage: async () => { throw new Error('desktop_app_unavailable'); } },
  }));
  assert.equal((await large(request('turn.start', { threadId: 'large-thread', text: 'continue' }))).error,
    'desktop_app_unavailable');
});

test('Desktop delivery errors are not converted into a second send attempt', async () => {
  let resumeCalls = 0;
  const handle = createRequestHandler(createDependencies({
    codex: { startTurn: async () => {
      resumeCalls += 1;
      throw new Error('thread_active_writer_conflict');
    } },
    desktop: { sendMessage: async () => { throw new Error('desktop_delivery_failed:rejected'); } },
  }));
  const response = await handle(request('turn.start', { threadId: 'thread-1', text: 'hello' }));
  assert.equal(response.ok, false);
  assert.equal(response.error, 'desktop_delivery_failed:rejected');
  assert.equal(resumeCalls, 0);
});

test('pending approval requests are scoped to the selected thread and rebind the client', async () => {
  let query;
  const handle = createRequestHandler(createDependencies({
    codex: { listApprovals: (threadId, clientId) => {
      query = { threadId, clientId };
      return { approvals: [{ approvalId: 'approval-1', threadId }] };
    } },
  }));
  const response = await handle(request('approval.pending', { threadId: 'thread-1' }));
  assert.deepEqual(query, { threadId: 'thread-1', clientId: 'client-1' });
  assert.equal(response.data.approvals[0].approvalId, 'approval-1');
});

test('Desktop-owned approval is reported as informational instead of an actionable approval', async () => {
  const handle = createRequestHandler(createDependencies({
    desktop: { readThreadState: async () => ({ status: 'active', waitingOnApproval: true }) },
  }));
  const response = await handle(request('approval.pending', { threadId: 'thread-1' }));
  assert.equal(response.ok, true);
  assert.equal(response.data.approvals.length, 0);
  assert.deepEqual(response.data.externalApproval, {
    approvalId: '',
    threadId: 'thread-1',
    kind: 'desktop',
    summary: 'This approval is owned by Codex Desktop.',
    actionable: false,
  });
});

test('unavailable Desktop status is distinct from a resolved approval', async () => {
  const unavailable = createRequestHandler(createDependencies({
    desktop: { readThreadState: async () => { throw new Error('desktop_timeout'); } },
  }));
  const result = await unavailable(request('approval.pending', { threadId: 'target' }));
  assert.equal(result.data.desktopStatusUnavailable, true);
  const idle = createRequestHandler(createDependencies());
  assert.deepEqual((await idle(request('approval.pending', { threadId: 'target' }))).data.desktopState,
    { status: 'idle', waitingOnApproval: false });
});

test('archive cancellation requires a strict boolean and restore validates response identity', async () => {
  const inputs: any[] = [];
  const handle = createRequestHandler(createDependencies({ desktop: {
    archiveThread: async (value) => { inputs.push(value); return { threadId: value.threadId, archived: true }; },
    restoreThread: async ({ threadId }) => ({ threadId: threadId === 'bad' ? 'other' : threadId, archived: false }),
  } }));
  for (const cancelPendingApproval of ['true', false, true]) {
    assert.equal((await handle(request('session.archive', { threadId: 'target', confirm: true, cancelPendingApproval }))).ok, true);
  }
  assert.deepEqual(inputs.map(value => value.cancelPendingApproval), [false, false, true]);
  assert.equal((await handle(request('session.restore', { threadId: 'target' }))).data.archived, false);
  assert.equal((await handle(request('session.restore', { threadId: 'bad' }))).error, 'session_delivery_mismatch');
});


test('Desktop controls follow host capabilities independently of app-server health', async () => {
  for (const state of [
    { available: false, tools: [] },
    { available: true, tools: ['send_message_to_thread'] },
    { available: true, tools: ['set_thread_archived'] },
  ]) {
    const handle = createRequestHandler(createDependencies({ desktop: {
      getCapabilities: async () => state,
      archiveThread: async () => ({}), restoreThread: async () => ({}), openThread: async () => ({}),
    } }));
    const status = (await handle(request('connector.status'))).data;
    assert.equal(status.codexOnline, true);
    assert.equal(status.desktopOnline, state.available);
    assert.equal(status.capabilities.sessionArchive, undefined, 'archive also requires read_thread');
    assert.equal(status.capabilities.sessionRestore, state.tools.includes('set_thread_archived') ? true : undefined);
    assert.equal((await handle(request('session.permissions.read', { threadId: 'fixture' }))).data.canOpenOnDesktop, undefined);
  }
  const headless = createRequestHandler(createDependencies({ mode: 'headless', desktop: {
    getCapabilities: async () => { throw new Error('headless must not probe Desktop'); },
  } }));
  assert.equal((await headless(request('connector.status'))).ok, true);
});

test('a slow catalog cannot hold current-model display and diagnostics reveal the pending stage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (value: any) => void, ownerRead = false;
  const handle = createRequestHandler(createDependencies({
    codex: { listModels: () => new Promise(resolve => { release = resolve; }) },
    desktop: { controls: { modelConfig: async (_id, catalog) => { ownerRead = true;
      return { model: 'current-native', models: await catalog, readOnly: true }; } } },
  }));
  const reading = handle(request('session.model-config.read', { threadId: 'private-thread' }));
  assert.equal(ownerRead, true, 'native owner read starts before catalog completion');
  const diagnostics = (await handle(request('connector.diagnostics'))).data.operations;
  assert.ok(diagnostics.some(row => row.operation === 'model.catalog' && row.outcome === 'pending'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-thread/);
  t.mock.timers.tick(1500);
  const result = await reading;
  assert.equal(result.data.model, 'current-native'); assert.deepEqual(result.data.models, []);
  release([]); await Promise.resolve();
});

test('cold Desktop permission fallback is read-only and never opens or resumes the task; native takeover wins', async () => {
  let cold = true;
  let stored = 0;
  let error = 'desktop_input_not_ready';
  const handle = createRequestHandler(createDependencies({ allowFullAccess: true,
    codex: { readStoredPermissionConfig: async (id: string) => {
      assert.equal(id, 'cold'); stored++;
      return { mode: 'auto', networkAccess: false, editable: false, source: 'persisted' };
    }, readPermissionMode: async () => assert.fail('no guessed defaults'), updatePermissionMode: async () => assert.fail('no second writer') },
    desktop: { openThread: async () => assert.fail('must not focus Desktop'), controls: {
      permissions: async () => { if (cold) throw new Error(error); return { mode: 'full', editable: true, source: 'desktop' }; },
      updatePermissions: async () => { throw new Error('desktop_input_not_ready'); },
    } as any },
  }));
  const first = await handle(request('session.permissions.read', { threadId: 'cold' }));
  assert.equal(first.data.mode, 'auto');
  assert.equal(first.data.editable, false);
  assert.equal(first.data.allowFullAccess, true);
  assert.equal(first.data.canOpenOnDesktop, undefined);
  assert.equal((await handle(request('session.permissions.update', { threadId: 'cold', mode: 'full' }))).ok, false);
  error = 'desktop_state_invalid_patch';
  assert.equal((await handle(request('session.permissions.read', { threadId: 'cold' }))).ok, false);
  cold = false;
  const native = await handle(request('session.permissions.read', { threadId: 'cold' }));
  assert.equal(native.data.source, 'desktop');
  assert.equal(native.data.editable, true);
  assert.equal(stored, 1);
});

test('cold permission mutation only falls back on pre-mutation missing ownership', async () => {
  let error = 'desktop_input_not_ready', calls = 0;
  const handle = createRequestHandler(createDependencies({ allowFullAccess: true,
    codex: { updateStoredPermissionConfig: async (id: string, value: any) => {
      calls++; assert.equal(id, 'cold'); assert.equal(value.settingsToken, 'persisted:token');
      return { mode: value.mode, source: 'persisted', editable: true };
    } },
    desktop: { openThread: async () => assert.fail('no navigation'), controls: {
      updatePermissions: async () => { throw new Error(error); },
    } as any },
  }));
  const send = () => handle(request('session.permissions.update', { threadId: 'cold', mode: 'full', settingsToken: 'persisted:token' }));
  assert.equal((await send()).data.mode, 'full'); assert.equal(calls, 1);
  for (error of ['desktop_operation_unknown', 'desktop_settings_changed', 'permission_mode_turn_active', 'desktop_app_unavailable']) {
    assert.equal((await send()).ok, false);
  }
  assert.equal(calls, 1, 'never retry an uncertain native mutation through another writer');
});

test('message edits require confirmation and only a missing Desktop owner can use the cold writer', async () => {
  for (const nativeError of [null, 'desktop_input_not_ready', 'message_edit_unconfirmed']) {
    const starts: any[] = [], edits: any[] = [];
    const handle = createRequestHandler(createDependencies({ codex: {
      prepareMessageEdit: async () => ({ text: 'old', token: 'snapshot', input: [{ secret: 'not sent to browser' }] }),
      startTurn: async value => { starts.push(value); return { threadId: value.threadId }; },
    }, desktop: { controls: { editMessage: async (...args) => { edits.push(args); if (nativeError) throw Error(nativeError); return { threadId: args[0], delivery: 'desktop' }; } } } }));
    assert.deepEqual((await handle(request('turn.edit.prepare', { threadId: 'task', turnId: 'turn' }))).data, { text: 'old', token: 'snapshot' });
    assert.equal((await handle(request('turn.edit', { threadId: 'task', turnId: 'turn', text: 'new', token: 'snapshot' }))).error, 'message_edit_invalid');
    assert.equal((await handle(request('turn.edit', { threadId: 'task', turnId: 'turn', text: 'new', token: 'stale', confirm: true }))).error, 'message_edit_changed');
    assert.equal(edits.length, 0);
    const result = await handle(request('turn.edit', { threadId: 'task', turnId: 'turn', text: 'new', token: 'snapshot', confirm: true }));
    assert.equal(starts.length, nativeError === 'desktop_input_not_ready' ? 1 : 0);
    if (nativeError === 'message_edit_unconfirmed') assert.equal(result.error, nativeError);
    else assert.equal(result.data.delivery, nativeError ? 'appServer' : 'desktop');
  }
});
