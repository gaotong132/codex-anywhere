import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import webPush, { type PushSubscription } from 'web-push';

const MAX_PUSH_SUBSCRIPTIONS = 64;
const PUSH_TTL_SECONDS = 5 * 60;

export type PushNotificationKind = 'completed' | 'approval';
export type PushDevice = { id: string; publicKey: string };
export type PushNotifier = {
  readonly publicKey: string;
  subscribe(device: PushDevice, subscription: unknown): boolean;
  unsubscribe(device: PushDevice): boolean;
  notify(kind: PushNotificationKind, onlineDeviceIds?: ReadonlySet<string>): Promise<void>;
};

type StoredPushSubscription = {
  device: PushDevice;
  subscription: PushSubscription;
  createdAt: number;
};

type PushState = { version: 1; subscriptions: StoredPushSubscription[] };

type PushNotificationServiceOptions = {
  publicKey?: unknown;
  privateKey?: unknown;
  subject?: unknown;
  filePath?: string | null;
  isApproved: (device: PushDevice) => boolean;
  sendNotification?: typeof webPush.sendNotification;
};

export class PushNotificationService implements PushNotifier {
  readonly publicKey: string;
  private readonly filePath: string | null;
  private readonly privateKey: string;
  private readonly subject: string;
  private readonly isApproved: (device: PushDevice) => boolean;
  private readonly sendNotification: typeof webPush.sendNotification;
  private state: PushState = { version: 1, subscriptions: [] };

  constructor(options: PushNotificationServiceOptions) {
    this.publicKey = String(options.publicKey || '').trim();
    this.privateKey = String(options.privateKey || '').trim();
    this.subject = String(options.subject || '').trim();
    const configured = [this.publicKey, this.privateKey, this.subject].filter(Boolean).length;
    if (configured !== 0 && configured !== 3) throw new Error('web_push_configuration_incomplete');
    this.filePath = this.publicKey && options.filePath?.trim() ? resolve(options.filePath) : null;
    this.isApproved = options.isApproved;
    this.sendNotification = options.sendNotification || webPush.sendNotification;
    if (this.publicKey) {
      webPush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
      this.refresh(true);
    }
  }

  subscribe(device: PushDevice, value: unknown) {
    if (!this.publicKey || !this.filePath) return false;
    const subscription = normalizeSubscription(value);
    this.refresh();
    this.state.subscriptions = this.state.subscriptions.filter((entry) => entry.device.id !== device.id);
    this.state.subscriptions.push({ device: { ...device }, subscription, createdAt: Date.now() });
    if (this.state.subscriptions.length > MAX_PUSH_SUBSCRIPTIONS) {
      this.state.subscriptions.sort((left, right) => right.createdAt - left.createdAt);
      this.state.subscriptions.length = MAX_PUSH_SUBSCRIPTIONS;
    }
    this.persist();
    return true;
  }

  unsubscribe(device: PushDevice) {
    if (!this.filePath) return false;
    this.refresh();
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((entry) => entry.device.id !== device.id);
    if (before === this.state.subscriptions.length) return false;
    this.persist();
    return true;
  }

  async notify(kind: PushNotificationKind, onlineDeviceIds: ReadonlySet<string> = new Set()) {
    if (!this.publicKey || !this.filePath) return;
    this.refresh();
    let changed = false;
    const active = this.state.subscriptions.filter((entry) => {
      const approved = this.isApproved(entry.device);
      if (!approved) changed = true;
      return approved;
    });
    this.state.subscriptions = active;
    for (const entry of active) {
      if (onlineDeviceIds.has(entry.device.id)) continue;
      try {
        await this.sendNotification(entry.subscription, JSON.stringify({ kind }), {
          TTL: PUSH_TTL_SECONDS,
          urgency: kind === 'approval' ? 'high' : 'normal',
          topic: `codex-anywhere-${kind}`,
        });
      } catch (error) {
        const statusCode = Number((error as { statusCode?: unknown })?.statusCode);
        if (statusCode === 404 || statusCode === 410) {
          this.state.subscriptions = this.state.subscriptions.filter((candidate) => candidate !== entry);
          changed = true;
        }
      }
    }
    if (changed) this.persist();
  }

  private refresh(required = false) {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) {
      if (required) this.persist();
      return;
    }
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PushState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.subscriptions)) {
      throw new Error('push_subscription_registry_invalid');
    }
    this.state = {
      version: 1,
      subscriptions: parsed.subscriptions.filter(isStoredSubscription).slice(-MAX_PUSH_SUBSCRIPTIONS),
    };
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

function normalizeSubscription(value: unknown): PushSubscription {
  if (!value || typeof value !== 'object') throw new Error('invalid_push_subscription');
  const raw = value as { endpoint?: unknown; expirationTime?: unknown; keys?: Record<string, unknown> };
  const endpoint = String(raw.endpoint || '').trim();
  let parsedEndpoint;
  try { parsedEndpoint = new URL(endpoint); } catch { throw new Error('invalid_push_subscription'); }
  const p256dh = String(raw.keys?.p256dh || '');
  const auth = String(raw.keys?.auth || '');
  if (parsedEndpoint.protocol !== 'https:' || endpoint.length > 2_048
    || !validKey(p256dh, 20, 512) || !validKey(auth, 8, 256)) {
    throw new Error('invalid_push_subscription');
  }
  const expirationTime = raw.expirationTime == null ? null : Number(raw.expirationTime);
  if (expirationTime != null && !Number.isFinite(expirationTime)) throw new Error('invalid_push_subscription');
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

function validKey(value: string, minimum: number, maximum: number) {
  return value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

function isStoredSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredPushSubscription>;
  if (!entry.device?.id || !entry.device.publicKey || !Number.isFinite(entry.createdAt)) return false;
  try {
    normalizeSubscription(entry.subscription);
    return true;
  } catch {
    return false;
  }
}
