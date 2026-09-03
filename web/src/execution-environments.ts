export const DEFAULT_ENVIRONMENT_ID = 'personal-pc';

const SELECTED_ENVIRONMENT_KEY = 'bridge.selectedEnvironment.v1';
const KNOWN_ENVIRONMENTS_KEY = 'bridge.knownEnvironments.v1';
const MAX_ENVIRONMENTS = 24;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizeEnvironmentId(value: unknown) {
  return String(value || '').trim().slice(0, 128);
}

export function normalizeEnvironmentIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeEnvironmentId).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_ENVIRONMENTS);
}

export function mergeKnownEnvironmentIds(known: unknown, online: unknown, selected?: unknown) {
  return normalizeEnvironmentIds([
    DEFAULT_ENVIRONMENT_ID,
    ...(Array.isArray(known) ? known : []),
    ...(Array.isArray(online) ? online : []),
    normalizeEnvironmentId(selected),
  ]);
}

export function loadSelectedEnvironmentId(storage: StorageReader = localStorage) {
  try {
    return normalizeEnvironmentId(storage.getItem(SELECTED_ENVIRONMENT_KEY)) || DEFAULT_ENVIRONMENT_ID;
  } catch {
    return DEFAULT_ENVIRONMENT_ID;
  }
}

export function storeSelectedEnvironmentId(environmentId: string, storage: StorageWriter = localStorage) {
  const normalized = normalizeEnvironmentId(environmentId) || DEFAULT_ENVIRONMENT_ID;
  try { storage.setItem(SELECTED_ENVIRONMENT_KEY, normalized); } catch { /* keep in memory */ }
  return normalized;
}

export function loadKnownEnvironmentIds(storage: StorageReader = localStorage) {
  try {
    const stored = JSON.parse(storage.getItem(KNOWN_ENVIRONMENTS_KEY) || '[]');
    return mergeKnownEnvironmentIds(stored, []);
  } catch {
    return [DEFAULT_ENVIRONMENT_ID];
  }
}

export function storeKnownEnvironmentIds(environmentIds: unknown, storage: StorageWriter = localStorage) {
  const normalized = mergeKnownEnvironmentIds(environmentIds, []);
  try { storage.setItem(KNOWN_ENVIRONMENTS_KEY, JSON.stringify(normalized)); } catch { /* keep in memory */ }
  return normalized;
}

export function environmentStorageKey(base: string, environmentId: string) {
  const normalized = normalizeEnvironmentId(environmentId) || DEFAULT_ENVIRONMENT_ID;
  return `${base}.${encodeURIComponent(normalized)}`;
}

export function loadEnvironmentValue(
  base: string,
  environmentId: string,
  storage: StorageReader = localStorage,
) {
  try {
    const scoped = storage.getItem(environmentStorageKey(base, environmentId));
    if (scoped !== null) return scoped;
    return normalizeEnvironmentId(environmentId) === DEFAULT_ENVIRONMENT_ID
      ? storage.getItem(base) : null;
  } catch {
    return null;
  }
}

export function storeEnvironmentValue(
  base: string,
  environmentId: string,
  value: string,
  storage: StorageWriter = localStorage,
) {
  try { storage.setItem(environmentStorageKey(base, environmentId), value); } catch { /* keep in memory */ }
}
