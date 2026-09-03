import { createRoot } from 'react-dom/client';
import { MessageBubble } from './message-bubble';
import type { TimelineItem } from './history-utils';
import { PresenceIndicator } from './presence-indicator';
import { SidebarIcon } from './ui-components';
import './styles.scss';
import './promo.scss';

const sessions = [
  { title: 'Atlas production rollout', project: 'Atlas', time: '10:03', state: 'active' },
  { title: 'Windows connector smoke test', project: 'General session', time: '09:57', state: 'running' },
  { title: 'Summarize the release notes', project: 'Northstar', time: '09:23', state: '' },
  { title: 'Review image delivery', project: 'Canvas', time: 'Yesterday', state: 'unread' },
  { title: 'Polish the mobile experience', project: 'Orbit', time: 'Friday', state: '' },
  { title: 'Inspect the agent protocol', project: 'Northstar', time: 'Thursday', state: '' },
  { title: 'Clean up the documentation', project: 'Atlas', time: 'Wednesday', state: '' },
  { title: 'Verify reconnect behavior', project: 'Canvas', time: 'Tuesday', state: '' },
  { title: 'Prepare the launch checklist', project: 'Orbit', time: 'Monday', state: '' },
];

const previewImage = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#142a56"/><stop offset="1" stop-color="#5338a9"/>
      </linearGradient>
      <linearGradient id="card" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#2e67d1"/><stop offset="1" stop-color="#6b55d9"/>
      </linearGradient>
    </defs>
    <rect width="720" height="420" fill="url(#bg)"/>
    <circle cx="610" cy="70" r="120" fill="#7b6df2" opacity=".18"/>
    <circle cx="90" cy="390" r="170" fill="#2c8ee9" opacity=".14"/>
    <rect x="72" y="62" width="576" height="296" rx="28" fill="#0d1525" stroke="#7496df" stroke-opacity=".42"/>
    <rect x="105" y="101" width="218" height="26" rx="13" fill="#273755"/>
    <rect x="105" y="148" width="424" height="18" rx="9" fill="#1e2c45"/>
    <rect x="105" y="181" width="346" height="18" rx="9" fill="#1e2c45"/>
    <rect x="105" y="233" width="214" height="76" rx="18" fill="url(#card)"/>
    <rect x="343" y="233" width="186" height="76" rx="18" fill="#18243a" stroke="#35548b"/>
    <circle cx="601" cy="111" r="17" fill="#3c7ae4"/>
  </svg>`)} `;

const previewDiff = [
  'diff --git a/web/src/App.tsx b/web/src/App.tsx',
  '--- a/web/src/App.tsx',
  '+++ b/web/src/App.tsx',
  '@@ -42,2 +42,3 @@',
  ' const compact = true;',
  '-const follow = false;',
  '+const follow = true;',
  '+const mobileReady = true;',
].join('\n');

const conversationItems: TimelineItem[] = [
  {
    id: 'promo-user',
    kind: 'user',
    text: 'Make the mobile layout more compact and keep the latest progress visible.',
    completedAt: '2026-08-30T09:57:00+08:00',
    attachment: { path: 'C:/Mock/ui-reference.png', name: 'ui-reference.png', source: 'local' },
  },
  {
    id: 'promo-progress',
    kind: 'progress',
    text: 'Updated the responsive layout and verified the message timeline.\nPackaging the preview and checking the downloadable artifact.',
    completedAt: '2026-08-30T10:02:00+08:00',
  },
  {
    id: 'promo-tools',
    kind: 'system',
    text: '',
    completedAt: '2026-08-30T10:03:00+08:00',
    notice: { kind: 'toolSummary', total: 41, commands: 28, edits: 5, other: 8 },
  },
  {
    id: 'promo-assistant',
    kind: 'assistant',
    text: 'The mobile release is ready.\n\n- Image delivery passed\n- Progress tracking verified\n\n[Download the build](C:/Mock/atlas-mobile.zip)',
    historyTurnId: 'promo-turn',
    completedAt: '2026-08-30T10:03:00+08:00',
    fileChanges: { changed: 3, additions: 28, deletions: 11 },
  },
];

function ModelSummary() {
  return (
    <div className="model-config">
      <button className="model-config-summary" type="button" tabIndex={-1}>
        <span className="model-config-model">GPT-5.6-Sol</span>
        <span>High</span>
        <span className="fast">Standard</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
    </div>
  );
}

function ConversationHeader({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <header className={`topbar${dimmed ? ' promo-dimmed' : ''}`}>
      <button className="icon-button mobile-only" type="button" tabIndex={-1}>
        <SidebarIcon name="panel-open" />
      </button>
      <div className="conversation-heading">
        <strong>Atlas production rollout</strong>
        <ModelSummary />
      </div>
      <PresenceIndicator
        online
        executionState="running"
        statusText="Codex is working"
        contextUsage={{ tokens: 176_947, contextWindow: 258_400 }}
      />
    </header>
  );
}

function Composer() {
  return (
    <footer className="composer-wrap">
      <div className="composer">
        <button className="attach-button" type="button" tabIndex={-1}>＋</button>
        <textarea rows={1} readOnly placeholder="Send to current task…" />
        <div className="composer-actions">
          <button className="send-button" type="button" tabIndex={-1}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" /></svg>
          </button>
        </div>
      </div>
    </footer>
  );
}

function ConversationPreview({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <section className={`conversation promo-conversation${dimmed ? ' promo-dimmed' : ''}`}>
      <ConversationHeader dimmed={dimmed} />
      <div className="message-list">
        <div className="message-list-content">
          {conversationItems.map((item) => (
            <MessageBubble
              key={item.id}
              item={item}
              imageSource={item.attachment ? previewImage : undefined}
              onDownloadFile={() => undefined}
              onReadTurnDiff={async (turnId) => ({
                threadId: 'promo-thread', turnId, size: new Blob([previewDiff]).size,
                content: previewDiff, truncated: false,
              })}
              onReadVisualization={async () => ''}
            />
          ))}
        </div>
      </div>
      <div className="execution-strip">
        <div className="tool-purpose">
          <div className="activity-content">
            <div className="activity-line activity-purpose-line"><strong>Validating the release pipeline</strong></div>
            <div className="activity-line activity-detail-line"><strong>exec_command · npm run check</strong><span className="activity-complete-check">✓</span></div>
            <div className="activity-line"><span className="activity-metrics"><span>3 files changed</span><span><b className="additions">+28</b> <b className="deletions">−11</b></span></span></div>
          </div>
          <time className="activity-elapsed">02:28</time>
        </div>
      </div>
      <Composer />
    </section>
  );
}

function SessionDrawerPreview() {
  return (
    <main className="app-shell promo-session-shell">
      <button className="drawer-backdrop" type="button" tabIndex={-1} />
      <aside className="sidebar open">
        <div className="sidebar-head">
          <p className="eyebrow">CODEX ANYWHERE</p>
          <div className="sidebar-actions">
            <button className="sidebar-tool" type="button" tabIndex={-1}><SidebarIcon name="plus" /></button>
            <button className="sidebar-tool" type="button" tabIndex={-1}><SidebarIcon name="search" /></button>
            <button className="sidebar-tool mobile-only" type="button" tabIndex={-1}><SidebarIcon name="panel-close" /></button>
          </div>
        </div>
        <label className="environment-picker">
          <span className="environment-picker-label">Execution environment</span>
          <span className="environment-picker-status online" aria-hidden="true" />
          <select value="ecs" onChange={() => {}} tabIndex={-1} aria-label="Execution environment">
            <option value="ecs">ECS · 24×7 · Online</option>
          </select>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </label>
        <nav className="session-list">
          {sessions.map((session) => (
            <button
              key={session.title}
              className={`session-card${session.state === 'active' ? ' active' : ''}${session.state === 'running' ? ' running' : ''}${session.state === 'unread' ? ' completed-unread' : ''}`}
              type="button"
              tabIndex={-1}
            >
              <span className="session-title">{session.title}</span>
              <span className="session-meta">
                {session.state === 'running' && <span className="session-running-dot" />}
                {session.state === 'unread' && <span className="session-unread-dot" />}
                <span className="session-project">{session.project}</span>
                <time>{session.time}</time>
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <ConversationPreview dimmed />
    </main>
  );
}

const view = new URLSearchParams(window.location.search).get('view');
createRoot(document.getElementById('root')!).render(
  view === 'session' ? <SessionDrawerPreview /> : <main className="app-shell promo-conversation-shell"><ConversationPreview /></main>,
);
