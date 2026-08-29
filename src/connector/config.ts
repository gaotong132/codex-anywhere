import { delimiter } from 'node:path';
import { normalizeAuthDeviceId } from '../shared/auth.js';
import { normalizeBridgeUrl } from '../shared/protocol.js';

export type ConnectorConfig = {
  token: string;
  url: string;
  deviceId: string;
  codexBin: string;
  allowedRoots: string[];
  networkAccess: boolean;
  allowAnyFileDownload: boolean;
};

export function loadConnectorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): ConnectorConfig {
  const token = String(environment.BRIDGE_CONNECTOR_TOKEN || '');
  if (token.length < 32) {
    throw new Error('BRIDGE_CONNECTOR_TOKEN must contain at least 32 characters');
  }

  const configuredAllowedRoots = String(environment.CODEX_ALLOWED_ROOTS || '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    token,
    url: normalizeBridgeUrl(environment.BRIDGE_URL || 'ws://127.0.0.1:3300/ws'),
    deviceId: normalizeAuthDeviceId(environment.BRIDGE_DEVICE_ID),
    codexBin: String(environment.CODEX_BIN || 'codex').trim() || 'codex',
    allowedRoots: configuredAllowedRoots.length ? configuredAllowedRoots : [workingDirectory],
    networkAccess: environment.CODEX_NETWORK_ACCESS === '1',
    allowAnyFileDownload: environment.CODEX_ALLOW_ANY_FILE_DOWNLOAD === '1',
  };
}
