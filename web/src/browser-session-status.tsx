import { useEffect, useState } from 'react';
import { t } from './i18n';
import './browser-session-status.css';

type Status = { authorized: boolean; online: boolean; origin?: string };
export function BrowserSessionStatus({ environmentId, threadId, online, request }: {
  environmentId: string; threadId: string | null; online: boolean;
  request<T>(action: string, payload: Record<string, unknown>): Promise<T>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let active = true;
    let pending = false;
    setStatus(null);
    if (!online || !threadId) return;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const result = await request<Status>('browser.status', { threadId }); if (active) setStatus(result); }
      catch { if (active) setStatus(null); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [environmentId, threadId, online, request]);
  if (!status?.authorized) return null;
  return <span className="browser-session-status" title={`${status.origin || ''} · ${t('在扩展中撤销或更换授权', 'Revoke or change authorization in the extension')}`}>
    {status.online ? t('浏览器已连接', 'Browser connected') : t('浏览器离线', 'Browser offline')}
  </span>;
}
