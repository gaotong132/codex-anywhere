import {
  createDeviceAuthProof,
  createDeviceIdentity,
  type DeviceIdentity,
} from '../../src/shared/device-auth';
import type { AuthRole } from '../../src/shared/auth';

const STORAGE_KEY = 'codex-anywhere.device-identity.v1';
const APPROVED_KEY = 'codex-anywhere.device-approved.v1';
let memoryIdentity: DeviceIdentity | null = null;

function validStoredIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== 'object') return false;
  try {
    const candidate = value as DeviceIdentity;
    const rebuilt = createDeviceIdentity(candidate.privateKey);
    return rebuilt.id === candidate.id && rebuilt.publicKey === candidate.publicKey;
  } catch {
    return false;
  }
}

export function loadOrCreateBrowserDeviceIdentity() {
  if (memoryIdentity) return memoryIdentity;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as unknown;
    if (validStoredIdentity(stored)) {
      memoryIdentity = stored;
      return stored;
    }
  } catch {
    // A missing, corrupt, or blocked store gets a fresh page-lifetime identity.
  }
  const identity = createDeviceIdentity();
  memoryIdentity = identity;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(identity)); } catch { /* private mode */ }
  return identity;
}

function browserDeviceLabel() {
  const platform = String(navigator.platform || '').trim();
  return platform ? `Web · ${platform}` : 'Web browser';
}

export function createBrowserDeviceProof(params: {
  challenge: string;
  role: AuthRole;
  authProof: string;
  routeDeviceId?: string;
}) {
  const identity = loadOrCreateBrowserDeviceIdentity();
  return createDeviceAuthProof(identity, params, browserDeviceLabel());
}

export function hasApprovedBrowserDevice() {
  try { return localStorage.getItem(APPROVED_KEY) === '1'; } catch { return false; }
}

export function markBrowserDeviceApproved() {
  try { localStorage.setItem(APPROVED_KEY, '1'); } catch { /* private mode */ }
}

export function clearBrowserDeviceApproval() {
  try { localStorage.removeItem(APPROVED_KEY); } catch { /* private mode */ }
}
