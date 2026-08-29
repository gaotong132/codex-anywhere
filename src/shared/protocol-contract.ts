export const BRIDGE_PROTOCOL_VERSION = 4;

export const BRIDGE_PROTOCOL_CAPABILITIES = Object.freeze([
  'strict-protocol.v1',
  'device-auth.v1',
  'device-key-auth.v1',
  'browser-pairing.v1',
  'e2ee-channel.v1',
  'request-routing.v1',
  'history-pagination.v1',
  'approval.v1',
  'attachment-image.v1',
  'visualization-preview.v1',
  'file-download.v1',
]);

export type ProtocolOffer = {
  version: number;
  capabilities: string[];
};

export type CurrentProtocol = {
  version: number;
  capabilities: string[];
};

export function createProtocolOffer(
  capabilities: readonly string[] = BRIDGE_PROTOCOL_CAPABILITIES,
): ProtocolOffer {
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    capabilities: normalizeCapabilities(capabilities),
  };
}

export function requireCurrentProtocol(remote: unknown): CurrentProtocol {
  const remoteOffer = normalizeProtocolOffer(remote);
  if (remoteOffer.version !== BRIDGE_PROTOCOL_VERSION) throw new Error('protocol_version_unsupported');
  const remoteCapabilities = new Set(remoteOffer.capabilities);
  if (BRIDGE_PROTOCOL_CAPABILITIES.some((capability) => !remoteCapabilities.has(capability))) {
    throw new Error('protocol_capability_required');
  }
  return createProtocolOffer();
}

function normalizeProtocolOffer(value: unknown): ProtocolOffer {
  if (!value || typeof value !== 'object') throw new Error('protocol_offer_required');
  const candidate = value as Partial<ProtocolOffer>;
  const version = positiveInteger(candidate.version);
  if (!version) throw new Error('protocol_offer_invalid');
  return {
    version,
    capabilities: normalizeCapabilities(candidate.capabilities),
  };
}

function normalizeCapabilities(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((capability): capability is string => typeof capability === 'string')
    .map((capability) => capability.trim())
    .filter((capability) => /^[a-z0-9][a-z0-9.-]{0,63}$/.test(capability)))]
    .sort();
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
