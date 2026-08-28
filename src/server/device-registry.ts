import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthRole } from '../shared/auth.js';
import type { DeviceAuthProof } from '../shared/device-auth.js';

const PAIRING_TTL_MS = 15 * 60_000;
const MAX_PENDING_DEVICES = 32;

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
};

type DeviceRegistryState = {
  version: 1;
  approved: ApprovedDevice[];
  pending: PendingDevice[];
};

function emptyState(): DeviceRegistryState {
  return { version: 1, approved: [], pending: [] };
}

function recordKey(role: AuthRole, id: string) {
  return `${role}:${id}`;
}

function sanitizeState(value: unknown): DeviceRegistryState {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    throw new Error('device registry has an unsupported format');
  }
  const raw = value as Partial<DeviceRegistryState>;
  if (!Array.isArray(raw.approved) || !Array.isArray(raw.pending)) {
    throw new Error('device registry is invalid');
  }
  return {
    version: 1,
    approved: raw.approved.filter((entry) => entry?.id && entry?.publicKey && entry?.role),
    pending: raw.pending.filter((entry) => entry?.requestId && entry?.id && entry?.publicKey && entry?.role),
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
    ));
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

  list(currentDeviceId?: string) {
    this.refresh();
    this.prune(true);
    return {
      currentDeviceId: currentDeviceId || null,
      approved: this.state.approved.map((entry) => ({ ...entry })),
      pending: this.state.pending.map((entry) => ({ ...entry })),
    };
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
    this.state.approved = this.state.approved.filter((entry) => recordKey(entry.role, entry.id) !== key);
    if (this.state.approved.length === before) return false;
    this.persist();
    return true;
  }

  private prune(persist: boolean, now = Date.now()) {
    const pending = this.state.pending.filter((entry) => now - entry.requestedAt <= PAIRING_TTL_MS);
    if (pending.length === this.state.pending.length) return;
    this.state.pending = pending;
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
