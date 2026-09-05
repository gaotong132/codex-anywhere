import { useEffect, useState } from 'react';
import { t } from './i18n';
import './browser-session-status.css';

type Status = { authorized: boolean; online: boolean; origin?: string; pageCount?: number; onlinePageCount?: number; lastToolSuccessAt?: number | null };
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
  const count = status.pageCount ?? 1;
  const toolState = status.lastToolSuccessAt
    ? `${t('最近工具调用成功', 'Last successful tool call')}: ${new Date(status.lastToolSuccessAt).toLocaleTimeString()}`
    : t('MCP 工具尚未验证；页面在线不代表工具已加载', 'MCP tools not yet verified; page connectivity does not confirm tool availability');
  return <span className="browser-session-status" title={`${status.origin || ''} · ${toolState} · ${t('在扩展中撤销起始页及子页', 'Revoke the root and child tabs in the extension')}`}>
    {status.online ? t(`浏览器已授权${count > 1 ? ` · ${count - 1} 子页` : ''}`, `Browser authorized${count > 1 ? ` · ${count - 1} child tabs` : ''}`) : t('浏览器离线', 'Browser offline')}
  </span>;
}
