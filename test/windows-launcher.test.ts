import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('Windows login startup uses a GUI host without opening a console', async () => {
  const [registrar, installer, launcher] = await Promise.all([
    readFile(resolve('scripts/register-connector-task.ps1'), 'utf8'),
    readFile(resolve('scripts/install-connector.ps1'), 'utf8'),
    readFile(resolve('scripts/launch-connector-hidden.vbs'), 'utf8'),
  ]);

  assert.match(registrar, /wscript\.exe/i);
  assert.match(registrar, /launch-connector-hidden\.vbs/i);
  assert.doesNotMatch(registrar, /New-ScheduledTaskAction\s+`?\s*-Execute\s+\$powerShellPath/i);

  assert.match(installer, /launch-connector-hidden\.vbs/i);
  assert.match(installer, /\.TargetPath\s*=\s*\$wscriptPath/i);
  assert.doesNotMatch(installer, /\.TargetPath\s*=\s*\$powerShellPath/i);
  assert.match(installer, /\$PSBoundParameters\.ContainsKey\('BridgeUrl'\)/);
  assert.match(installer, /Get-ExistingSetting -Name 'allowedRoots'/);
  assert.match(installer, /Get-ExistingSetting -Name 'allowAnyFileDownload'/);

  assert.match(launcher, /shell\.Run\(command,\s*0,\s*True\)/i);
  assert.match(launcher, /-WindowStyle Hidden/i);
});
