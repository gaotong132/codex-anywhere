import {
  getPublicKey,
  hashes as ed25519Hashes,
  sign,
  utils as ed25519Utils,
  verify,
} from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AuthRole } from './auth.js';

ed25519Hashes.sha512 = sha512;

export const DEVICE_AUTH_PROTOCOL = 'codex-anywhere-device-v1';
export const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const DEVICE_PUBLIC_KEY_PATTERN = /^[a-f0-9]{64}$/;
export const DEVICE_SIGNATURE_PATTERN = /^[a-f0-9]{128}$/;

export type DeviceIdentity = {
  id: string;
  publicKey: string;
  privateKey: string;
};

export type DeviceAuthProof = {
  id: string;
  publicKey: string;
  signature: string;
  label?: string;
};

export type DevicePublicIdentity = Pick<DeviceIdentity, 'id' | 'publicKey'>;

export function deviceIdFromPublicKey(publicKey: string) {
  if (!DEVICE_PUBLIC_KEY_PATTERN.test(publicKey)) throw new Error('invalid_device_public_key');
  return bytesToHex(sha256(hexToBytes(publicKey)));
}

export function createDeviceIdentity(privateKey?: string): DeviceIdentity {
  const secret = privateKey
    ? hexToBytes(privateKey)
    : ed25519Utils.randomSecretKey();
  if (secret.length !== 32) throw new Error('invalid_device_private_key');
  const publicKey = bytesToHex(getPublicKey(secret));
  return {
    id: deviceIdFromPublicKey(publicKey),
    publicKey,
    privateKey: bytesToHex(secret),
  };
}

export function createDeviceAuthPayload({
  challenge,
  role,
  routeDeviceId = '',
  authProof,
  deviceId,
  publicKey,
}: {
  challenge: string;
  role: AuthRole;
  routeDeviceId?: string;
  authProof: string;
  deviceId: string;
  publicKey: string;
}) {
  return [
    DEVICE_AUTH_PROTOCOL,
    challenge,
    role,
    role === 'connector' ? routeDeviceId.trim().slice(0, 128) : '',
    authProof,
    deviceId,
    publicKey,
  ].join('\n');
}

export function createDeviceAuthProof(
  identity: DeviceIdentity,
  params: Omit<Parameters<typeof createDeviceAuthPayload>[0], 'deviceId' | 'publicKey'>,
  label?: string,
): DeviceAuthProof {
  const payload = createDeviceAuthPayload({
    ...params,
    deviceId: identity.id,
    publicKey: identity.publicKey,
  });
  return {
    id: identity.id,
    publicKey: identity.publicKey,
    signature: signDevicePayload(identity, payload),
    ...(label?.trim() ? { label: label.trim().slice(0, 80) } : {}),
  };
}

export function signDevicePayload(identity: DeviceIdentity, payload: string | Uint8Array) {
  if (deviceIdFromPublicKey(identity.publicKey) !== identity.id) throw new Error('invalid_device_identity');
  const bytes = typeof payload === 'string' ? utf8ToBytes(payload) : payload;
  return bytesToHex(sign(bytes, hexToBytes(identity.privateKey)));
}

export function verifyDevicePayload(
  identity: DevicePublicIdentity,
  signature: string,
  payload: string | Uint8Array,
) {
  if (!DEVICE_ID_PATTERN.test(identity.id)
    || !DEVICE_PUBLIC_KEY_PATTERN.test(identity.publicKey)
    || !DEVICE_SIGNATURE_PATTERN.test(signature)) return false;
  if (deviceIdFromPublicKey(identity.publicKey) !== identity.id) return false;
  const bytes = typeof payload === 'string' ? utf8ToBytes(payload) : payload;
  return verify(hexToBytes(signature), bytes, hexToBytes(identity.publicKey));
}

export function verifyDeviceAuthProof(
  device: DeviceAuthProof,
  params: Omit<Parameters<typeof createDeviceAuthPayload>[0], 'deviceId' | 'publicKey'>,
) {
  const payload = createDeviceAuthPayload({
    ...params,
    deviceId: device.id,
    publicKey: device.publicKey,
  });
  return verifyDevicePayload(device, device.signature, payload);
}
