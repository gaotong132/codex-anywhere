import { useEffect, useState } from 'react';
import { t } from './i18n';
import { TypewriterText } from './ui-components';
import type { ExecutionState, LiveActivityKind } from './app-types';
import type { TurnProgress } from '../../src/shared/turn-progress';

const ACTIVITY_LABELS: Record<LiveActivityKind, [string, string]> = {
  starting: ['正在启动', 'Starting'],
  planning: ['正在规划', 'Planning'],
  command: ['正在执行', 'Running'],
  editing: ['正在修改文件', 'Editing files'],
  searching: ['正在搜索', 'Searching'],
  connectedTool: ['正在处理', 'Using a tool'],
  generating: ['正在生成图片', 'Generating an image'],
  waiting: ['正在等待', 'Waiting'],
  checking: ['正在检查结果', 'Checking results'],
  responding: ['正在整理回复', 'Preparing a response'],
  working: ['正在处理', 'Working'],
};

export function safeActivityKind(value: unknown): LiveActivityKind {
  return Object.hasOwn(ACTIVITY_LABELS, String(value || ''))
    ? String(value) as LiveActivityKind : 'working';
}

export function liveEventActivity(payload: Record<string, unknown>): LiveActivityKind {
  const type = String(payload.type || '').toLowerCase();
  const name = String(payload.name || '').toLowerCase();
  if (/websearch|web_search/.test(type) || /web.?search/.test(name)) return 'searching';
  if (/commandexecution|command_execution/.test(type) || /command|shell|exec/.test(name)) return 'command';
  if (/image/.test(type) || /image.?gen/.test(name)) return 'generating';
  return 'connectedTool';
}

export function epochMillis(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function activityLabel(kind: LiveActivityKind) {
  return t(...ACTIVITY_LABELS[kind]);
}

export function elapsedLabel(startedAt: number | null, now: number) {
  if (!startedAt) return '';
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function LiveActivityStatus({
  kind, purpose, detail, progress, startedAt, onOpenDetails,
}: {
  kind: LiveActivityKind;
  purpose: string;
  detail: string;
  progress: TurnProgress;
  startedAt: number | null;
  onOpenDetails?: () => void;
}) {
  const [clock, setClock] = useState(Date.now());
  const elapsed = elapsedLabel(startedAt, clock);
  const hasMetrics = Boolean(progress.plan || progress.files);
  useEffect(() => {
    if (!startedAt) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const label = [purpose, detail || activityLabel(kind), elapsed].filter(Boolean).join(' · ');
  return (
    <button
      className={`tool-purpose${purpose ? ' has-purpose' : ''}${hasMetrics ? ' has-metrics' : ''}${onOpenDetails ? ' interactive' : ''}`}
      type="button"
      onClick={onOpenDetails}
      disabled={!onOpenDetails}
      aria-label={onOpenDetails ? t(`打开运行详情：${label}`, `Open run details: ${label}`) : label}
      title={onOpenDetails ? t('查看运行详情', 'View run details') : label}
    >
      <div className="activity-content">
        {purpose && (
          <div className="activity-line activity-purpose-line">
            <TypewriterText active as="strong" className="status-change" key={purpose} text={purpose} />
          </div>
        )}
        <div className="activity-line activity-detail-line">
          <ToolActivityDetail detail={detail} kind={kind} />
        </div>
        {hasMetrics && (
          <div className="activity-line activity-secondary">
            <span className="activity-metrics">
              {progress.plan && (
                <TypewriterText
                  active
                  className="status-change"
                  key={`plan:${progress.plan.current}:${progress.plan.total}`}
                  showCaret={false}
                  text={t(`第 ${progress.plan.current} / ${progress.plan.total} 步`, `Step ${progress.plan.current} / ${progress.plan.total}`)}
                />
              )}
              {progress.files && (
                <TypewriterText
                  active
                  className="status-change"
                  completeContent={<>
                    {t(`${progress.files.changed} 个文件已更改`, `${progress.files.changed} files changed`)}
                    {' '}<b className="additions">+{progress.files.additions}</b>
                    {' '}<b className="deletions">-{progress.files.deletions}</b>
                  </>}
                  key={`files:${progress.files.changed}:${progress.files.additions}:${progress.files.deletions}`}
                  showCaret={false}
                  text={t(
                    `${progress.files.changed} 个文件已更改 +${progress.files.additions} -${progress.files.deletions}`,
                    `${progress.files.changed} files changed +${progress.files.additions} -${progress.files.deletions}`,
                  )}
                />
              )}
            </span>
          </div>
        )}
      </div>
      {startedAt && <time className="activity-elapsed">{elapsed}</time>}
      {onOpenDetails && (
        <svg className="activity-details-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      )}
    </button>
  );
}

export function RunDetailsSheet({
  open,
  state,
  kind,
  purpose,
  detail,
  progress,
  startedAt,
  environment,
  canStop,
  stopping,
  onClose,
  onStop,
}: {
  open: boolean;
  state: ExecutionState;
  kind: LiveActivityKind;
  purpose: string;
  detail: string;
  progress: TurnProgress;
  startedAt: number | null;
  environment: string;
  canStop: boolean;
  stopping: boolean;
  onClose: () => void;
  onStop: () => void;
}) {
  const [clock, setClock] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!open || !startedAt) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open, startedAt]);
  useEffect(() => {
    if (!open || !canStop) setConfirming(false);
  }, [canStop, open]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !stopping) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open, stopping]);
  if (!open) return null;
  const elapsed = elapsedLabel(startedAt, clock);
  const stateLabel = state === 'waiting' ? t('正在等待', 'Waiting') : activityLabel(kind);
  const currentAction = purpose || detail || activityLabel(kind);
  return (
    <div
      className="run-details-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !stopping) onClose();
      }}
    >
      <section className="run-details-sheet" role="dialog" aria-modal="true" aria-labelledby="run-details-title">
        <header>
          <div>
            <span>{t('运行详情', 'RUN DETAILS')}</span>
            <h2 id="run-details-title">{t('本次执行', 'Current run')}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={stopping} aria-label={t('关闭', 'Close')}>×</button>
        </header>
        <div className="run-details-body">
          <div className="run-details-state">
            <i aria-hidden="true" />
            <strong>{stateLabel}</strong>
            {elapsed && <time>{elapsed}</time>}
          </div>
          <dl>
            <div><dt>{t('执行环境', 'Environment')}</dt><dd>{environment}</dd></div>
            <div><dt>{t('当前动作', 'Current action')}</dt><dd>{currentAction}</dd></div>
            {purpose && detail && <div><dt>{t('状态', 'Status')}</dt><dd>{detail}</dd></div>}
            {progress.plan && (
              <div>
                <dt>{t('计划进度', 'Plan progress')}</dt>
                <dd>{t(`第 ${progress.plan.current} / ${progress.plan.total} 步`, `Step ${progress.plan.current} / ${progress.plan.total}`)}</dd>
              </div>
            )}
            {progress.files && (
              <div>
                <dt>{t('文件变更', 'File changes')}</dt>
                <dd>{t(
                  `${progress.files.changed} 个文件 · +${progress.files.additions} -${progress.files.deletions}`,
                  `${progress.files.changed} files · +${progress.files.additions} -${progress.files.deletions}`,
                )}</dd>
              </div>
            )}
          </dl>
          {!canStop && (
            <p className="run-stop-unavailable">
              {t(
                '这次执行由 Codex Desktop 持有，请在电脑端停止。会话和历史记录不会受到影响。',
                'Codex Desktop owns this run. Stop it on the computer; the task and history will remain intact.',
              )}
            </p>
          )}
          {confirming && canStop && (
            <p className="run-stop-warning">
              {t(
                '停止后会保留会话和历史记录，之后仍可继续发送消息。',
                'Stopping keeps the task and history. You can continue sending messages afterward.',
              )}
            </p>
          )}
        </div>
        {canStop && (
          <footer>
            {confirming ? <>
              <button type="button" onClick={() => setConfirming(false)} disabled={stopping}>{t('取消', 'Cancel')}</button>
              <button className="danger" type="button" onClick={onStop} disabled={stopping}>
                {stopping ? t('正在停止…', 'Stopping…') : t('确认停止', 'Confirm stop')}
              </button>
            </> : (
              <button className="danger wide-stop" type="button" onClick={() => setConfirming(true)}>
                {t('停止本次执行', 'Stop this run')}
              </button>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}

function ToolActivityDetail({ detail, kind }: { detail: string; kind: LiveActivityKind }) {
  const completed = detail.startsWith('✓ ');
  const text = completed ? detail.slice(2) : detail || activityLabel(kind);
  const [checkedDetail, setCheckedDetail] = useState('');
  const [typedText, setTypedText] = useState('');
  useEffect(() => {
    if (!completed) {
      setCheckedDetail('');
      return;
    }
    if (typedText === text) setCheckedDetail(detail);
  }, [completed, detail, text, typedText]);
  return <>
    <TypewriterText
      active
      as="strong"
      className="status-change"
      key={text}
      text={text}
      onComplete={() => {
        setTypedText(text);
        if (completed) setCheckedDetail(detail);
      }}
    />
    {completed && checkedDetail === detail && (
      <span className="activity-complete-check" key={detail} aria-hidden="true">✓</span>
    )}
  </>;
}
