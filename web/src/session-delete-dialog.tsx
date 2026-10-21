import { useEffect, useRef, useState } from 'react';
import { friendlyError } from './app-utils';
import { t } from './i18n';

export function SessionDeleteDialog({ title, onClose, onDelete }: {
  title: string; onClose: () => void; onDelete: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending.current) onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try { await onDelete(); }
    catch (cause) { setError(friendlyError(cause)); }
    finally { pending.current = false; setSaving(false); }
  };
  return (
    <div className="new-session-overlay archive-dialog-overlay" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !pending.current) onClose();
    }}>
      <section className="new-session-dialog archive-session-dialog" role="dialog" aria-modal="true"
        aria-labelledby="delete-session-title" aria-describedby="delete-session-warning">
        <header className="new-session-dialog-head">
          <span className="archive-dialog-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg></span>
          <h2 id="delete-session-title">{t('删除会话？', 'Delete session?')}</h2>
        </header>
        <div className="new-session-dialog-body">
          <p className="archive-dialog-session" title={title}><span>{title}</span></p>
          <div id="delete-session-warning">
            <p>{t('此操作将永久删除该会话的聊天记录，无法恢复。', 'This permanently deletes the session history and cannot be undone.')}</p>
            <p className="archive-dialog-hint">{t('项目目录和代码文件不会删除。', 'Project directories and code files will not be deleted.')}</p>
          </div>
          {error && <p className="new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="new-session-dialog-actions">
          <button type="button" autoFocus disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</button>
          <button type="button" className="delete-session-confirm" disabled={saving} onClick={() => void submit()}>
            {saving ? t('删除中…', 'Deleting…') : t('永久删除', 'Delete permanently')}
          </button>
        </footer>
      </section>
    </div>
  );
}
