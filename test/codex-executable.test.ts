import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCodexExecutable } from '../src/connector/codex-executable.js';

test('Windows Codex Desktop paths are rediscovered after a version directory is replaced', async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), 'codex-anywhere-bin-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const root = join(localAppData, 'OpenAI', 'Codex', 'bin');
  const previous = join(root, 'previous', 'codex.exe');
  const current = join(root, 'current', 'codex.exe');
  await mkdir(join(root, 'previous'), { recursive: true });
  await mkdir(join(root, 'current'), { recursive: true });
  await writeFile(previous, 'previous');
  await writeFile(current, 'current');
  await utimes(previous, new Date(1_000), new Date(1_000));
  await utimes(current, new Date(2_000), new Date(2_000));

  assert.equal(await resolveCodexExecutable(previous, { platform: 'win32', localAppData }), current);
  await rm(join(root, 'previous'), { recursive: true, force: true });
  assert.equal(await resolveCodexExecutable(previous, { platform: 'win32', localAppData }), current);
});

test('custom executable commands remain under operator control', async () => {
  assert.equal(await resolveCodexExecutable('codex-custom', {
    platform: 'win32', localAppData: 'C:\\unused',
  }), 'codex-custom');
  assert.equal(await resolveCodexExecutable('/opt/codex/bin/codex', {
    platform: 'linux', localAppData: '',
  }), '/opt/codex/bin/codex');
});
