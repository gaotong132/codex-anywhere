import { CustomSelect } from './ui-components';
import { environmentDisplayName, environmentShortName } from './execution-environments';
import { t } from './i18n';

export function EnvironmentSwitcher({ value, environmentIds, onlineEnvironmentIds, onChange }: {
  value: string; environmentIds: string[]; onlineEnvironmentIds: string[]; onChange: (id: string) => void;
}) {
  const online = onlineEnvironmentIds.includes(value);
  const options = environmentIds.map(id => ({
    value: id, label: environmentDisplayName(id),
    description: onlineEnvironmentIds.includes(id) ? t('在线', 'Online') : t('离线', 'Offline'),
    leading: <span className={`environment-status-dot ${onlineEnvironmentIds.includes(id) ? 'online' : 'offline'}`} aria-hidden="true" />,
  }));
  // Keep a stable visual position while connectivity and selection change.
  const shortcuts = [...environmentIds].sort((a, b) =>
    Number(b === 'personal-pc') - Number(a === 'personal-pc') || a.localeCompare(b));
  return <div className={`environment-picker${environmentIds.length <= 2 ? ' environment-picker-direct' : ''}`}>
    <span className="environment-picker-label">{t('执行环境', 'Execution environment')}</span>
    {environmentIds.length <= 2 ? <div className="environment-shortcuts" role="group" aria-label={t('切换执行环境', 'Switch execution environment')}>
      {shortcuts.map(id => {
        const available = onlineEnvironmentIds.includes(id);
        const status = available ? t('在线', 'Online') : t('离线', 'Offline');
        return <button type="button" key={id} className="environment-shortcut" aria-pressed={value === id}
          title={`${environmentDisplayName(id)} · ${status}`}
          onClick={() => { if (id !== value) onChange(id); }}>
          <strong>{environmentShortName(id)}</strong>
          <span className="environment-shortcut-status"><span className={`environment-status-dot ${available ? 'online' : 'offline'}`} aria-hidden="true" />{status}</span>
        </button>;
      })}
    </div> : <CustomSelect className="environment-picker-select" value={value} options={options} onChange={onChange}
      ariaLabel={t('切换执行环境', 'Switch execution environment')}
      triggerContent={<>
        <span className={`environment-status-dot ${online ? 'online' : 'offline'}`} aria-hidden="true" />
        <strong>{environmentDisplayName(value)}</strong>
        <small>{online ? t('在线', 'Online') : t('离线', 'Offline')}</small>
      </>} />}
  </div>;
}
