import { useEffect, useRef, useState } from 'react';
import { friendlyError } from './app-utils';
import { t } from './i18n';
export type MessageEditPlan = { threadId: string; turnId: string; text: string; token: string };
export function MessageEditDialog({ originalText, onPrepare, onSubmit, onClose }: {
  originalText: string; onPrepare: () => Promise<MessageEditPlan>;
  onSubmit: (plan: MessageEditPlan, text: string) => Promise<void>; onClose: () => void;
}) {
  const [text, setText] = useState(originalText);
  const [plan, setPlan] = useState<MessageEditPlan | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    void onPrepare().then(value => {
      if (disposed) return;
      if (value.text.trim() !== originalText.trim()) { setError(friendlyError('message_edit_changed')); return; }
      setPlan(value);
    }).catch(cause => { if (!disposed) setError(friendlyError(cause)); });
    return () => { disposed = true; };
  }, [onPrepare, originalText]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending.current) onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const submit = async () => {
    if (pending.current || attempted || !plan || !text.trim()) return;
    pending.current = true; setSaving(true); setAttempted(true); setError('');
    try { await onSubmit(plan, text.trim()); }
    catch (cause) { setError(friendlyError(cause)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <div className="new-session-overlay" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !pending.current) onClose();
  }}>
    <section className="new-session-dialog message-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="message-edit-title">
      <header className="new-session-dialog-head"><h2 id="message-edit-title">{t('修改并重新发送', 'Edit and resend')}</h2></header>
      <div className="new-session-dialog-body">
        <textarea autoFocus aria-label={t('修改消息', 'Edit message')} value={text} maxLength={100000}
          disabled={saving} onChange={event => setText(event.target.value)} />
        <p className="archive-dialog-hint">{t('将撤回原消息及后续对话，再发送修改后的内容。原附件会保留，已执行的文件修改和外部操作不会撤销。',
          'This removes the original message and later conversation, then sends the edited content. Original attachments remain. File changes and external actions are not undone.')}</p>
        {!plan && !error && <p role="status">{t('正在核对消息…', 'Checking message…')}</p>}
        {error && <p className="new-session-error" role="alert">{error}</p>}
        {attempted && error && <p className="archive-dialog-hint">{t('请先关闭并核对最新记录，再决定是否重新编辑。', 'Close and check the latest history before editing again.')}</p>}
      </div>
      <footer className="new-session-dialog-actions">
        <button type="button" disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</button>
        <button type="button" disabled={saving || attempted || !plan || !text.trim()} onClick={() => void submit()}>
          {saving ? t('正在重发…', 'Resending…') : t('撤回并重发', 'Revert and resend')}
        </button>
      </footer>
    </section>
  </div>;
}
