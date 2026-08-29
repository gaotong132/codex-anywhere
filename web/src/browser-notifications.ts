export type BrowserNotificationKind = 'completed' | 'approval';

const ENABLED_KEY = 'codex-anywhere.notifications.enabled';
const SERVICE_WORKER_URL = '/service-worker.js';

type PushRegistrationFrame = {
  type: 'push.subscribe' | 'push.unsubscribe';
  subscription?: PushSubscriptionJSON;
};

export function browserNotificationCopy(kind: BrowserNotificationKind, language: string) {
  const chinese = language.toLowerCase().startsWith('zh');
  if (kind === 'approval') {
    return chinese
      ? { title: 'Codex Anywhere', body: '有一项操作等待你的批准。' }
      : { title: 'Codex Anywhere', body: 'An action is waiting for your approval.' };
  }
  return chinese
    ? { title: 'Codex Anywhere', body: 'Codex 已完成当前任务。' }
    : { title: 'Codex Anywhere', body: 'Codex has finished the current task.' };
}

export function browserNotificationsSupported() {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator;
}

export function browserNotificationsEnabled() {
  if (!browserNotificationsSupported()) return false;
  try {
    return localStorage.getItem(ENABLED_KEY) === 'true' && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

async function registerNotificationWorker() {
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
}

function pushPublicKey() {
  return window.__CODEX_ANYWHERE_CONFIG__?.pushPublicKey?.trim() || '';
}

function decodeApplicationServerKey(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

async function ensurePushSubscription(registration: ServiceWorkerRegistration) {
  const publicKey = pushPublicKey();
  if (!publicKey || !registration.pushManager) return null;
  return await registration.pushManager.getSubscription() || registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeApplicationServerKey(publicKey),
  });
}

export async function restoreBrowserNotifications() {
  if (!browserNotificationsEnabled()) return false;
  await registerNotificationWorker();
  return true;
}

export async function setBrowserNotificationsEnabled(enabled: boolean) {
  if (!browserNotificationsSupported()) return false;
  if (!enabled) {
    try { localStorage.removeItem(ENABLED_KEY); } catch { /* blocked storage */ }
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager?.getSubscription();
    await subscription?.unsubscribe();
    return false;
  }

  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const registration = await registerNotificationWorker();
  try { await ensurePushSubscription(registration); } catch { /* local notifications still work */ }
  try { localStorage.setItem(ENABLED_KEY, 'true'); } catch { /* blocked storage */ }
  return true;
}

export async function syncBrowserPushSubscription(send: (frame: PushRegistrationFrame) => void) {
  if (!browserNotificationsSupported()) return;
  if (!browserNotificationsEnabled() || !pushPublicKey()) {
    send({ type: 'push.unsubscribe' });
    return;
  }
  const registration = await registerNotificationWorker();
  const subscription = await ensurePushSubscription(registration);
  if (subscription) send({ type: 'push.subscribe', subscription: subscription.toJSON() });
}

export async function notifyWhenHidden(kind: BrowserNotificationKind) {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return false;
  if (!browserNotificationsEnabled()) return false;
  const registration = await navigator.serviceWorker.getRegistration('/') || await registerNotificationWorker();
  const copy = browserNotificationCopy(kind, document.documentElement.lang || navigator.language || 'en');
  await registration.showNotification(copy.title, {
    body: copy.body,
    tag: `codex-anywhere-${kind}`,
  });
  return true;
}
