import { useEffect, useState } from 'react';
import { t } from './i18n';
import { TypewriterText } from './ui-components';
import type { LiveActivityKind } from './app-types';
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

function activityLabel(kind: LiveActivityKind) {
  return t(...ACTIVITY_LABELS[kind]);
}

function elapsedLabel(startedAt: number | null, now: number) {
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
  kind, purpose, detail, progress, startedAt,
}: {
  kind: LiveActivityKind;
  purpose: string;
  detail: string;
  progress: TurnProgress;
  startedAt: number | null;
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
  return (
    <div
      className={`tool-purpose${purpose ? ' has-purpose' : ''}${hasMetrics ? ' has-metrics' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={[purpose, detail || activityLabel(kind), elapsed].filter(Boolean).join(' · ')}
      title={[purpose, detail || activityLabel(kind), elapsed].filter(Boolean).join(' · ')}
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
