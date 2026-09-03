import { delimiter } from 'node:path';
import { normalizeAuthDeviceId } from '../shared/auth.js';
import { normalizeBridgeUrl } from '../shared/protocol.js';

export type ConnectorConfig = {
  token: string;
  url: string;
  deviceId: string;
  deviceLabel: string;
  mode: 'desktop' | 'headless';
  codexBin: string;
  allowedRoots: string[];
  networkAccess: boolean;
  allowAnyFileDownload: boolean;
};

export function loadConnectorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
  platform = process.platform,
): ConnectorConfig {
  const token = String(environment.BRIDGE_CONNECTOR_TOKEN || '');
  if (token.length < 32) {
    throw new Error('BRIDGE_CONNECTOR_TOKEN must contain at least 32 characters');
  }

  const configuredAllowedRoots = String(environment.CODEX_ALLOWED_ROOTS || '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  const deviceId = normalizeAuthDeviceId(environment.BRIDGE_DEVICE_ID);
  const deviceLabel = String(environment.BRIDGE_DEVICE_LABEL || deviceId)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 80) || deviceId;
  const configuredMode = String(environment.CODEX_CONNECTOR_MODE || '').trim().toLowerCase();
  if (configuredMode && configuredMode !== 'desktop' && configuredMode !== 'headless') {
    throw new Error('CODEX_CONNECTOR_MODE must be desktop or headless');
  }

  return {
    token,
    url: normalizeBridgeUrl(environment.BRIDGE_URL || 'ws://127.0.0.1:3300/ws'),
    deviceId,
    deviceLabel,
    mode: configuredMode === 'desktop' || configuredMode === 'headless'
      ? configuredMode : platform === 'win32' ? 'desktop' : 'headless',
    codexBin: String(environment.CODEX_BIN || 'codex').trim() || 'codex',
    allowedRoots: configuredAllowedRoots.length ? configuredAllowedRoots : [workingDirectory],
    networkAccess: environment.CODEX_NETWORK_ACCESS === '1',
    allowAnyFileDownload: environment.CODEX_ALLOW_ANY_FILE_DOWNLOAD === '1',
  };
}
