import { randomBytes } from '@noble/ciphers/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { DEVICE_ID_PATTERN, DEVICE_PUBLIC_KEY_PATTERN } from './device-auth.js';

const BROWSER_PAIRING_PROTOCOL = 'codex-anywhere-browser-pairing-v1';
export const DEVICE_KEY_AUTH_CONTEXT = 'codex-anywhere-approved-device-v1';
export const BROWSER_PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const BROWSER_PAIRING_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const BROWSER_PAIRING_VERIFIER_PATTERN = /^[a-f0-9]{64}$/;

export type BrowserPairingCredential = {
  id: string;
  secret: string;
};

export function createBrowserPairingCredential(): BrowserPairingCredential {
  return {
    id: base64urlnopad.encode(randomBytes(12)),
    secret: base64urlnopad.encode(randomBytes(32)),
  };
}

export function encodeBrowserPairingCredential(credential: BrowserPairingCredential) {
  assertBrowserPairingCredential(credential);
  return `v1.${credential.id}.${credential.secret}`;
}

export function browserPairingFragment(credential: BrowserPairingCredential) {
  return `pair=${encodeBrowserPairingCredential(credential)}`;
}

export function parseBrowserPairingCredential(input: string): BrowserPairingCredential {
  let candidate = input.trim();
  try {
    const url = new URL(candidate);
    candidate = url.hash.slice(1);
  } catch {
    // Raw fragments and values are accepted for devices that cannot open or scan a QR code.
  }
  candidate = candidate.replace(/^#/, '');
  if (candidate.startsWith('pair=')) candidate = candidate.slice('pair='.length);
  const match = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(candidate);
  if (!match) throw new Error('browser_pairing_invalid');
  return { id: match[1], secret: match[2] };
}

export function browserPairingVerifier(secret: string) {
  if (!BROWSER_PAIRING_SECRET_PATTERN.test(secret)) throw new Error('browser_pairing_invalid');
  return bytesToHex(sha256(base64urlnopad.decode(secret)));
}

export function createBrowserPairingProof({
  verifier,
  challenge,
  pairingId,
  deviceId,
  publicKey,
}: {
  verifier: string;
  challenge: string;
  pairingId: string;
  deviceId: string;
  publicKey: string;
}) {
  if (!BROWSER_PAIRING_VERIFIER_PATTERN.test(verifier)
    || !BROWSER_PAIRING_ID_PATTERN.test(pairingId)
    || !DEVICE_ID_PATTERN.test(deviceId)
    || !DEVICE_PUBLIC_KEY_PATTERN.test(publicKey)
    || !/^[a-f0-9]{64}$/.test(challenge)) {
    throw new Error('browser_pairing_invalid');
  }
  const transcript = [
    BROWSER_PAIRING_PROTOCOL,
    challenge,
    pairingId,
    deviceId,
    publicKey,
  ].join('\n');
  return bytesToHex(hmac(sha256, hexToBytes(verifier), utf8ToBytes(transcript)));
}

function assertBrowserPairingCredential(credential: BrowserPairingCredential) {
  if (!BROWSER_PAIRING_ID_PATTERN.test(credential.id)
    || !BROWSER_PAIRING_SECRET_PATTERN.test(credential.secret)) {
    throw new Error('browser_pairing_invalid');
  }
}
