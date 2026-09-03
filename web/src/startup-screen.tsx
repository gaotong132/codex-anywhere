import { t } from './i18n';

export function StartupScreen({ status }: { status: string }) {
  return (
    <main className="startup-shell" aria-busy="true" aria-live="polite">
      <div className="startup-visual" aria-hidden="true">
        <div className="startup-orbit"><i /><i /><i /></div>
        <div className="startup-mark"><span>C</span><i /></div>
      </div>
      <div className="startup-copy">
        <strong>CODEX ANYWHERE</strong>
        <span>{status || t('正在恢复上次会话…', 'Restoring your last session…')}</span>
        <div className="startup-pulse" aria-hidden="true"><i /><i /><i /></div>
      </div>
    </main>
  );
}
