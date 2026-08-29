import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const CONNECTOR_AUTH_PROTOCOL = 'codex-anywhere-connector-auth-v1';
export const AUTH_CHALLENGE_PATTERN = /^[a-f0-9]{64}$/;
export type AuthRole = 'client' | 'connector';

export function normalizeAuthDeviceId(value: unknown) {
  return String(value || 'personal-pc').trim().slice(0, 128) || 'personal-pc';
}

export function createConnectorAuthProof(
  token: string,
  challenge: string,
  deviceId: string,
) {
  if (!AUTH_CHALLENGE_PATTERN.test(challenge)) throw new Error('invalid_auth_challenge');
  const transcript = [
    CONNECTOR_AUTH_PROTOCOL,
    challenge,
    'connector',
    normalizeAuthDeviceId(deviceId),
  ].join('\n');
  return bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(transcript)));
}
