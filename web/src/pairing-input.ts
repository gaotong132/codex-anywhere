import { t } from './i18n';

export const PENDING_PAIRING_KEY = 'bridge.pendingPairing.v1';
export const PAIRING_TIMEOUT_MS = 15_000;

type PairingLocation = Pick<Location, 'hash' | 'pathname' | 'search'>;
type PairingHistory = Pick<History, 'state' | 'replaceState'>;

// Called before React renders (and again on hashchange), never from a state
// initializer that StrictMode can replay. The fragment never reaches the relay.
export function takePairingInput(
  location: PairingLocation,
  history: PairingHistory,
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
): string | null {
  const values = new URLSearchParams(location.hash.replace(/^#/, ''));
  let input: string | null = values.has('pair') ? values.get('pair') || '' : null;
  if (input !== null) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  } else {
    try { input = storage?.getItem(PENDING_PAIRING_KEY) || null; } catch { /* blocked store */ }
  }
  // Recover older pending codes into the editable form once, not an automatic
  // reconnect loop. New attempts keep one-time credentials only in memory.
  try { storage?.removeItem(PENDING_PAIRING_KEY); } catch { /* blocked store */ }
  return input;
}

export function pairingFailureMessage(code: number): string {
  if (code === 4003) return t('配对码无效、已使用或已过期，请检查后重新输入。', 'The pairing code is invalid, used, or expired. Check it and try again.');
  if (code === 4429) return t('配对尝试过多，请 15 分钟后使用新的配对链接重试。', 'Too many pairing attempts. Wait 15 minutes and retry with a new link.');
  if (code === 4406) return t('连接协议已更新，请刷新页面后重新配对。', 'The connection protocol changed. Refresh the page and pair again.');
  if (code === 4407) return t('设备身份验证失败，请重新配对。', 'Device identity verification failed. Pair again.');
  if (code === 4001) return t('配对超时，请检查网络后重试。', 'Pairing timed out. Check your network and retry.');
  return t('配对连接中断，请检查网络或配对链接后重试。', 'The pairing connection was interrupted. Check your network or link and retry.');
}
