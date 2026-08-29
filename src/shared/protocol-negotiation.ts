export const BRIDGE_PROTOCOL_VERSION = 2;
export const BRIDGE_MIN_PROTOCOL_VERSION = 1;

export const BRIDGE_PROTOCOL_CAPABILITIES = Object.freeze([
  'protocol-negotiation.v1',
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
  minimumVersion: number;
  capabilities: string[];
};

export type NegotiatedProtocol = {
  version: number;
  capabilities: string[];
};

export function createProtocolOffer(
  capabilities: readonly string[] = BRIDGE_PROTOCOL_CAPABILITIES,
): ProtocolOffer {
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    minimumVersion: BRIDGE_MIN_PROTOCOL_VERSION,
    capabilities: normalizeCapabilities(capabilities),
  };
}

export function legacyProtocolOffer(version: unknown = 1): ProtocolOffer {
  return {
    version: positiveInteger(version) || 1,
    minimumVersion: 1,
    capabilities: [],
  };
}

export function negotiateProtocol(
  remote: unknown,
  local: ProtocolOffer = createProtocolOffer(),
): NegotiatedProtocol {
  const remoteOffer = normalizeProtocolOffer(remote);
  const localOffer = normalizeProtocolOffer(local);
  const version = Math.min(localOffer.version, remoteOffer.version);
  if (version < Math.max(localOffer.minimumVersion, remoteOffer.minimumVersion)) {
    throw new Error('protocol_version_unsupported');
  }
  const remoteCapabilities = new Set(remoteOffer.capabilities);
  return {
    version,
    capabilities: localOffer.capabilities.filter((capability) => remoteCapabilities.has(capability)),
  };
}

export function protocolHasCapability(protocol: NegotiatedProtocol, capability: string) {
  return protocol.capabilities.includes(capability);
}

function normalizeProtocolOffer(value: unknown): ProtocolOffer {
  if (!value || typeof value !== 'object') return legacyProtocolOffer();
  const candidate = value as Partial<ProtocolOffer>;
  const version = positiveInteger(candidate.version);
  const minimumVersion = positiveInteger(candidate.minimumVersion) || 1;
  if (!version || minimumVersion > version) throw new Error('protocol_offer_invalid');
  return {
    version,
    minimumVersion,
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
