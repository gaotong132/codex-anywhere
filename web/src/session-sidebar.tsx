import { memo, useMemo } from 'react';
import {
  formatDate,
  isSessionRunning,
  sessionProjectName,
  sessionUpdatedAt,
  type SessionAttentionState,
} from './app-utils';
import type { ExecutionState, Session } from './app-types';
import { t } from './i18n';
import { SidebarIcon } from './ui-components';

type SessionSidebarProps = {
  open: boolean;
  sessions: Session[];
  selectedThreadId: string | null;
  executionState: ExecutionState;
  attention: SessionAttentionState;
  searchOpen: boolean;
  search: string;
  onSearchOpenChange: (open: boolean) => void;
  onSearchChange: (search: string) => void;
  onNewSession: () => void;
  onClose: () => void;
  onSelect: (session: Session) => void;
};

/**
 * Kept outside App so prompt typing and live progress updates do not rebuild a
 * potentially long session list. It still refreshes for real session/status changes.
 */
export const SessionSidebar = memo(function SessionSidebar({
  open,
  sessions,
  selectedThreadId,
  executionState,
  attention,
  searchOpen,
  search,
  onSearchOpenChange,
  onSearchChange,
  onNewSession,
  onClose,
  onSelect,
}: SessionSidebarProps) {
  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = query
      ? sessions.filter((session) => `${session.title} ${session.cwd || ''} ${session.preview || ''}`
        .toLocaleLowerCase().includes(query))
      : sessions;
    return [...matches]
      .sort((left, right) => sessionUpdatedAt(right.updatedAt) - sessionUpdatedAt(left.updatedAt));
  }, [search, sessions]);

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={t('会话列表', 'Session list')}>
      <div className="sidebar-head">
        <div><p className="eyebrow">CODEX ANYWHERE</p></div>
        <div className="sidebar-actions">
          <button className="sidebar-tool" onClick={onNewSession} aria-label={t('新会话', 'New session')} title={t('新会话', 'New session')}>
            <SidebarIcon name="plus" />
          </button>
          <button
            className={`sidebar-tool ${searchOpen ? 'active' : ''}`}
            onClick={() => {
              if (searchOpen) onSearchChange('');
              onSearchOpenChange(!searchOpen);
            }}
            aria-label={searchOpen ? t('收起搜索', 'Collapse search') : t('搜索会话', 'Search sessions')}
            title={searchOpen ? t('收起搜索', 'Collapse search') : t('搜索会话', 'Search sessions')}
          >
            <SidebarIcon name="search" />
          </button>
          <button className="sidebar-tool mobile-only" onClick={onClose} aria-label={t('收起会话列表', 'Collapse session list')} title={t('收起会话列表', 'Collapse session list')}>
            <SidebarIcon name="panel-close" />
          </button>
        </div>
      </div>
      {searchOpen && (
        <label className="compact-search session-search-panel">
          <span className="compact-search-icon"><SidebarIcon name="search" /></span>
          <input
            autoFocus
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onSearchChange('');
                onSearchOpenChange(false);
              }
            }}
            placeholder={t('搜索会话或目录', 'Search sessions or folders')}
          />
        </label>
      )}
      <nav className="session-list">
        {visibleSessions.map((session) => {
          const sessionRunning = isSessionRunning(session.status)
            || (session.id === selectedThreadId
              && (executionState === 'running' || executionState === 'waiting'));
          const completedUnread = !sessionRunning && attention[session.id] === 'unread';
          const projectName = sessionProjectName(session.cwd);
          return (
            <button
              key={session.id}
              className={`session-card ${selectedThreadId === session.id ? 'active' : ''} ${sessionRunning ? 'running' : ''} ${completedUnread ? 'completed-unread' : ''}`}
              onClick={() => onSelect(session)}
            >
              <span className="session-title" title={session.title || session.id}>{session.title || session.id}</span>
              <span className="session-meta">
                {sessionRunning && <span className="session-running-dot" aria-label={t('运行中', 'Running')} title={t('运行中', 'Running')} />}
                {completedUnread && <span className="session-unread-dot" aria-label={t('已完成，未读', 'Completed, unread')} title={t('已完成，未读', 'Completed, unread')} />}
                <span
                  className={projectName ? 'session-project' : 'session-project placeholder'}
                  title={projectName ? session.cwd : undefined}
                >
                  {projectName || 'General session'}
                </span>
                <time>{formatDate(session.updatedAt)}</time>
              </span>
            </button>
          );
        })}
        {!visibleSessions.length && <p className="empty-list">{t('没有匹配的会话', 'No matching sessions')}</p>}
      </nav>
    </aside>
  );
});
