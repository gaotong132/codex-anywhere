import { lazy, memo, Suspense, useMemo, type RefObject, type UIEventHandler } from 'react';
import { formatAwayDuration, type AwaySummary } from './away-summary';
import {
  resolveTimelineAttachment,
  type KnownAttachment,
  type TimelineItem,
} from './history-utils';
import { t } from './i18n';

const MessageBubble = lazy(() => import('./message-bubble').then((module) => ({
  default: module.MessageBubble,
})));

type ConversationTimelineProps = {
  messageListRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  threadId: string | null;
  creatingNewSession: boolean;
  initialHistoryLoaded: boolean;
  nextCursor: string | null;
  historyLoading: boolean;
  timeline: TimelineItem[];
  knownAttachments: Record<string, KnownAttachment>;
  attachmentUrls: Record<string, string>;
  executionActive: boolean;
  progressAnimationReady: boolean;
  liveProgressItemId: string | null;
  awaySummary: AwaySummary | null;
  onScroll: UIEventHandler<HTMLDivElement>;
  onLoadOlder: () => void;
  onDownloadFile: (path: string) => void;
  onReadVisualization: (path: string) => Promise<string>;
  onDismissAwaySummary: () => void;
};

function AwaySummaryCard({ summary, onDismiss }: { summary: AwaySummary; onDismiss: () => void }) {
  const duration = formatAwayDuration(summary.durationMs);
  const headline = summary.status === 'running'
    ? t('任务仍在执行', 'The run is still in progress')
    : summary.status === 'failed'
      ? t('本轮任务执行失败', 'The run failed')
      : t('本轮任务已完成', 'The run completed');
  return (
    <section className={`away-summary ${summary.status}`} aria-label={t('离开期间摘要', 'While you were away')}>
      <header>
        <span><i aria-hidden="true" />{t('离开期间', 'While you were away')}</span>
        <button type="button" onClick={onDismiss} aria-label={t('关闭摘要', 'Dismiss summary')}>×</button>
      </header>
      <strong>{headline}</strong>
      <div className="away-summary-metrics">
        {summary.progress.plan && (
          <span>{t(
            `${summary.progress.plan.current} / ${summary.progress.plan.total} 个步骤`,
            `${summary.progress.plan.current} / ${summary.progress.plan.total} steps`,
          )}</span>
        )}
        {summary.progress.files && (
          <span>
            {t(`${summary.progress.files.changed} 个文件`, `${summary.progress.files.changed} files`)}
            {' '}<b className="additions">+{summary.progress.files.additions}</b>
            {' '}<b className="deletions">-{summary.progress.files.deletions}</b>
          </span>
        )}
        {summary.newReplies > 0 && (
          <span>{t(`${summary.newReplies} 条新回复`, `${summary.newReplies} new replies`)}</span>
        )}
        {summary.artifacts > 0 && (
          <span>{t(`${summary.artifacts} 个新产物`, `${summary.artifacts} new artifacts`)}</span>
        )}
        {duration && <span>{duration}</span>}
      </div>
    </section>
  );
}

export const ConversationTimeline = memo(function ConversationTimeline({
  messageListRef,
  messageContentRef,
  threadId,
  creatingNewSession,
  initialHistoryLoaded,
  nextCursor,
  historyLoading,
  timeline,
  knownAttachments,
  attachmentUrls,
  executionActive,
  progressAnimationReady,
  liveProgressItemId,
  awaySummary,
  onScroll,
  onLoadOlder,
  onDownloadFile,
  onReadVisualization,
  onDismissAwaySummary,
}: ConversationTimelineProps) {
  const resolvedItems = useMemo(() => timeline.map((item) => {
    const attachment = resolveTimelineAttachment(item, threadId, knownAttachments);
    return {
      attachment,
      item: attachment && !item.attachment ? { ...item, attachment } : item,
    };
  }), [knownAttachments, threadId, timeline]);

  return (
    <div className="message-list" ref={messageListRef} onScroll={onScroll}>
      <div className="message-list-content" ref={messageContentRef}>
        {threadId && initialHistoryLoaded && nextCursor && (
          <button
            className="load-older"
            disabled={historyLoading}
            aria-busy={historyLoading}
            onClick={onLoadOlder}
          >
            {t('加载更早记录', 'Load older messages')}
          </button>
        )}
        {threadId && historyLoading && !initialHistoryLoaded && (
          <div className="history-skeleton">{t('正在加载最近记录…', 'Loading recent messages…')}</div>
        )}
        {!timeline.length && !historyLoading && (
          <div className="empty-conversation">
            <div className="brand-mark small">C</div>
            <h2>{threadId
              ? t('这个分页暂无消息', 'No messages on this page')
              : creatingNewSession
                ? t('创建一个新会话', 'Create a new session')
                : t('选择已有会话', 'Choose an existing session')}</h2>
            <p>{threadId
              ? t('历史记录按页加载，不再一次拉取整个会话。', 'History loads page by page instead of fetching the entire session.')
              : creatingNewSession
                ? t('选择本机项目目录后，第一条消息将在该目录中运行。', 'Choose a local project directory; the first message will run there.')
                : t('打开左上角菜单选择会话；新会话入口也已移入菜单。', 'Open the top-left menu to choose a session or start a new one.')}</p>
          </div>
        )}
        <Suspense fallback={<div className="conversation-render-placeholder" aria-hidden="true" />}>
          {resolvedItems.map(({ item, attachment }) => (
            <MessageBubble
              key={item.id}
              item={item}
              active={executionActive && (item.kind === 'progress'
                ? progressAnimationReady && item.id === liveProgressItemId
                : Boolean(item.transient))}
              imageSource={attachment ? attachmentUrls[attachment.path] : undefined}
              onDownloadFile={onDownloadFile}
              onReadVisualization={onReadVisualization}
            />
          ))}
        </Suspense>
        {awaySummary && <AwaySummaryCard summary={awaySummary} onDismiss={onDismissAwaySummary} />}
      </div>
    </div>
  );
});
