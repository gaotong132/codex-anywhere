import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { friendlyError } from './app-utils';
import type { PermissionMode } from '../../src/shared/permission-mode';
import type { SessionPermissionConfig } from './app-types';

const OPTIONS: Array<{ mode: PermissionMode; label: [string, string]; description: [string, string] }> = [
  {
    mode: 'ask',
    label: ['请求批准', 'Ask for approval'],
    description: ['编辑外部文件或访问网络等操作由你确认', 'You confirm actions such as external writes or network access'],
  },
  {
    mode: 'auto',
    label: ['帮我批准', 'Auto review'],
    description: ['由 Codex 审查操作，只把检测到的风险交给你', 'Codex reviews actions and escalates detected risks to you'],
  },
  {
    mode: 'full',
    label: ['完全访问权限', 'Full access'],
    description: ['不再请求批准，可访问此执行环境上的任意文件和网络', 'No approval prompts; unrestricted file and network access on this environment'],
  },
];

function permissionModeLabel(mode: PermissionMode) {
  const option = OPTIONS.find((candidate) => candidate.mode === mode) || OPTIONS[0];
  return t(...option.label);
}

export function PermissionModeControl({
  config, loading, disabled, onChange,
}: {
  config: SessionPermissionConfig | null;
  loading: boolean;
  disabled: boolean;
  onChange: (mode: PermissionMode) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(false);
    setError('');
  }, [config?.mode, config?.editable]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const choose = async (mode: PermissionMode) => {
    if (!config || saving || disabled || !config.editable || mode === config.mode) return;
    if (mode === 'full' && !config.allowFullAccess) return;
    if (mode === 'full' && !window.confirm(t(
      '完全访问会取消审批与沙箱限制，Codex 将能访问此执行环境上的所有文件和网络。确定继续吗？',
      'Full access removes approval and sandbox restrictions. Codex can access every file and the network on this environment. Continue?',
    ))) return;
    setSaving(true);
    setError('');
    try {
      await onChange(mode);
      setOpen(false);
    } catch (changeError) {
      setError(friendlyError(changeError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`permission-mode${open ? ' open' : ''}`} ref={rootRef}>
      <button
        className={`permission-mode-summary ${config?.mode || 'ask'}`}
        type="button"
        disabled={!config || loading}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={t('配置 Codex 的审批与文件访问权限', 'Configure Codex approvals and file access')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.6c0 3.7-2.5 6.3-6 7.9-3.5-1.6-6-4.2-6-7.9V5l6-2.5Z" /><path d="M7.4 10.1 9.2 12l3.6-4" /></svg>
        <span>{loading ? t('读取权限…', 'Loading access…') : permissionModeLabel(config?.mode || 'ask')}</span>
        <i aria-hidden="true" />
      </button>
      {open && config && (
        <div className="permission-mode-popover">
          <header>
            <strong>{t('应如何批准 Codex 操作？', 'How should Codex approve actions?')}</strong>
            <span>{config.editable
              ? t('设置同时作为此执行环境中新会话的默认值', 'Also becomes the default for new tasks in this environment')
              : t('此会话由电脑端管理，请在 Codex 电脑端修改', 'This task is managed by Codex Desktop; change it on the computer')}</span>
          </header>
          <div className="permission-mode-options">
            {OPTIONS.map((option) => {
              const unavailable = option.mode === 'full' && !config.allowFullAccess;
              return (
                <button
                  key={option.mode}
                  type="button"
                  className={`${option.mode}${config.mode === option.mode ? ' selected' : ''}`}
                  disabled={saving || disabled || !config.editable || unavailable}
                  onClick={() => void choose(option.mode)}
                >
                  <span className="permission-mode-option-icon" aria-hidden="true">{option.mode === 'ask' ? '✋' : option.mode === 'auto' ? '⌁' : '!'}</span>
                  <span><strong>{t(...option.label)}</strong><small>{t(...option.description)}</small>{unavailable && <em>{t('需在此执行节点显式开启', 'Must be enabled on this connector')}</em>}</span>
                  <i aria-hidden="true">{config.mode === option.mode ? '✓' : ''}</i>
                </button>
              );
            })}
          </div>
          {config.mode !== 'full' && !config.networkAccess && (
            <p className="permission-mode-note">{t('此执行节点未开放网络；批准后也不会授予网络访问。', 'Network access is disabled on this connector, even after approval.')}</p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
