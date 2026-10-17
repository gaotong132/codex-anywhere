import type { Approval } from './app-types';
import { t } from './i18n';

export function SessionNoticeIcon({ kind }: { kind: 'computer' | 'archive' | 'check' | 'refresh' | 'close' | 'shield' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'computer' && <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
    {kind === 'archive' && <><rect x="3" y="3" width="18" height="5" rx="1.5" /><path d="M5 8v12h14V8m-10 4h6" /></>}
    {kind === 'check' && <path d="m5 12 4 4L19 6" />}
    {kind === 'refresh' && <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" /></>}
    {kind === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
    {kind === 'shield' && <><path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6z" /><path d="M12 8v5m0 3h.01" /></>}
  </svg>;
}

export function ApprovalNotice({ approval, online, refreshing, error, onOpen, onRefresh, onArchive, onAnswer }: {
  approval: Approval; online: boolean; refreshing: boolean; error: string;
  onOpen: () => void; onRefresh: () => void; onArchive?: () => void; onAnswer: (approved: boolean) => void;
}) {
  const desktop = approval.actionable === false;
  return <section className={`session-notice approval-card${desktop ? ' desktop-approval' : ''}`} aria-live="polite">
    <div className="session-notice-head">
      <span className="session-notice-icon"><SessionNoticeIcon kind={desktop ? 'computer' : 'shield'} /></span>
      <div className="session-notice-copy">
        <strong>{desktop ? t('需要在电脑上批准', 'Approval on your computer') : t('需要你的批准', 'Your approval is required')}</strong>
        {desktop ? <p>{t('请在 Codex 电脑端处理此审批。', 'Review this request in Codex Desktop.')}</p>
          : <span className="session-notice-kind">{approval.kind}</span>}
      </div>
      {desktop && <button className="session-notice-icon-button" type="button" disabled={!online || refreshing}
        aria-label={t('刷新状态', 'Refresh status')} title={t('刷新状态', 'Refresh status')} aria-busy={refreshing} onClick={onRefresh}>
        <SessionNoticeIcon kind="refresh" />
      </button>}
    </div>
    {!desktop && <pre className="session-notice-summary" tabIndex={0} aria-label={t('待批准操作', 'Pending action')}>{approval.summary}</pre>}
    <div className="session-notice-actions">
      {desktop ? <>
        {onArchive && <button type="button" disabled={!online} onClick={onArchive}
          aria-label={t('停止等待并归档', 'Stop waiting and archive')} title={t('停止等待并归档', 'Stop waiting and archive')}>
          {t('结束等待…', 'End wait…')}
        </button>}
        <button className="notice-primary" type="button" disabled={!online} onClick={onOpen}>{t('在电脑端打开', 'Open on computer')}</button>
      </> : <>
        <button type="button" disabled={!online} onClick={() => onAnswer(false)}>{t('拒绝', 'Reject')}</button>
        <button className="notice-primary" type="button" disabled={!online} onClick={() => onAnswer(true)}>{t('批准一次', 'Approve once')}</button>
      </>}
    </div>
    {error && <p className="session-notice-error" role="status">{error}</p>}
  </section>;
}

export function ArchivedSessionNotice({ title, online, restoring, error, onRestore, onDismiss }: {
  title: string; online: boolean; restoring: boolean; error: string; onRestore?: () => void; onDismiss: () => void;
}) {
  return <section className="session-notice archived-notice" role="status">
    <div className="session-notice-head">
      <span className="session-notice-icon"><SessionNoticeIcon kind="check" /></span>
      <div className="session-notice-copy">
        <strong>{t('已归档，记录已保留', 'Archived · history kept')}</strong>
        <p className="archived-notice-title" title={title}>{title}</p>
      </div>
      {onRestore && <button className="notice-restore" type="button" disabled={!online || restoring} onClick={onRestore}
        aria-label={t('恢复并打开', 'Restore and open')} aria-busy={restoring}>
        {restoring ? t('恢复中…', 'Restoring…') : t('恢复', 'Restore')}
      </button>}
      <button className="session-notice-icon-button" type="button" disabled={restoring} onClick={onDismiss}
        aria-label={t('关闭', 'Dismiss')} title={t('关闭', 'Dismiss')}><SessionNoticeIcon kind="close" /></button>
    </div>
    {error && <p className="session-notice-error" role="alert">{error}</p>}
  </section>;
}
