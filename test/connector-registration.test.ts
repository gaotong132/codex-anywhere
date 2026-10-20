import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('Linux installations generate unique routes, then preserve existing IDs and custom labels without evaluating config', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-registration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'connector.env');
  const resolve = (id = '', label = '') => execFileSync(process.execPath,
    ['scripts/connector-registration.mjs', path, id, label], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n');
  const [a] = resolve(), [b] = resolve();
  assert.notEqual(a, b);
  assert.match(a, /^node-[0-9a-f-]{36}$/);
  writeFileSync(path, 'BRIDGE_DEVICE_ID="ecs"\nBRIDGE_DEVICE_LABEL="生产服务器 $(not-executed)"\nBRIDGE_CONNECTOR_TOKEN=not-for-output\n');
  assert.deepEqual(resolve(), ['ecs', '生产服务器 $(not-executed)']);
  assert.deepEqual(resolve('new-server', '测试服务器'), ['new-server', '测试服务器']);
  assert.throws(() => resolve('invalid/route'));
  assert.throws(() => resolve('pc', 'bad\nname'));
});
