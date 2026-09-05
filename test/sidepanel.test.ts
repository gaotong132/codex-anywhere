import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBridgeServer } from '../src/server/server.js';
import { SIDEPANEL_MESSAGE, SIDEPANEL_PATH, parseSidePanelSession, sidePanelTarget } from '../src/shared/sidepanel.js';

const extensionId = 'a'.repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}`;
const channel = 'b'.repeat(32);
const panelPath = `${SIDEPANEL_PATH}?extensionId=${extensionId}&channel=${channel}`;

test('only the dedicated side panel entry permits the exact allowlisted extension to embed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywhere-panel-'));
  await writeFile(join(directory, 'index.html'), '<main>Shared Web app</main>');
  const server = createBridgeServer({ connectorToken: 'side-panel-test-token-at-least-32-characters',
    extensionOrigins: [extensionOrigin], publicDir: directory });
  const address = await server.listen(0, '127.0.0.1');
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const embedded = await fetch(base + panelPath);
  assert.equal(embedded.status, 200);
  assert.match(await embedded.text(), /Shared Web app/);
  assert.equal(embedded.headers.get('x-frame-options'), null);
  assert.ok(embedded.headers.get('content-security-policy')!.endsWith(`frame-ancestors ${extensionOrigin}`));
  assert.equal(embedded.headers.get('cache-control'), 'no-store');
  for (const path of ['/', '/config.js', '/health', '/another-page']) {
    const response = await fetch(base + path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.ok(response.headers.get('content-security-policy')!.endsWith("frame-ancestors 'none'"), path);
  }
  for (const path of [SIDEPANEL_PATH, panelPath.replace(extensionId, 'c'.repeat(32)),
    panelPath + `&extensionId=${extensionId}`, panelPath.replace(channel, 'bad')]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 403, path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
});

test('embedding parameters and selection messages are bounded, versioned and tied to a frame channel', () => {
  assert.deepEqual(sidePanelTarget(new URL(panelPath, 'https://relay.example')), { origin: extensionOrigin, channel });
  assert.equal(sidePanelTarget(new URL('/?extensionId=' + extensionId, 'https://relay.example')), null);
  const selection = { type: SIDEPANEL_MESSAGE, version: 1, channel, sequence: 1,
    environmentId: 'ecs', threadId: 'session-a', title: 'My session', online: true };
  assert.deepEqual(parseSidePanelSession({ ...selection, privateKey: 'must never cross the bridge' }, channel),
    { environmentId: 'ecs', threadId: 'session-a', title: 'My session', online: true, sequence: 1 });
  for (const patch of [{ type: 'grant' }, { version: 2 }, { sequence: 0 }, { sequence: 1.5 },
    { channel: 'c'.repeat(32) }, { environmentId: 'x'.repeat(129) }, { threadId: '' },
    { title: 'x'.repeat(161) }, { online: 'true' }]) {
    assert.equal(parseSidePanelSession({ ...selection, ...patch }, channel), null);
  }
});
