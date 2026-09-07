import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthRole } from '../shared/auth.js';
import type { DeviceAuthProof } from '../shared/device-auth.js';
import {
  BROWSER_PAIRING_ID_PATTERN,
  BROWSER_PAIRING_VERIFIER_PATTERN,
  browserPairingVerifier,
  createBrowserPairingCredential,
} from '../shared/pairing-auth.js';

const PAIRING_TTL_MS = 15 * 60_000;
const BROWSER_PAIRING_TTL_MS = 10 * 60_000;
const MAX_PENDING_DEVICES = 32;
const MAX_BROWSER_PAIRINGS = 8;

export type PendingDevice = {
  requestId: string;
  id: string;
  publicKey: string;
  role: AuthRole;
  routeDeviceId?: string;
  label: string;
  address: string;
  requestedAt: number;
};

export type ApprovedDevice = Omit<PendingDevice, 'requestId' | 'address' | 'requestedAt'> & {
  approvedAt: number;
  linkedFrom?: Pick<DeviceAuthProof, 'id' | 'publicKey'>;
};

type BrowserPairing = {
  id: string;
  verifier: string;
  requestedAt: number;
  expiresAt: number;
};

type DeviceRegistryState = {
  version: 2;
  approved: ApprovedDevice[];
  pending: PendingDevice[];
  browserPairings: BrowserPairing[];
  revokedBrowserLinks?: string[];
};

function emptyState(): DeviceRegistryState {
  return { version: 2, approved: [], pending: [], browserPairings: [] };
}

function recordKey(role: AuthRole, id: string) {
  return `${role}:${id}`;
}

function sanitizeState(value: unknown): DeviceRegistryState {
  if (!value || typeof value !== 'object' || ![1, 2].includes(Number((value as { version?: unknown }).version))) {
    throw new Error('device registry has an unsupported format');
  }
  const raw = value as Partial<DeviceRegistryState>;
  if (!Array.isArray(raw.approved) || !Array.isArray(raw.pending)) {
    throw new Error('device registry is invalid');
  }
  return {
    version: 2,
    approved: raw.approved.filter((entry) => entry?.id && entry?.publicKey && entry?.role),
    pending: raw.pending.filter((entry) => entry?.requestId && entry?.id && entry?.publicKey && entry?.role),
    revokedBrowserLinks: Array.isArray(raw.revokedBrowserLinks)
      ? raw.revokedBrowserLinks.filter((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) : [],
    browserPairings: Array.isArray(raw.browserPairings)
      ? raw.browserPairings.filter((entry) => (
        BROWSER_PAIRING_ID_PATTERN.test(String(entry?.id || ''))
        && BROWSER_PAIRING_VERIFIER_PATTERN.test(String(entry?.verifier || ''))
        && Number.isFinite(entry?.requestedAt)
        && Number.isFinite(entry?.expiresAt)
      ))
      : [],
  };
}

export class DeviceRegistry {
  readonly filePath: string | null;
  private state: DeviceRegistryState = emptyState();

  constructor(filePath?: string | null) {
    this.filePath = filePath?.trim() ? resolve(filePath) : null;
    this.refresh(true);
  }

  refresh(required = false) {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) {
      if (required) this.persist();
      return;
    }
    // Always reload the small registry file. The operator may approve the first
    // device out of band, and coarse filesystem timestamps must not delay that
    // approval until the server restarts.
    this.state = sanitizeState(JSON.parse(readFileSync(this.filePath, 'utf8')));
    this.prune(false);
  }

  isApproved(role: AuthRole, device: Pick<DeviceAuthProof, 'id' | 'publicKey'>) {
    this.refresh();
    return this.state.approved.some((entry) => (
      entry.role === role && entry.id === device.id && entry.publicKey === device.publicKey
      && (!entry.linkedFrom || this.state.approved.some((parent) => parent.role === 'client'
        && !parent.linkedFrom && parent.id === entry.linkedFrom!.id && parent.publicKey === entry.linkedFrom!.publicKey))
    ));
  }

  approveLinkedBrowser(device: Pick<DeviceAuthProof, 'id' | 'publicKey'>, sponsor: Pick<DeviceAuthProof, 'id' | 'publicKey'>) {
    this.refresh();
    const parent = this.state.approved.find((entry) => entry.role === 'client' && !entry.linkedFrom
      && entry.id === sponsor.id && entry.publicKey === sponsor.publicKey);
    if (!parent || device.id === sponsor.id) return false;
    if (this.state.revokedBrowserLinks?.includes(device.id)) return false;
    const existing = this.state.approved.find((entry) => entry.role === 'client' && entry.id === device.id);
    if (existing) return this.isApproved('client', device);
    this.state.approved.push({ id: device.id, publicKey: device.publicKey, role: 'client',
      label: 'Anywhere Browser Extension', approvedAt: Date.now(),
      linkedFrom: { id: sponsor.id, publicKey: sponsor.publicKey } });
    this.state.pending = this.state.pending.filter((entry) => entry.role !== 'client' || entry.id !== device.id);
    this.persist();
    return true;
  }

  requestPairing({
    role,
    routeDeviceId,
    device,
    address,
    now = Date.now(),
  }: {
    role: AuthRole;
    routeDeviceId?: string;
    device: DeviceAuthProof;
    address: string;
    now?: number;
  }) {
    this.refresh();
    this.prune(false, now);
    const key = recordKey(role, device.id);
    const existing = this.state.pending.find((entry) => recordKey(entry.role, entry.id) === key);
    if (existing) {
      if (existing.publicKey !== device.publicKey) throw new Error('device_identity_conflict');
      return existing;
    }
    if (this.state.pending.length >= MAX_PENDING_DEVICES) {
      this.state.pending.sort((left, right) => left.requestedAt - right.requestedAt).shift();
    }
    const pending: PendingDevice = {
      requestId: randomUUID(),
      id: device.id,
      publicKey: device.publicKey,
      role,
      ...(routeDeviceId?.trim() ? { routeDeviceId: routeDeviceId.trim().slice(0, 128) } : {}),
      label: device.label?.trim().slice(0, 80) || (role === 'connector' ? 'Connector' : 'Web browser'),
      address: address.slice(0, 128),
      requestedAt: now,
    };
    this.state.pending.push(pending);
    this.persist();
    return pending;
  }

  list() {
    this.refresh();
    this.prune(true);
    return {
      approved: this.state.approved.map((entry) => ({ ...entry })),
      pending: this.state.pending.map((entry) => ({ ...entry })),
    };
  }

  listApproved() {
    this.refresh();
    return this.state.approved.map((entry) => ({ ...entry }));
  }

  createBrowserPairing(now = Date.now()) {
    this.refresh();
    this.prune(false, now);
    while (this.state.browserPairings.length >= MAX_BROWSER_PAIRINGS) {
      this.state.browserPairings.sort((left, right) => left.requestedAt - right.requestedAt).shift();
    }
    const credential = createBrowserPairingCredential();
    const expiresAt = now + BROWSER_PAIRING_TTL_MS;
    this.state.browserPairings.push({
      id: credential.id,
      verifier: browserPairingVerifier(credential.secret),
      requestedAt: now,
      expiresAt,
    });
    this.persist();
    return { credential, expiresAt };
  }

  getBrowserPairingVerifier(id: string, now = Date.now()) {
    this.refresh();
    this.prune(false, now);
    return this.state.browserPairings.find((entry) => entry.id === id)?.verifier || null;
  }

  approveBrowserPairing({
    pairingId,
    verifier,
    device,
    label,
    now = Date.now(),
  }: {
    pairingId: string;
    verifier: string;
    device: Pick<DeviceAuthProof, 'id' | 'publicKey'>;
    label?: string;
    now?: number;
  }) {
    this.refresh();
    this.prune(false, now);
    const index = this.state.browserPairings.findIndex((entry) => entry.id === pairingId);
    if (index < 0 || !verifiersEqual(this.state.browserPairings[index].verifier, verifier)) return null;
    this.state.browserPairings.splice(index, 1);
    const approved: ApprovedDevice = {
      id: device.id,
      publicKey: device.publicKey,
      role: 'client',
      label: label?.trim().slice(0, 80) || 'Web browser',
      approvedAt: now,
    };
    const key = recordKey(approved.role, approved.id);
    this.state.pending = this.state.pending.filter((entry) => recordKey(entry.role, entry.id) !== key);
    this.state.approved = this.state.approved.filter((entry) => recordKey(entry.role, entry.id) !== key);
    this.state.approved.push(approved);
    this.state.revokedBrowserLinks = this.state.revokedBrowserLinks?.filter((id) => id !== approved.id);
    this.persist();
    return approved;
  }

  approve(requestId: string) {
    this.refresh();
    this.prune(false);
    const index = this.state.pending.findIndex((entry) => entry.requestId === requestId);
    if (index < 0) return null;
    const [pending] = this.state.pending.splice(index, 1);
    const approved: ApprovedDevice = {
      id: pending.id,
      publicKey: pending.publicKey,
      role: pending.role,
      ...(pending.routeDeviceId ? { routeDeviceId: pending.routeDeviceId } : {}),
      label: pending.label,
      approvedAt: Date.now(),
    };
    const key = recordKey(approved.role, approved.id);
    this.state.approved = this.state.approved.filter((entry) => recordKey(entry.role, entry.id) !== key);
    this.state.approved.push(approved);
    if (approved.role === 'client') this.state.revokedBrowserLinks = this.state.revokedBrowserLinks?.filter((id) => id !== approved.id);
    this.persist();
    return approved;
  }

  reject(requestId: string) {
    this.refresh();
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((entry) => entry.requestId !== requestId);
    if (this.state.pending.length === before) return false;
    this.persist();
    return true;
  }

  remove(role: AuthRole, id: string) {
    this.refresh();
    const key = recordKey(role, id);
    const before = this.state.approved.length;
    const removed = this.state.approved.filter((entry) => recordKey(entry.role, entry.id) === key
      || (role === 'client' && entry.linkedFrom?.id === id));
    this.state.approved = this.state.approved.filter((entry) => !removed.includes(entry));
    if (this.state.approved.length === before) return false;
    this.state.revokedBrowserLinks = [...new Set([...(this.state.revokedBrowserLinks ?? []),
      ...removed.filter((entry) => entry.role === 'client').map((entry) => entry.id)])];
    this.persist();
    return true;
  }

  private prune(persist: boolean, now = Date.now()) {
    const pending = this.state.pending.filter((entry) => now - entry.requestedAt <= PAIRING_TTL_MS);
    const browserPairings = this.state.browserPairings.filter((entry) => now <= entry.expiresAt);
    if (pending.length === this.state.pending.length
      && browserPairings.length === this.state.browserPairings.length) return;
    this.state.pending = pending;
    this.state.browserPairings = browserPairings;
    if (persist) this.persist();
  }

  private persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
    renameSync(temporary, this.filePath);
  }
}

function verifiersEqual(left: string, right: string) {
  if (!BROWSER_PAIRING_VERIFIER_PATTERN.test(left)
    || !BROWSER_PAIRING_VERIFIER_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
