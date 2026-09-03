import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import test from 'node:test';
import { loadConnectorConfig } from '../src/connector/config.js';

const token = 'c'.repeat(32);

test('connector configuration applies safe defaults and normalizes an empty device route', () => {
  const config = loadConnectorConfig({ BRIDGE_CONNECTOR_TOKEN: token, BRIDGE_DEVICE_ID: '   ' }, 'C:\\work');

  assert.equal(config.url, 'ws://127.0.0.1:3300/ws');
  assert.equal(config.deviceId, 'personal-pc');
  assert.equal(config.deviceLabel, 'personal-pc');
  assert.equal(config.mode, 'desktop');
  assert.equal(config.codexBin, 'codex');
  assert.deepEqual(config.allowedRoots, ['C:\\work']);
  assert.equal(config.networkAccess, false);
  assert.equal(config.allowAnyFileDownload, false);
});

test('connector configuration parses explicit roots and opt-in capabilities', () => {
  const config = loadConnectorConfig({
    BRIDGE_CONNECTOR_TOKEN: token,
    BRIDGE_URL: 'wss://codex.example.com/ws',
    BRIDGE_DEVICE_ID: ' workstation ',
    BRIDGE_DEVICE_LABEL: ' Studio\nPC ',
    CODEX_CONNECTOR_MODE: 'headless',
    CODEX_BIN: ' codex-custom ',
    CODEX_ALLOWED_ROOTS: ['/workspace/project-a', '/workspace/project-b'].join(delimiter),
    CODEX_NETWORK_ACCESS: '1',
    CODEX_ALLOW_ANY_FILE_DOWNLOAD: '1',
  });

  assert.equal(config.url, 'wss://codex.example.com/ws');
  assert.equal(config.deviceId, 'workstation');
  assert.equal(config.deviceLabel, 'Studio PC');
  assert.equal(config.mode, 'headless');
  assert.equal(config.codexBin, 'codex-custom');
  assert.deepEqual(config.allowedRoots, ['/workspace/project-a', '/workspace/project-b']);
  assert.equal(config.networkAccess, true);
  assert.equal(config.allowAnyFileDownload, true);
});

test('connector configuration rejects short connector secrets', () => {
  assert.throws(
    () => loadConnectorConfig({ BRIDGE_CONNECTOR_TOKEN: 'short' }),
    /at least 32 characters/,
  );
});

test('connector configuration defaults Linux nodes to headless mode', () => {
  const config = loadConnectorConfig({ BRIDGE_CONNECTOR_TOKEN: token }, '/srv/workspace', 'linux');
  assert.equal(config.mode, 'headless');
});

test('connector configuration rejects an unknown runtime mode', () => {
  assert.throws(
    () => loadConnectorConfig({ BRIDGE_CONNECTOR_TOKEN: token, CODEX_CONNECTOR_MODE: 'remote' }),
    /desktop or headless/,
  );
});
