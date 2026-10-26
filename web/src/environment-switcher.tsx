import { useEffect, useState } from 'react';
import { CustomSelect, SidebarIcon } from './ui-components';
import { environmentDisplayName, environmentShortName, type EnvironmentLabels } from './execution-environments';
import { t } from './i18n';

export function EnvironmentSwitcher({ value, environmentIds, onlineEnvironmentIds, onChange, labels = {}, onRename }: {
  value: string; environmentIds: string[]; onlineEnvironmentIds: string[]; onChange: (id: string) => void;
  labels?: EnvironmentLabels; onRename?: (id: string, label: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setEditing(false); setError(''); }, [value]);
  const displayName = (id: string) => environmentDisplayName(id, labels);
  const shortName = (id: string) => environmentShortName(id, labels);
  const online = onlineEnvironmentIds.includes(value);
  const [offlineExpanded, setOfflineExpanded] = useState(!online);
  useEffect(() => { setOfflineExpanded(!online); }, [value, online]);
  const options = environmentIds.map(id => ({
    value: id, label: displayName(id),
    description: `${onlineEnvironmentIds.includes(id) ? t('在线', 'Online') : t('离线', 'Offline')} · ${id}`,
    leading: <span className={`environment-status-dot ${onlineEnvironmentIds.includes(id) ? 'online' : 'offline'}`} aria-hidden="true" />,
  }));
  // Keep a stable visual position while connectivity and selection change.
  const sortedIds = [...environmentIds].sort((a, b) =>
    Number(b === 'personal-pc') - Number(a === 'personal-pc') || a.localeCompare(b));
  const onlineIds = sortedIds.filter(id => onlineEnvironmentIds.includes(id));
  const direct = onlineIds.length <= 2;
  // Small inventories keep their positions even when one device disconnects.
  const shortcuts = environmentIds.length <= 2 ? sortedIds : onlineIds;
  const offlineIds = sortedIds.filter(id => !shortcuts.includes(id));
  const renderShortcut = (id: string) => {
    const available = onlineEnvironmentIds.includes(id);
    const status = available ? t('在线', 'Online') : t('离线', 'Offline');
    return <button type="button" key={id} className="environment-shortcut" aria-pressed={value === id}
      title={`${displayName(id)} · ${status} · ${id}`}
      onClick={() => { if (id !== value) onChange(id); }}>
      <span className="environment-shortcut-status"><span className={`environment-status-dot ${available ? 'online' : 'offline'}`} aria-hidden="true" /><span className="visually-hidden">{status}</span></span>
      <strong>{shortName(id)}</strong>
    </button>;
  };
  return <div className={`environment-picker${direct ? ' environment-picker-direct' : ''}`}>
    <div className="environment-picker-heading">
      <span className="environment-picker-label">{t('执行环境', 'Execution environment')}</span>
      {onRename && environmentIds.includes(value) && <button type="button" className="environment-rename-trigger" disabled={saving}
        aria-label={t('重命名设备', 'Rename device')} title={t('重命名设备', 'Rename device')}
        onClick={() => { setName(displayName(value)); setError(''); setEditing(true); }}><SidebarIcon name="edit" /></button>}
    </div>
    {direct ? <>
      {shortcuts.length > 0 ? <div className="environment-shortcuts" role="group" aria-label={t('切换执行环境', 'Switch execution environment')}>
        {shortcuts.map(renderShortcut)}
      </div> : <p className="environment-empty">{t('暂无在线设备', 'No devices online')}</p>}
      {offlineIds.length > 0 && <details className="environment-offline" open={offlineExpanded}
        onToggle={event => setOfflineExpanded(event.currentTarget.open)}>
        <summary>
          <span>{t('离线设备', 'Offline devices')}<span className="environment-offline-count">{offlineIds.length}</span></span>
          {!online && <strong title={displayName(value)}>{shortName(value)}</strong>}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </summary>
        <div className="environment-offline-list" role="group" aria-label={t('离线设备', 'Offline devices')}>
          {offlineIds.map(renderShortcut)}
        </div>
      </details>}
    </> : <CustomSelect className="environment-picker-select" value={value} options={options} onChange={onChange}
      ariaLabel={t('切换执行环境', 'Switch execution environment')}
      triggerContent={<>
        <span className={`environment-status-dot ${online ? 'online' : 'offline'}`} aria-hidden="true" />
        <strong>{displayName(value)}</strong>
        <small>{online ? t('在线', 'Online') : t('离线', 'Offline')}</small>
      </>} />}
    {editing && <form className="environment-rename" onSubmit={async event => {
      event.preventDefault(); if (!onRename || saving || !name.trim()) return;
      setSaving(true); setError('');
      try { await onRename(value, name.trim()); setEditing(false); }
      catch { setError(t('名称保存失败，请重试。', 'Could not save the name. Please retry.')); }
      finally { setSaving(false); }
    }}>
      <label>{t('设备名称', 'Device name')}<input autoFocus value={name} maxLength={80} disabled={saving}
        onChange={event => setName(event.target.value)} /></label>
      <small>{value}</small>
      <div className="environment-rename-actions">
        <button type="button" disabled={saving} onClick={() => setEditing(false)}>{t('取消', 'Cancel')}</button>
        <button type="submit" className="environment-rename-save" disabled={saving || !name.trim()}>{t('保存', 'Save')}</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>}
  </div>;
}
