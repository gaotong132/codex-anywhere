import { useEffect, useRef, useState } from 'react';
import { friendlyError } from './app-utils';
import { t } from './i18n';

export function SessionArchiveDialog({ title, onClose, onArchive }: {
  title: string; onClose: () => void; onArchive: () => Promise<void>;
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
    <div className="new-session-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending.current) onClose();
    }}>
      <form className="new-session-dialog rename-session-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-session-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current) return;
          pending.current = true; setSaving(true); setError('');
          try { await onArchive(); onClose(); }
          catch (cause) { setError(friendlyError(cause)); }
          finally { pending.current = false; setSaving(false); }
        }}>
        <header className="new-session-dialog-head">
          <p className="eyebrow">CODEX ANYWHERE</p>
          <h2 id="archive-session-title">{t('归档会话？', 'Archive session?')}</h2>
          <span>{title}</span>
        </header>
        <div className="new-session-dialog-body">
          <p>{t('会话将从列表移除，聊天记录和项目文件保留。可在 Codex 客户端的已归档会话中恢复。', 'The session leaves the list. Chat history and project files are retained. Restore it from archived chats in Codex Desktop.')}</p>
          {error && <p className="new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="new-session-dialog-actions">
          <button type="button" autoFocus disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</button>
          <button type="submit" className="primary-action" disabled={saving}>{saving ? t('归档中…', 'Archiving…') : t('归档', 'Archive')}</button>
        </footer>
      </form>
    </div>
  );
}
