import { FormEvent, useEffect, useState } from 'react';
import { MAX_SESSION_NAME_LENGTH } from '../../src/shared/session-name';
import { friendlyError } from './app-utils';
import { t } from './i18n';

type SessionRenameDialogProps = {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
};

export function SessionRenameDialog({
  open, initialName, onClose, onRename,
}: SessionRenameDialogProps) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setError('');
  }, [initialName, open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open, saving]);

  if (!open) return null;
  const nameLength = Array.from(name).length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || saving) return;
    setSaving(true);
    setError('');
    try {
      await onRename(nextName);
      onClose();
    } catch (renameError) {
      setError(friendlyError(renameError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="new-session-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form className="new-session-dialog rename-session-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-session-title" onSubmit={submit}>
        <header className="new-session-dialog-head">
          <p className="eyebrow">CODEX ANYWHERE</p>
          <h2 id="rename-session-title">{t('修改会话名称', 'Rename session')}</h2>
          <span>{t('名称会同步到当前执行环境中的原会话。', 'The name is synced to the original task in the current execution environment.')}</span>
        </header>
        <div className="new-session-dialog-body">
          <label className="new-session-field" htmlFor="rename-session-name">
            <span>{t('会话名称', 'Session name')}</span>
            <input
              id="rename-session-name"
              autoFocus
              autoComplete="off"
              maxLength={MAX_SESSION_NAME_LENGTH * 2}
              disabled={saving}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </label>
          <small className={`session-name-limit${nameLength > MAX_SESSION_NAME_LENGTH ? ' invalid' : ''}`}>{nameLength}/{MAX_SESSION_NAME_LENGTH}</small>
          {error && <p className="new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="new-session-dialog-actions">
          <button type="button" disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</button>
          <button className="primary-action" type="submit" disabled={saving || !name.trim() || nameLength > MAX_SESSION_NAME_LENGTH}>
            {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
          </button>
        </footer>
      </form>
    </div>
  );
}
