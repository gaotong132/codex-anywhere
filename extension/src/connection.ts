import { createDeviceAuthProof, type DeviceIdentity } from '../../src/shared/device-auth.js';
import { browserPairingVerifier, createBrowserPairingProof, DEVICE_KEY_AUTH_CONTEXT, parseBrowserPairingCredential } from '../../src/shared/pairing-auth.js';
import { requireCurrentProtocol } from '../../src/shared/protocol-contract.js';
import { BrowserSecureChannel } from '../../web/src/secure-channel-client.js';

type Frame = Record<string, any>;
const deviceIds = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string' && Boolean(id)))] : [];
export function parseConnectionUrl(input: string) {
  const url = new URL(input.trim());
  // Keep plain WS hosts aligned with manifest CSP: IPv6 literal sources are invalid.
  if (url.username || url.password || url.search || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('browser_https_url_required');
  const pairing = url.hash ? parseBrowserPairingCredential(input) : undefined;
  return { origin: url.origin, socketUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws`, pairing };
}

export class ExtensionConnection {
  private socket?: WebSocket;
  private channel?: BrowserSecureChannel;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private cancelConnect?: () => void;
  private cancelSelect?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  devices: string[] = [];
  environmentId = '';
  online = false;
  constructor(private identity: DeviceIdentity, private event: (frame: Frame) => void, private changed: () => void) {}

  connect(input: string): Promise<string> {
    const parsed = parseConnectionUrl(input);
    this.close();
    const socket = new WebSocket(parsed.socketUrl);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); this.cancelConnect = undefined;
        if (error) reject(error); else resolve(parsed.origin);
      };
      const timer = setTimeout(() => { finish(new Error('browser_connect_timeout')); this.close(); }, 15_000);
      this.cancelConnect = () => finish(new Error('browser_connection_cancelled'));
      socket.onmessage = (incoming) => {
        if (this.socket !== socket) return;
        try {
          const frame = JSON.parse(String(incoming.data));
          if (frame.type === 'auth.challenge') {
            const protocol = requireCurrentProtocol(frame.protocol);
            const challenge = String(frame.challenge);
            const proof = parsed.pairing ? createBrowserPairingProof({ verifier: browserPairingVerifier(parsed.pairing.secret), challenge,
              pairingId: parsed.pairing.id, deviceId: this.identity.id, publicKey: this.identity.publicKey }) : DEVICE_KEY_AUTH_CONTEXT;
            const device = createDeviceAuthProof(this.identity, { challenge, role: 'client', authProof: proof }, 'Anywhere Browser Extension');
            socket.send(JSON.stringify(parsed.pairing
              ? { type: 'auth.enroll', role: 'client', pairingId: parsed.pairing.id, proof, device, protocol }
              : { type: 'auth.device', role: 'client', device, protocol }));
          } else if (frame.type === 'auth.ok') {
            if (this.online) return;
            this.online = true; this.devices = deviceIds(frame.devices);
            this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}'); }, 20_000);
            finish(); this.changed();
          } else if (frame.type === 'presence') {
            this.devices = deviceIds(frame.devices);
            if (this.environmentId && !this.devices.includes(this.environmentId)) {
              this.cancelSelect?.(); this.channel?.clear(); this.rejectPending();
            }
            this.changed();
          } else if (frame.type === 'auth.error' || frame.type === 'error') {
            finish(new Error('browser_pairing_failed')); this.close();
          } else this.channel?.handle(frame);
        } catch { finish(new Error('browser_connection_failed')); this.close(); }
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        finish(new Error('browser_connection_failed_check_extension_origin_and_proxy')); this.close();
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        finish(new Error('browser_disconnected')); this.close();
      };
    });
  }

  select(environmentId: string): Promise<void> {
    if (!this.online || !this.devices.includes(environmentId)) return Promise.reject(new Error('browser_environment_offline'));
    this.cancelSelect?.(); this.rejectPending(); this.channel?.clear(); this.environmentId = environmentId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { done(new Error('browser_channel_timeout')); channel.clear(); }, 10_000);
      const done = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancelSelect = undefined;
        if (error) reject(error); else resolve();
      };
      this.cancelSelect = () => done(new Error('browser_environment_changed'));
      const channel = new BrowserSecureChannel({ identity: this.identity, routeDeviceId: environmentId,
        send: (frame) => { if (this.socket?.readyState !== WebSocket.OPEN) return false; this.socket.send(JSON.stringify(frame)); return true; },
        onReady: () => { if (this.channel === channel) done(); },
        onError: () => {
          if (this.channel !== channel) return;
          done(new Error('browser_secure_channel_failed')); this.rejectPending(); this.changed();
        },
        onFrame: (frame) => {
          if (this.channel !== channel) return;
          if (frame.type === 'response') {
            const pending = this.pending.get(frame.requestId);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(frame.requestId);
            if (frame.ok) pending.resolve(frame.data); else pending.reject(new Error(String(frame.error || 'browser_request_failed')));
          } else if (frame.type === 'event') this.event(frame);
        },
      });
      this.channel = channel;
      try {
        if (!channel.start()) done(new Error('browser_secure_channel_failed'));
      } catch {
        channel.clear(); done(new Error('browser_secure_channel_failed'));
      }
    });
  }

  ready() { return this.online && Boolean(this.channel?.isReady()); }
  request(action: string, payload: Frame = {}): Promise<any> {
    if (!this.ready()) return Promise.reject(new Error('browser_connector_offline'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('browser_request_timeout')); }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        if (!this.channel!.sendFrame({ type: 'request', requestId, action, payload })) throw new Error('browser_connector_offline');
      } catch {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error('browser_connector_offline'));
      }
    });
  }
  close() {
    this.cancelConnect?.(); this.cancelSelect?.();
    const socket = this.socket; this.socket = undefined; socket?.close();
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.channel?.clear(); this.channel = undefined; this.online = false;
    this.devices = []; this.environmentId = '';
    this.rejectPending(); this.changed();
  }
  private rejectPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('browser_connection_changed')); }
    this.pending.clear();
  }
}
