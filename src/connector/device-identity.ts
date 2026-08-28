import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createDeviceIdentity, type DeviceIdentity } from '../shared/device-auth.js';

export function loadOrCreateConnectorDeviceIdentity({
  privateKey = process.env.BRIDGE_DEVICE_PRIVATE_KEY,
  filePath = process.env.BRIDGE_DEVICE_IDENTITY_FILE,
}: {
  privateKey?: string;
  filePath?: string;
} = {}): DeviceIdentity {
  if (privateKey?.trim()) return createDeviceIdentity(privateKey.trim());
  if (!filePath?.trim()) throw new Error('connector device identity is not configured');
  const target = resolve(filePath);
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<DeviceIdentity>;
    return createDeviceIdentity(String(parsed.privateKey || ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = createDeviceIdentity();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
  try { chmodSync(target, 0o600); } catch { /* Windows ACLs are inherited from the user state dir. */ }
  return identity;
}
