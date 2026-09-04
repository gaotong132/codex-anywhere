import {
  isValidElement,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate } from './app-utils';
import {
  localTextPreviewInfo,
  localFileName,
  localFilePathFromHref,
  localFilePathFromRelativeHref,
} from './file-utils';
import { CodePreview } from './code-preview';
import { t } from './i18n';
import { progressTypewriterKey, type TimelineItem } from './history-utils';
import { isMermaidCodeClass, MermaidDiagram } from './mermaid-diagram';
import { TypewriterText } from './ui-components';
import type { TurnDiffDocument } from './app-types';

type MessageCopyState = 'idle' | 'copied' | 'failed';

export type MessageBubbleProps = {
  item: TimelineItem;
  active?: boolean;
  imageSource?: string;
  onDownloadFile: (path: string) => void;
  onReadTextFile?: (path: string) => Promise<{
    name: string;
    size: number;
    content: string;
    kind: 'markdown' | 'code' | 'text';
    language: string;
  }>;
  onReadTurnDiff?: (turnId: string) => Promise<TurnDiffDocument>;
  onReadVisualization: (path: string) => Promise<string>;
};

type FilePreviewState = {
  path: string;
  name: string;
  content: string;
  kind: 'markdown' | 'code' | 'text';
  language: string;
  status: 'loading' | 'ready' | 'failed';
};

type TurnDiffPreviewState = {
  turnId: string;
  content: string;
  truncated: boolean;
  status: 'loading' | 'ready' | 'failed';
};

export function visualizationRequestIsCurrent(
  requestVersion: number,
  currentVersion: number,
  requestedPath: string,
  currentPath: string | undefined,
) {
  return requestVersion === currentVersion && requestedPath === currentPath;
}

const markdownPlugins = [remarkGfm];

function messageUrlTransform(url: string) {
  return localFilePathFromHref(url) ? url : defaultUrlTransform(url);
}

function dateTimeValue(value: TimelineItem['completedAt']) {
  if (!value) return '';
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function MessageMetadata({
  item,
  onOpenDiff,
  diffLoading = false,
}: {
  item: TimelineItem;
  onOpenDiff?: () => void;
  diffLoading?: boolean;
}) {
  const [copyState, setCopyState] = useState<MessageCopyState>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCopyState('idle');
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, [item.text]);

  async function copyMessage() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(item.text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState('idle'), 1_800);
  }

  const copyLabel = copyState === 'copied'
    ? t('已复制', 'Copied')
    : copyState === 'failed'
      ? t('复制失败', 'Copy failed')
      : t('复制消息', 'Copy message');
  const completedDateTime = dateTimeValue(item.completedAt);
  const changeSummaryTitle = item.fileChanges ? t(
    `${item.fileChanges.changed} 个文件已更改，新增 ${item.fileChanges.additions} 行，删除 ${item.fileChanges.deletions} 行`,
    `${item.fileChanges.changed} files changed, ${item.fileChanges.additions} additions, ${item.fileChanges.deletions} deletions`,
  ) : '';
  const changeSummary = item.fileChanges && (
    <>
      <span>{t(`${item.fileChanges.changed} 个文件已更改`, `${item.fileChanges.changed} files changed`)}</span>
      <span className="additions">+{item.fileChanges.additions}</span>
      <span className="deletions">−{item.fileChanges.deletions}</span>
    </>
  );
  return (
    <div className="message-meta">
      {item.kind === 'assistant' && item.fileChanges && (onOpenDiff
        ? (
          <button
            className="message-change-summary interactive"
            type="button"
            title={changeSummaryTitle}
            aria-label={t(`查看代码变更：${changeSummaryTitle}`, `View code changes: ${changeSummaryTitle}`)}
            disabled={diffLoading}
            onClick={onOpenDiff}
          >
            {changeSummary}
          </button>
        )
        : <span className="message-change-summary" title={changeSummaryTitle}>{changeSummary}</span>)}
      {item.completedAt && completedDateTime
        ? <time className="message-time" dateTime={completedDateTime}>{formatDate(item.completedAt)}</time>
        : <span className="message-time placeholder" aria-hidden="true">00/00 00:00</span>}
      <button
        className={`message-copy ${copyState}`}
        type="button"
        onClick={() => void copyMessage()}
        aria-label={copyLabel}
        aria-live="polite"
        title={copyLabel}
      >
        {copyState === 'copied'
          ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
          : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}
      </button>
    </div>
  );
}

function MessageContexts({ item }: { item: TimelineItem }) {
  const contexts = item.contexts?.filter((context) => (
    item.kind !== 'user' || context.kind !== 'delegation'
  ));
  if (!contexts?.length) return null;
  return (
    <div className="message-contexts" aria-label={t('消息来源', 'Message context')}>
      {contexts.map((context, index) => {
        const isAutomation = context.kind === 'automation';
        const label = isAutomation
          ? context.decision === 'DONT_NOTIFY'
            ? t('自动任务记录', 'Automation record')
            : item.kind === 'user' && !context.decision
              ? t('由已安排任务发送', 'Sent by scheduled task')
              : t('自动任务通知', 'Automation update')
          : t('来自另一个 Codex 会话', 'From another Codex task');
        const parsedTime = context.currentTimeIso ? new Date(context.currentTimeIso) : null;
        const time = parsedTime && Number.isFinite(parsedTime.getTime())
          ? parsedTime.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        return (
          <span
            className={`message-context ${context.kind}`}
            key={`${context.kind}:${context.sourceThreadId || context.automationId || index}`}
            title={isAutomation ? label : context.sourceThreadId || label}
          >
            {isAutomation
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /><path d="M9 7h3a5 5 0 0 1 5 5v3M7 9v8h8" /></svg>}
            <span>{label}</span>
            {time && <time dateTime={context.currentTimeIso}>{time}</time>}
          </span>
        );
      })}
    </div>
  );
}

const MessageMarkdown = memo(function MessageMarkdown({
  text,
  attachmentPath,
  basePath,
  onDownloadFile,
}: {
  text: string;
  attachmentPath?: string;
  basePath?: string;
  onDownloadFile: (path: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    pre: ({ node: _node, children, ...props }) => {
      const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
        && children.type === 'code' ? children : null;
      if (code && isMermaidCodeClass(code.props.className)) {
        const source = String(code.props.children ?? '').replace(/\n$/, '');
        return <MermaidDiagram source={source} />;
      }
      return <pre {...props}>{children}</pre>;
    },
    a: ({ node: _node, href, children, ...props }) => {
      const localPath = localFilePathFromHref(href) || localFilePathFromRelativeHref(href, basePath);
      return localPath
        ? <a {...props} href={href} onClick={(event) => {
            event.preventDefault();
            onDownloadFile(localPath);
          }}>{children}</a>
        : <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    img: ({ node: _node, src, alt, ...props }) => {
      if (!src) return null;
      const localPath = localFilePathFromHref(src) || localFilePathFromRelativeHref(src, basePath);
      if (!localPath) return <img {...props} src={src} alt={alt || ''} loading="lazy" />;
      if (attachmentPath === localPath) return null;
      return (
        <a href={src} onClick={(event) => {
          event.preventDefault();
          onDownloadFile(localPath);
        }}>{alt || localFileName(localPath)}</a>
      );
    },
  }), [attachmentPath, basePath, onDownloadFile]);
  return (
    <ReactMarkdown
      remarkPlugins={markdownPlugins}
      components={components}
      urlTransform={messageUrlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});

function contextUsagePercent(tokens: number | undefined, contextWindow: number | undefined) {
  if (tokens === undefined || !contextWindow) return null;
  return Math.min(100, Math.max(0, Math.round(tokens / contextWindow * 100)));
}

function ContextCompactionMarker({ item }: { item: TimelineItem }) {
  const compaction = item.compaction!;
  const beforePercent = contextUsagePercent(compaction.beforeTokens, compaction.contextWindow);
  const afterPercent = contextUsagePercent(compaction.afterTokens, compaction.contextWindow);
  const usage = beforePercent !== null && afterPercent !== null
    ? `${beforePercent}% → ${afterPercent}%`
    : beforePercent !== null
      ? t(`压缩前 ${beforePercent}%`, `${beforePercent}% before`)
      : afterPercent !== null
        ? t(`压缩后 ${afterPercent}%`, `${afterPercent}% after`)
        : '';
  const tokenDetail = compaction.contextWindow && compaction.beforeTokens !== undefined
    ? t(
      `压缩前 ${compaction.beforeTokens.toLocaleString()} / ${compaction.contextWindow.toLocaleString()} Token${compaction.afterTokens !== undefined ? `，压缩后 ${compaction.afterTokens.toLocaleString()} Token` : ''}`,
      `${compaction.beforeTokens.toLocaleString()} / ${compaction.contextWindow.toLocaleString()} tokens before${compaction.afterTokens !== undefined ? `, ${compaction.afterTokens.toLocaleString()} after` : ''}`,
    )
    : '';
  const label = t(
    `上下文已压缩，第 ${compaction.sequence} 次${usage ? `，${usage}` : ''}`,
    `Context compacted, pass ${compaction.sequence}${usage ? `, ${usage}` : ''}`,
  );
  const completedDateTime = dateTimeValue(item.completedAt);
  return (
    <div className="context-compaction" role="note" aria-label={label} title={tokenDetail || label}>
      <span className="context-compaction-rule" aria-hidden="true" />
      <span className="context-compaction-content">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8h6m4 0h6M8 5l3 3-3 3m8-6-3 3 3 3M7 16h10" />
        </svg>
        <strong>{t('上下文已压缩', 'Context compacted')}</strong>
        <span>{t(`第 ${compaction.sequence} 次`, `Pass ${compaction.sequence}`)}</span>
        {usage && <b>{usage}</b>}
        {item.completedAt && completedDateTime && (
          <time dateTime={completedDateTime}>{formatDate(item.completedAt)}</time>
        )}
      </span>
      <span className="context-compaction-rule" aria-hidden="true" />
    </div>
  );
}

function TimelineNoticeMarker({ item }: { item: TimelineItem }) {
  const notice = item.notice!;
  const completedDateTime = dateTimeValue(item.completedAt);
  let variant: string = notice.kind;
  let label = '';
  let detail = '';
  const badges: string[] = [];
  if (notice.kind === 'turnStatus') {
    variant = `turnStatus ${notice.status}`;
    label = notice.status === 'aborted'
      ? t('任务已中止', 'Task aborted')
      : notice.status === 'error'
        ? t('任务发生错误', 'Task error')
        : t('任务执行失败', 'Task failed');
    detail = /^(?:interrupted|cancelled)$/i.test(notice.detail || '')
      ? t('已由用户停止', 'Stopped by user')
      : notice.detail || '';
  } else if (notice.kind === 'modelSettings') {
    label = t('运行配置已变更', 'Run configuration changed');
    if (notice.model) badges.push(notice.model);
    if (notice.reasoningEffort) badges.push(t(`推理 ${notice.reasoningEffort}`, `Reasoning ${notice.reasoningEffort}`));
    if (notice.serviceTier) badges.push(t(`服务 ${notice.serviceTier}`, `Service ${notice.serviceTier}`));
  } else if (notice.kind === 'approval') {
    variant = `approval ${notice.decision}`;
    label = notice.decision === 'approved'
      ? t('已批准操作', 'Action approved')
      : t('已拒绝操作', 'Action rejected');
    if (notice.approvalKind) badges.push(notice.approvalKind);
    detail = notice.summary || '';
  } else {
    label = t(`${notice.total} 个工具`, `${notice.total} tools`);
    if (notice.commands) badges.push(t(`${notice.commands} 命令`, `${notice.commands} cmd`));
    if (notice.edits) badges.push(t(`${notice.edits} 编辑`, `${notice.edits} edits`));
    if (notice.searches) badges.push(t(`${notice.searches} 搜索`, `${notice.searches} searches`));
    if (notice.connectedTools) badges.push(t(`${notice.connectedTools} 连接`, `${notice.connectedTools} connected`));
    if (notice.generations) badges.push(t(`${notice.generations} 生成`, `${notice.generations} generated`));
    if (notice.other) badges.push(t(`${notice.other} 其他`, `${notice.other} other`));
  }
  const accessibleLabel = [label, detail, ...badges].filter(Boolean).join(' · ');
  return (
    <div className={`timeline-notice ${variant}`} role="note" aria-label={accessibleLabel} title={detail || accessibleLabel}>
      <span className="timeline-notice-rule" aria-hidden="true" />
      <span className="timeline-notice-content">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {notice.kind === 'toolSummary'
            ? <path d="M8 7h8M6 11h12M9 15h6M5 4h14v14H5z" />
            : notice.kind === 'modelSettings'
              ? <path d="M5 7h14M8 7v4M5 13h14M16 13v4" />
              : notice.kind === 'approval'
                ? <path d="M5 12l4 4L19 6" />
                : <path d="M12 7v6m0 4h.01M4 20h16L12 4z" />}
        </svg>
        <strong>{label}</strong>
        {badges.map((badge) => <b key={badge}>{badge}</b>)}
        {detail && <span className="timeline-notice-detail">{detail}</span>}
        {notice.kind !== 'toolSummary' && item.completedAt && completedDateTime && (
          <time dateTime={completedDateTime}>{formatDate(item.completedAt)}</time>
        )}
      </span>
      <span className="timeline-notice-rule" aria-hidden="true" />
    </div>
  );
}

function MessageBubbleComponent({
  item,
  active = false,
  imageSource,
  onDownloadFile,
  onReadTextFile,
  onReadTurnDiff,
  onReadVisualization,
}: MessageBubbleProps) {
  const [imageExpanded, setImageExpanded] = useState(false);
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const [visualizationSource, setVisualizationSource] = useState('');
  const [visualizationStatus, setVisualizationStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [turnDiffPreview, setTurnDiffPreview] = useState<TurnDiffPreviewState | null>(null);
  const visualizationHistoryEntry = useRef(false);
  const visualizationRequestRef = useRef(0);
  const filePreviewRequestRef = useRef(0);
  const turnDiffRequestRef = useRef(0);
  const visualizationPathRef = useRef(item.visualization?.path);
  visualizationPathRef.current = item.visualization?.path;
  const copyable = item.kind === 'user' || item.kind === 'assistant';
  const finalReplyArriving = item.kind === 'assistant' && Boolean(item.transient && item.completedAt);

  useEffect(() => { setImageExpanded(false); }, [item.attachment?.path]);
  useEffect(() => {
    visualizationRequestRef.current += 1;
    setVisualizationOpen(false);
    clearVisualizationSource();
    setVisualizationStatus('idle');
  }, [item.visualization?.path]);
  useEffect(() => () => {
    visualizationRequestRef.current += 1;
    filePreviewRequestRef.current += 1;
    turnDiffRequestRef.current += 1;
  }, []);
  useEffect(() => {
    turnDiffRequestRef.current += 1;
    setTurnDiffPreview(null);
  }, [item.historyTurnId]);
  useEffect(() => () => {
    if (visualizationSource.startsWith('blob:')) URL.revokeObjectURL(visualizationSource);
  }, [visualizationSource]);
  useEffect(() => {
    if (!imageExpanded && !visualizationOpen && !filePreview && !turnDiffPreview) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setImageExpanded(false);
        if (visualizationOpen) closeVisualization();
        if (filePreview) closeFilePreview();
        if (turnDiffPreview) closeTurnDiff();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [filePreview, imageExpanded, turnDiffPreview, visualizationOpen]);
  useEffect(() => {
    if (!visualizationOpen) return undefined;
    const closeOnBack = () => {
      visualizationHistoryEntry.current = false;
      setVisualizationOpen(false);
      clearVisualizationSource();
    };
    window.addEventListener('popstate', closeOnBack);
    return () => window.removeEventListener('popstate', closeOnBack);
  }, [visualizationOpen]);

  function showVisualization() {
    if (!visualizationHistoryEntry.current) {
      const currentState = window.history.state && typeof window.history.state === 'object'
        ? window.history.state : {};
      window.history.pushState({ ...currentState, codexAnywhereOverlay: 'visualization' }, '');
      visualizationHistoryEntry.current = true;
    }
    setVisualizationOpen(true);
  }

  function closeVisualization() {
    setVisualizationOpen(false);
    clearVisualizationSource();
    if (!visualizationHistoryEntry.current) return;
    visualizationHistoryEntry.current = false;
    window.history.back();
  }

  function clearVisualizationSource() {
    setVisualizationSource('');
  }

  async function openVisualization() {
    if (!item.visualization || visualizationStatus === 'loading') return;
    if (visualizationSource) {
      showVisualization();
      return;
    }
    const path = item.visualization.path;
    const requestVersion = ++visualizationRequestRef.current;
    setVisualizationStatus('loading');
    try {
      const previewUrl = await onReadVisualization(path);
      if (!visualizationRequestIsCurrent(
        requestVersion, visualizationRequestRef.current, path, visualizationPathRef.current,
      )) {
        if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
        return;
      }
      setVisualizationSource(previewUrl);
      setVisualizationStatus('idle');
      showVisualization();
    } catch {
      if (visualizationRequestIsCurrent(
        requestVersion, visualizationRequestRef.current, path, visualizationPathRef.current,
      )) setVisualizationStatus('failed');
    }
  }

  async function openLocalFile(path: string) {
    const previewInfo = localTextPreviewInfo(path);
    if (!onReadTextFile || !previewInfo) {
      onDownloadFile(path);
      return;
    }
    const requestVersion = ++filePreviewRequestRef.current;
    setFilePreview({
      path, name: localFileName(path), content: '', status: 'loading', ...previewInfo,
    });
    try {
      const document = await onReadTextFile(path);
      if (requestVersion !== filePreviewRequestRef.current) return;
      setFilePreview({
        path,
        name: document.name || localFileName(path),
        content: document.content,
        kind: document.kind,
        language: document.language,
        status: 'ready',
      });
    } catch {
      if (requestVersion !== filePreviewRequestRef.current) return;
      setFilePreview({
        path, name: localFileName(path), content: '', status: 'failed', ...previewInfo,
      });
    }
  }

  function closeFilePreview() {
    filePreviewRequestRef.current += 1;
    setFilePreview(null);
  }

  async function openTurnDiff() {
    const turnId = String(item.historyTurnId || '').trim();
    if (!turnId || !onReadTurnDiff || turnDiffPreview?.status === 'loading') return;
    const requestVersion = ++turnDiffRequestRef.current;
    setTurnDiffPreview({ turnId, content: '', truncated: false, status: 'loading' });
    try {
      const document = await onReadTurnDiff(turnId);
      if (requestVersion !== turnDiffRequestRef.current || document.turnId !== turnId) return;
      setTurnDiffPreview({
        turnId,
        content: document.content,
        truncated: document.truncated,
        status: 'ready',
      });
    } catch {
      if (requestVersion !== turnDiffRequestRef.current) return;
      setTurnDiffPreview({ turnId, content: '', truncated: false, status: 'failed' });
    }
  }

  function closeTurnDiff() {
    turnDiffRequestRef.current += 1;
    setTurnDiffPreview(null);
  }

  if (item.kind === 'system' && item.compaction) return <ContextCompactionMarker item={item} />;
  if (item.kind === 'system' && item.notice) return <TimelineNoticeMarker item={item} />;
  if (item.kind === 'progress') {
    return (
      <details className={`progress-card${active ? ' live' : ''}`} open>
        <summary>{t('进度更新', 'Progress update')}</summary>
        <pre><TypewriterText
          className="progress-typewriter"
          text={item.text}
          active={active}
          continuityKey={progressTypewriterKey(item)}
          durationMs={1_200}
        /></pre>
      </details>
    );
  }
  return (
    <div className={`message-block ${item.kind}${copyable ? ' copyable' : ''}`}>
      <div className={`message ${item.kind}${copyable ? ' copyable' : ''}${active ? ' live' : ''}${finalReplyArriving ? ' final-arriving' : ''}`}>
        <MessageContexts item={item} />
        <MessageMarkdown
          text={item.text}
          attachmentPath={item.attachment?.path}
          onDownloadFile={(path) => void openLocalFile(path)}
        />
        {item.attachment && (
          <figure className="message-image">
            {imageSource === undefined && <div className="message-image-state">{t('正在加载图片…', 'Loading image…')}</div>}
            {imageSource === '' && <div className="message-image-state">{t('图片已过期或无法读取', 'Image expired or unavailable')}</div>}
            {imageSource && (
              <button
                className="message-image-preview"
                type="button"
                onClick={() => setImageExpanded(true)}
                aria-label={t('放大图片', 'Expand image')}
              >
                <img src={imageSource} alt={item.attachment.name} loading="lazy" />
              </button>
            )}
            <figcaption>
              <span>{item.attachment.name}</span>
              {(item.attachment.source === 'generated' || item.attachment.source === 'local') && (
                <button type="button" onClick={() => onDownloadFile(item.attachment!.path)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4-4 4 4 4-4M5 19h14" /></svg>
                  {t('下载原图', 'Download original')}
                </button>
              )}
            </figcaption>
          </figure>
        )}
        {item.visualization && (
          <section className="visualization-card" aria-label={t('交互可视化', 'Interactive visualization')}>
            <div className="visualization-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M4 5h16v12H4zM8 21h8M12 17v4M8 13l3-3 2 2 3-4" /></svg>
            </div>
            <div className="visualization-card-copy">
              <strong>{item.visualization.name}</strong>
              <span>{visualizationStatus === 'failed'
                ? t('预览失败，仍可下载文件', 'Preview failed; the file can still be downloaded')
                : t('Codex 交互可视化', 'Codex interactive visualization')}</span>
            </div>
            <div className="visualization-card-actions">
              <button type="button" disabled={visualizationStatus === 'loading'} onClick={() => void openVisualization()}>
                {visualizationStatus === 'loading' ? t('加载中…', 'Loading…') : t('预览', 'Preview')}
              </button>
              <button type="button" onClick={() => onDownloadFile(item.visualization!.path)}>{t('下载', 'Download')}</button>
            </div>
          </section>
        )}
        {imageExpanded && imageSource && item.attachment && (
          <div
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={t('图片预览', 'Image preview')}
            onClick={() => setImageExpanded(false)}
          >
            <button
              className="image-lightbox-close"
              type="button"
              onClick={() => setImageExpanded(false)}
              aria-label={t('关闭图片预览', 'Close image preview')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
            <img src={imageSource} alt={item.attachment.name} onClick={(event) => event.stopPropagation()} />
          </div>
        )}
        {visualizationOpen && visualizationSource && item.visualization && (
          <div
            className="visualization-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={t('交互可视化预览', 'Interactive visualization preview')}
          >
            <header>
              <span>{item.visualization.name}</span>
              <button type="button" onClick={closeVisualization} aria-label={t('关闭预览', 'Close preview')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </header>
            <iframe
              src={visualizationSource}
              title={item.visualization.name}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          </div>
        )}
        {filePreview && (
          <div
            className="markdown-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={t('文件预览', 'File preview')}
          >
            <header>
              <span title={filePreview.path}>{filePreview.name}</span>
              <div className="markdown-lightbox-actions">
                <button type="button" onClick={() => onDownloadFile(filePreview.path)}>
                  {t('下载', 'Download')}
                </button>
                <button type="button" onClick={closeFilePreview} aria-label={t('关闭预览', 'Close preview')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
            </header>
            <main aria-busy={filePreview.status === 'loading'}>
              {filePreview.status === 'loading' && (
                <div className="markdown-preview-state">{t('正在读取文件…', 'Loading file…')}</div>
              )}
              {filePreview.status === 'failed' && (
                <div className="markdown-preview-state failed">
                  <span>{t('预览失败，仍可下载文件。', 'Preview failed; the file can still be downloaded.')}</span>
                  <button type="button" onClick={() => void openLocalFile(filePreview.path)}>
                    {t('重试', 'Retry')}
                  </button>
                </div>
              )}
              {filePreview.status === 'ready' && filePreview.kind === 'markdown' && (
                <article className="message assistant markdown-preview-content">
                  <MessageMarkdown text={filePreview.content} basePath={filePreview.path} onDownloadFile={(path) => void openLocalFile(path)} />
                </article>
              )}
              {filePreview.status === 'ready' && filePreview.kind !== 'markdown' && (
                <CodePreview content={filePreview.content} language={filePreview.language} />
              )}
            </main>
          </div>
        )}
      </div>
      {copyable && (
        <MessageMetadata
          item={item}
          onOpenDiff={item.historyTurnId && onReadTurnDiff ? () => void openTurnDiff() : undefined}
          diffLoading={turnDiffPreview?.status === 'loading'}
        />
      )}
      {turnDiffPreview && (
        <div
          className="markdown-lightbox turn-diff-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t('本轮代码变更', 'Code changes for this turn')}
        >
          <header>
            <div className="turn-diff-heading">
              <span>{t('本轮代码变更', 'Code changes for this turn')}</span>
              {item.fileChanges && (
                <small>
                  <span>{t(`${item.fileChanges.changed} 个文件`, `${item.fileChanges.changed} files`)}</span>
                  <b className="additions">+{item.fileChanges.additions}</b>
                  <b className="deletions">−{item.fileChanges.deletions}</b>
                </small>
              )}
            </div>
            <div className="markdown-lightbox-actions">
              <button type="button" onClick={closeTurnDiff} aria-label={t('关闭代码变更', 'Close code changes')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
          </header>
          <main aria-busy={turnDiffPreview.status === 'loading'}>
            {turnDiffPreview.status === 'loading' && (
              <div className="markdown-preview-state">{t('正在读取本轮代码变更…', 'Loading code changes for this turn…')}</div>
            )}
            {turnDiffPreview.status === 'failed' && (
              <div className="markdown-preview-state failed">
                <span>{t('本轮代码变更不可用。', 'Code changes for this turn are unavailable.')}</span>
                <button type="button" onClick={() => void openTurnDiff()}>{t('重试', 'Retry')}</button>
              </div>
            )}
            {turnDiffPreview.status === 'ready' && (
              <>
                {turnDiffPreview.truncated && (
                  <div className="turn-diff-truncated">
                    {t('变更内容较大，已显示前 512 KiB。', 'This diff is large; showing the first 512 KiB.')}
                  </div>
                )}
                <CodePreview content={turnDiffPreview.content} language="diff" />
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function equalOptionalRecord(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key] === value);
}

export function messagePresentationEqual(left: TimelineItem, right: TimelineItem) {
  if (left === right) return true;
  return left.id === right.id
    && left.kind === right.kind
    && left.text === right.text
    && left.transient === right.transient
    && left.completedAt === right.completedAt
    && equalOptionalRecord(left.attachment, right.attachment)
    && equalOptionalRecord(left.visualization, right.visualization)
    && equalOptionalRecord(left.fileChanges, right.fileChanges)
    && equalOptionalRecord(left.compaction, right.compaction)
    && equalOptionalRecord(left.notice, right.notice)
    && JSON.stringify(left.contexts || []) === JSON.stringify(right.contexts || []);
}

function messageBubblePropsEqual(left: MessageBubbleProps, right: MessageBubbleProps) {
  return left.active === right.active
    && left.imageSource === right.imageSource
    && left.onDownloadFile === right.onDownloadFile
    && left.onReadTextFile === right.onReadTextFile
    && left.onReadTurnDiff === right.onReadTurnDiff
    && left.onReadVisualization === right.onReadVisualization
    && messagePresentationEqual(left.item, right.item);
}

export const MessageBubble = memo(MessageBubbleComponent, messageBubblePropsEqual);
