import {
  chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RolloutModelSettings } from './rollout-tail.js';

const DOCUMENT_VERSION = 1;
const MAX_STORED_SESSIONS = 1_000;
const MAX_SETTING_LENGTH = 160;

type StoredDocument = {
  version: number;
  sessions: Record<string, RolloutModelSettings>;
};

export function connectorSessionModelSettingsPath(
  deviceId: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(environment.BRIDGE_SESSION_MODEL_SETTINGS_FILE || '').trim();
  if (configured) return resolve(configured);
  const safeDeviceId = String(deviceId || 'connector').replace(/[^a-z0-9._-]/gi, '-').slice(0, 80);
  return join(homedir(), '.codex-anywhere', `connector-${safeDeviceId}-model-settings.json`);
}

export function loadSessionModelSettings(filePath?: string | null) {
  const settings = new Map<string, RolloutModelSettings>();
  if (!filePath) return settings;
  try {
    const document = JSON.parse(readFileSync(resolve(filePath), 'utf8')) as Partial<StoredDocument>;
    if (document.version !== DOCUMENT_VERSION || !document.sessions || typeof document.sessions !== 'object') {
      return settings;
    }
    for (const [threadId, candidate] of Object.entries(document.sessions).slice(-MAX_STORED_SESSIONS)) {
      const normalized = normalizeSettings(candidate);
      if (validThreadId(threadId) && normalized) settings.set(threadId, normalized);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return settings;
  }
  return settings;
}

export function saveSessionModelSettings(
  filePath: string | null | undefined,
  settings: Map<string, RolloutModelSettings>,
) {
  if (!filePath) return;
  const target = resolve(filePath);
  const sessions = Object.fromEntries([...settings.entries()]
    .flatMap(([threadId, value]) => {
      const normalized = normalizeSettings(value);
      return validThreadId(threadId) && normalized ? [[threadId, normalized] as const] : [];
    })
    .slice(-MAX_STORED_SESSIONS));
  const document: StoredDocument = { version: DOCUMENT_VERSION, sessions };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  try { chmodSync(target, 0o600); } catch { /* Windows ACLs are inherited from the user state dir. */ }
}

function validThreadId(value: string) {
  return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeSettings(value: unknown): RolloutModelSettings | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as RolloutModelSettings;
  const model = normalizeValue(candidate.model);
  const reasoningEffort = normalizeValue(candidate.reasoningEffort);
  const serviceTier = normalizeValue(candidate.serviceTier);
  if (!model || !reasoningEffort) return null;
  return { model, reasoningEffort, ...(serviceTier ? { serviceTier } : {}) };
}

function normalizeValue(value: unknown) {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= MAX_SETTING_LENGTH ? normalized : '';
}
