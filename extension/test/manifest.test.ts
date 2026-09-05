import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { buildExtensionManifest } from '../build-manifest.js';

test('built extension identifies the project version and fingerprints every emitted artifact', async () => {
  const root = 'extension/dist';
  const project = JSON.parse(await readFile('package.json', 'utf8'));
  const built = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const artifacts: Record<string, Uint8Array> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name !== 'manifest.json') artifacts[relative(root, path).replaceAll('\\', '/')] = await readFile(path);
    }
  }
  await walk(root);
  assert.equal(built.version, project.version);
  assert.ok(built.permissions.includes('sidePanel'));
  assert.equal(built.side_panel.default_path, 'sidepanel.html');
  assert.equal(built.action.default_popup, undefined);
  assert.match(built.version_name, /^\d+\.\d+\.\d+ dev \(build [0-9a-f]{8}\)$/);
  assert.deepEqual(built, buildExtensionManifest(project.version, artifacts));
  assert.doesNotMatch(built.content_security_policy.extension_pages, /\[::1\]/);
});

test('build fingerprints are deterministic and change with content or project version', () => {
  const artifacts = { 'popup.html': '<main/>', 'background.js': 'const a = 1;' };
  const original = buildExtensionManifest('0.2.1', artifacts);
  assert.deepEqual(original, buildExtensionManifest('0.2.1', { 'background.js': artifacts['background.js'], 'popup.html': artifacts['popup.html'] }));
  assert.notEqual(original.version_name, buildExtensionManifest('0.2.1', { ...artifacts, 'background.js': 'const a = 2;' }).version_name);
  assert.notEqual(original.version_name, buildExtensionManifest('0.2.2', artifacts).version_name);
});
