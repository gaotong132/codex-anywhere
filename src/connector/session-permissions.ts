import { open } from 'node:fs/promises';

const SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

type JsonObject = Record<string, any>;

export async function needsDesktopPermissionRecovery(filePath: string) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    let cursor = size;
    let scanned = 0;
    let carry = '';
    let foundLegacyOverride = false;

    while (cursor > 0 && scanned < MAX_SCAN_BYTES) {
      const length = Math.min(SCAN_CHUNK_BYTES, cursor, MAX_SCAN_BYTES - scanned);
      const start = cursor - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const text = buffer.subarray(0, bytesRead).toString('utf8') + carry;
      const lines = text.split('\n');
      carry = start > 0 ? (lines.shift() || '') : '';

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const context = parseTurnContext(lines[index]);
        if (!context) continue;
        if (isLegacyBridgeOverride(context)) {
          foundLegacyOverride = true;
          continue;
        }
        return foundLegacyOverride && isFullAccess(context);
      }

      cursor = start;
      scanned += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function parseTurnContext(line: string): JsonObject | null {
  if (!line.includes('"turn_context"')) return null;
  try {
    const row = JSON.parse(line);
    return row?.type === 'turn_context' && row.payload && typeof row.payload === 'object'
      ? row.payload : null;
  } catch {
    return null;
  }
}

function isLegacyBridgeOverride(context: JsonObject) {
  const sandbox = context.sandbox_policy || {};
  const profile = context.permission_profile || {};
  return context.approval_policy === 'untrusted'
    && sandbox.type === 'workspace-write'
    && sandbox.network_access === false
    && sandbox.exclude_tmpdir_env_var === false
    && sandbox.exclude_slash_tmp === false
    && profile.type === 'managed'
    && profile.file_system?.type === 'restricted'
    && profile.network === 'restricted';
}

function isFullAccess(context: JsonObject) {
  return context.approval_policy === 'never'
    && context.sandbox_policy?.type === 'danger-full-access'
    && context.permission_profile?.type === 'disabled';
}

export const internals = { isFullAccess, isLegacyBridgeOverride, parseTurnContext };
