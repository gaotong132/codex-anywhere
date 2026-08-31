import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate } from './app-utils';
import { localFileName, localFilePathFromHref } from './file-utils';
import { t } from './i18n';
import { progressTypewriterKey, type TimelineItem } from './history-utils';
import { TypewriterText } from './ui-components';

type MessageCopyState = 'idle' | 'copied' | 'failed';

export type MessageBubbleProps = {
  item: TimelineItem;
  active?: boolean;
  imageSource?: string;
  onDownloadFile: (path: string) => void;
  onReadVisualization: (path: string) => Promise<string>;
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

function MessageMetadata({ item }: { item: TimelineItem }) {
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
  return (
    <div className="message-meta">
      {item.kind === 'assistant' && item.fileChanges && (
        <span
          className="message-change-summary"
          title={t(
            `${item.fileChanges.changed} 个文件已更改，新增 ${item.fileChanges.additions} 行，删除 ${item.fileChanges.deletions} 行`,
            `${item.fileChanges.changed} files changed, ${item.fileChanges.additions} additions, ${item.fileChanges.deletions} deletions`,
          )}
        >
          <span>{t(`${item.fileChanges.changed} 个文件已更改`, `${item.fileChanges.changed} files changed`)}</span>
          <span className="additions">+{item.fileChanges.additions}</span>
          <span className="deletions">−{item.fileChanges.deletions}</span>
        </span>
      )}
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
          ? item.kind === 'user' ? t('定时任务', 'Scheduled task') : t('自动任务通知', 'Automation update')
          : t('来自另一个 Codex 会话', 'From another Codex task');
        const parsedTime = context.currentTimeIso ? new Date(context.currentTimeIso) : null;
        const time = parsedTime && Number.isFinite(parsedTime.getTime())
          ? parsedTime.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        return (
          <span
            className={`message-context ${context.kind}`}
            key={`${context.kind}:${context.sourceThreadId || context.automationId || index}`}
            title={context.sourceThreadId || context.automationId || label}
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
  onDownloadFile,
}: {
  text: string;
  attachmentPath?: string;
  onDownloadFile: (path: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, href, children, ...props }) => {
      const localPath = localFilePathFromHref(href);
      return localPath
        ? <a {...props} href={href} onClick={(event) => {
            event.preventDefault();
            onDownloadFile(localPath);
          }}>{children}</a>
        : <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    img: ({ node: _node, src, alt, ...props }) => {
      if (!src) return null;
      const localPath = localFilePathFromHref(src);
      if (!localPath) return <img {...props} src={src} alt={alt || ''} loading="lazy" />;
      if (attachmentPath === localPath) return null;
      return (
        <a href={src} onClick={(event) => {
          event.preventDefault();
          onDownloadFile(localPath);
        }}>{alt || localFileName(localPath)}</a>
      );
    },
  }), [attachmentPath, onDownloadFile]);
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

function MessageBubbleComponent({
  item,
  active = false,
  imageSource,
  onDownloadFile,
  onReadVisualization,
}: MessageBubbleProps) {
  const [imageExpanded, setImageExpanded] = useState(false);
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const [visualizationSource, setVisualizationSource] = useState('');
  const [visualizationStatus, setVisualizationStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const visualizationHistoryEntry = useRef(false);
  const visualizationRequestRef = useRef(0);
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
  useEffect(() => () => { visualizationRequestRef.current += 1; }, []);
  useEffect(() => () => {
    if (visualizationSource.startsWith('blob:')) URL.revokeObjectURL(visualizationSource);
  }, [visualizationSource]);
  useEffect(() => {
    if (!imageExpanded && !visualizationOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setImageExpanded(false);
        if (visualizationOpen) closeVisualization();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [imageExpanded, visualizationOpen]);
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
          onDownloadFile={onDownloadFile}
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
      </div>
      {copyable && <MessageMetadata item={item} />}
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
    && JSON.stringify(left.contexts || []) === JSON.stringify(right.contexts || []);
}

function messageBubblePropsEqual(left: MessageBubbleProps, right: MessageBubbleProps) {
  return left.active === right.active
    && left.imageSource === right.imageSource
    && left.onDownloadFile === right.onDownloadFile
    && left.onReadVisualization === right.onReadVisualization
    && messagePresentationEqual(left.item, right.item);
}

export const MessageBubble = memo(MessageBubbleComponent, messageBubblePropsEqual);
