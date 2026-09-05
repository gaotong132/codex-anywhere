import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthRole } from '../shared/auth.js';
import { DEVICE_ID_PATTERN } from '../shared/device-auth.js';
import type { ApprovedDevice } from './device-registry.js';

export const ACTIVITY_INTERVAL_MS = 5_000;
export const ACTIVITY_STALE_MS = 15_000;
type DeviceActivityRecord = {
  id: string; role: AuthRole; connections: number;
  lastConnectedAt: number | null; lastSeenAt: number | null;
};
export type DeviceActivitySnapshot = {
  version: 1; updatedAt: number; relayState: 'running' | 'stopped'; devices: DeviceActivityRecord[];
};
const keyOf = (role: AuthRole, id: string) => `${role}:${id}`;
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8.64e15;
export const deviceActivityPath = (registryPath: string | null) => registryPath ? `${registryPath}.activity.json` : null;

export function readDeviceActivity(path: string | null): DeviceActivitySnapshot | null {
  if (!path) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.version !== 1 || !timestamp(data.updatedAt) || !['running', 'stopped'].includes(data.relayState)
      || !Array.isArray(data.devices)) return null;
    const devices: DeviceActivityRecord[] = [];
    const keys = new Set<string>();
    for (const item of data.devices) {
      if (!DEVICE_ID_PATTERN.test(String(item.id)) || !['client', 'connector'].includes(item.role)
        || !Number.isSafeInteger(item.connections) || item.connections < 0
        || (item.lastConnectedAt !== null && !timestamp(item.lastConnectedAt))
        || (item.lastSeenAt !== null && !timestamp(item.lastSeenAt))) return null;
      const key = keyOf(item.role, item.id);
      if (keys.has(key)) return null;
      keys.add(key);
      devices.push({ id: item.id, role: item.role, connections: item.connections,
        lastConnectedAt: item.lastConnectedAt, lastSeenAt: item.lastSeenAt });
    }
    return { version: 1, updatedAt: data.updatedAt, relayState: data.relayState, devices };
  } catch { return null; }
}

export function activityIsCurrent(snapshot: DeviceActivitySnapshot | null, now = Date.now()) {
  return Boolean(snapshot && (snapshot.relayState === 'stopped'
    || (now >= snapshot.updatedAt && now - snapshot.updatedAt <= ACTIVITY_STALE_MS)));
}

export function activityForDevice(snapshot: DeviceActivitySnapshot | null, role: AuthRole, id: string, now = Date.now()) {
  const record = snapshot?.devices.find((entry) => entry.role === role && entry.id === id);
  const current = activityIsCurrent(snapshot, now);
  const connections = current ? (snapshot?.relayState === 'stopped' ? 0 : record?.connections ?? 0) : null;
  return { status: connections === null ? 'unknown' : connections > 0 ? 'online' : 'offline', connections,
    lastConnectedAt: record?.lastConnectedAt ?? null, lastSeenAt: record?.lastSeenAt ?? null };
}

// The Relay is the sole writer. Keep observations separate from the trust
// registry so heartbeat persistence cannot overwrite operator approvals/revokes.
export class DeviceActivity {
  private connections = new Map<object, string>();
  private records = new Map<string, DeviceActivityRecord>();
  private stopped = false;
  private warned = false;
  constructor(readonly path: string | null, private approved: () => ApprovedDevice[], private clock = Date.now) {
    for (const record of readDeviceActivity(path)?.devices ?? []) {
      this.records.set(keyOf(record.role, record.id), { ...record, connections: 0 });
    }
  }

  connected(socket: object, role: AuthRole, id: string) {
    if (this.stopped) return;
    const key = keyOf(role, id), now = this.clock();
    this.connections.set(socket, key);
    this.records.set(key, { id, role, connections: 0, lastConnectedAt: now, lastSeenAt: now });
    this.flush();
  }

  seen(socket: object) {
    if (this.stopped) return;
    const key = this.connections.get(socket);
    const record = key ? this.records.get(key) : undefined;
    if (record) record.lastSeenAt = this.clock();
  }

  disconnected(socket: object) {
    if (this.connections.delete(socket)) this.flush();
  }

  snapshot(): DeviceActivitySnapshot {
    const devices = this.approved();
    const keys = new Set(devices.map((device) => keyOf(device.role, device.id)));
    for (const key of this.records.keys()) if (!keys.has(key)) this.records.delete(key);
    const counts = new Map<string, number>();
    for (const key of this.connections.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
    return { version: 1, updatedAt: this.clock(), relayState: this.stopped ? 'stopped' : 'running',
      devices: devices.map(({ role, id }) => ({ id, role, connections: counts.get(keyOf(role, id)) ?? 0,
        lastConnectedAt: this.records.get(keyOf(role, id))?.lastConnectedAt ?? null,
        lastSeenAt: this.records.get(keyOf(role, id))?.lastSeenAt ?? null })) };
  }

  flush() {
    if (!this.path) return;
    try {
      const snapshot = this.snapshot();
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
      renameSync(temporary, this.path);
      this.warned = false;
    } catch {
      // Observability failures must not interrupt authentication or E2E routing.
      if (!this.warned) console.error('Device activity snapshot could not be saved; check the private registry directory.');
      this.warned = true;
    }
  }

  stop() { this.stopped = true; this.connections.clear(); this.flush(); }
}
