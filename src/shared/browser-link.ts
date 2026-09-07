import type { DevicePublicIdentity } from './device-auth.js';

export const BROWSER_LINK_REQUEST = 'anywhere.sidepanel.link.request';
export const BROWSER_LINK_RESPONSE = 'anywhere.sidepanel.link.response';
export type BrowserLinkRequest = {
  requestId: string;
  challenge: string;
  extensionOrigin: string;
  device: DevicePublicIdentity;
};

// A sponsor signs only this domain-separated, target-bound transcript. Its
// private key never leaves Web storage and the proof cannot authenticate Web.
export function browserLinkContext(extensionOrigin: string, device: DevicePublicIdentity) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)
    || !device || !/^[a-f0-9]{64}$/.test(device.id) || !/^[a-f0-9]{64}$/.test(device.publicKey)) {
    throw new Error('invalid_browser_link');
  }
  return ['codex-anywhere-browser-link-v1', extensionOrigin, device.id, device.publicKey].join('\n');
}

export function parseBrowserLinkRequest(value: unknown): BrowserLinkRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as BrowserLinkRequest;
  if (!/^[a-f0-9-]{32,36}$/.test(v.requestId) || !/^[a-f0-9]{64}$/.test(v.challenge)) return null;
  try { browserLinkContext(v.extensionOrigin, v.device); } catch { return null; }
  return { requestId: v.requestId, challenge: v.challenge, extensionOrigin: v.extensionOrigin,
    device: { id: v.device.id, publicKey: v.device.publicKey } };
}
