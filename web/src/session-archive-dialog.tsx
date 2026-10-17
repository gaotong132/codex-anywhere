import { useEffect, useRef, useState } from 'react';
import { friendlyError } from './app-utils';
import { t } from './i18n';
import { SessionNoticeIcon } from './session-notices';

export function SessionArchiveDialog({ title, cancelPendingApproval = false, onClose, onArchive }: {
  title: string; cancelPendingApproval?: boolean; onClose: () => void; onArchive: () => Promise<void>;
}) {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending.current) onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  return (
    <div className="new-session-overlay archive-dialog-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending.current) onClose();
    }}>
      <form className="new-session-dialog archive-session-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-session-title" aria-describedby="archive-session-description"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current) return;
          pending.current = true; setSaving(true); setError('');
          try { await onArchive(); onClose(); }
          catch (cause) { setError(friendlyError(cause)); }
          finally { pending.current = false; setSaving(false); }
        }}>
        <header className="new-session-dialog-head">
          <span className="archive-dialog-icon"><SessionNoticeIcon kind="archive" /></span>
          <h2 id="archive-session-title">{cancelPendingApproval ? t('停止等待并归档？', 'Stop waiting and archive?') : t('归档会话？', 'Archive session?')}</h2>
        </header>
        <div className="new-session-dialog-body">
          <p className="archive-dialog-session" title={title}><span>{title}</span></p>
          <div id="archive-session-description">
            <p>{t('会话将移出列表，聊天记录和项目文件保留。', 'Remove this session from the list and keep its history and project files.')}</p>
            {cancelPendingApproval && <p className="archive-dialog-caution">{t('这会结束当前等待，不会批准或执行待批准的操作。', 'This ends the wait without approving or executing the pending action.')}</p>}
            <p className="archive-dialog-hint">{t('归档后可恢复并打开，也可在 Codex 的已归档列表中恢复。', 'Restore and open after archiving, or use archived chats in Codex.')}</p>
          </div>
          {error && <p className="new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="new-session-dialog-actions">
          <button type="button" autoFocus disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</button>
          <button type="submit" className="primary-action" disabled={saving}>{saving ? t('归档中…', 'Archiving…') : cancelPendingApproval ? t('停止等待并归档', 'Stop waiting and archive') : t('归档', 'Archive')}</button>
        </footer>
      </form>
    </div>
  );
}
