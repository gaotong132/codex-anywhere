import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate } from './app-utils';
import { localFileName, localFilePathFromHref } from './file-utils';
import { t } from './i18n';
import type { TimelineItem } from './history-utils';
import type { FileDownloadState } from './app-types';

type SidebarIconName = 'plus' | 'search' | 'panel-open' | 'panel-close';

function dateTimeValue(value: TimelineItem['completedAt']) {
  if (!value) return '';
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function TypewriterText({
  text,
  active,
  className = '',
  as = 'span',
  showCaret = true,
  completeContent,
}: {
  text: string;
  active: boolean;
  className?: string;
  as?: 'span' | 'strong';
  showCaret?: boolean;
  completeContent?: ReactNode;
}) {
  const [visibleText, setVisibleText] = useState(active ? '' : text);
  const visibleTextRef = useRef(visibleText);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!active || reduceMotion) {
      visibleTextRef.current = text;
      setVisibleText(text);
      return undefined;
    }

    let current = visibleTextRef.current;
    if (!text.startsWith(current)) {
      current = '';
      visibleTextRef.current = '';
      setVisibleText('');
    }
    const characters = Array.from(text);
    let index = Array.from(current).length;
    const remaining = characters.length - index;
    if (remaining <= 0) return undefined;

    // Keep each incoming chunk lively without allowing long progress messages
    // to trail the real execution state by more than roughly half a second.
    const charactersPerFrame = Math.max(1, Math.ceil(remaining / 20));
    let timer: ReturnType<typeof setInterval>;
    const reveal = () => {
      index = Math.min(characters.length, index + charactersPerFrame);
      const next = characters.slice(0, index).join('');
      visibleTextRef.current = next;
      setVisibleText(next);
      if (index >= characters.length) clearInterval(timer);
    };
    timer = setInterval(reveal, 24);
    reveal();
    return () => clearInterval(timer);
  }, [active, text]);

  const typing = active && visibleText !== text;
  const Tag = as;
  return (
    <Tag className={`${className}${className ? ' ' : ''}typewriter-text${typing ? ' typing' : ''}`}>
      <span className="typewriter-copy">{!typing && completeContent ? completeContent : visibleText}</span>
      {typing && showCaret && <i className="typewriter-caret" aria-hidden="true" />}
    </Tag>
  );
}

export function SidebarIcon({ name }: { name: SidebarIconName }) {
  if (name === 'plus') {
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
  }
  if (name === 'search') {
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m14.7 14.7 4.8 4.8" /></svg>;
  }
  if (name === 'panel-open') {
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15m4-10 3 2.5-3 2.5" /></svg>;
  }
  return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15m7-10-3 2.5 3 2.5" /></svg>;
}

export function DownloadIndicator({
  download,
  onCancel,
}: {
  download: FileDownloadState | null;
  onCancel: () => void;
}) {
  if (!download) return null;
  const progress = download.size > 0 ? Math.min(100, Math.round(download.received / download.size * 100)) : 0;
  return (
    <div className="download-status" role="status" aria-live="polite">
      <span>{t(`正在下载 ${download.name}`, `Downloading ${download.name}`)}</span>
      <strong>{download.size > 0 ? `${progress}%` : t('准备中', 'Preparing')}</strong>
      <progress value={download.received} max={Math.max(1, download.size)} />
      <button type="button" onClick={onCancel}>{t('取消下载', 'Cancel download')}</button>
    </div>
  );
}

export function MessageBubble({
  item,
  active = false,
  imageSource,
  onDownloadFile,
  onReadVisualization,
}: {
  item: TimelineItem;
  active?: boolean;
  imageSource?: string;
  onDownloadFile: (path: string) => void;
  onReadVisualization: (path: string) => Promise<string>;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [imageExpanded, setImageExpanded] = useState(false);
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const [visualizationSource, setVisualizationSource] = useState('');
  const [visualizationStatus, setVisualizationStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [summarySettling, setSummarySettling] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summarySettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousCompletion = useRef<TimelineItem['completedAt']>(null);
  const visualizationHistoryEntry = useRef(false);
  const copyable = item.kind === 'user' || item.kind === 'assistant';

  useEffect(() => {
    setCopyState('idle');
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, [item.text]);

  useEffect(() => {
    const previous = previousCompletion.current;
    previousCompletion.current = item.completedAt;
    if (item.kind !== 'assistant' || !active || !item.completedAt || item.completedAt === previous) return;
    setSummarySettling(true);
    if (summarySettleTimer.current) clearTimeout(summarySettleTimer.current);
    summarySettleTimer.current = setTimeout(() => setSummarySettling(false), 560);
  }, [active, item.completedAt, item.kind]);

  useEffect(() => () => {
    if (summarySettleTimer.current) clearTimeout(summarySettleTimer.current);
  }, []);

  useEffect(() => {
    setImageExpanded(false);
  }, [item.attachment?.path]);

  useEffect(() => {
    setVisualizationOpen(false);
    clearVisualizationSource();
    setVisualizationStatus('idle');
  }, [item.visualization?.path]);

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
    setVisualizationSource((current) => {
      if (current.startsWith('blob:')) URL.revokeObjectURL(current);
      return '';
    });
  }

  async function openVisualization() {
    if (!item.visualization || visualizationStatus === 'loading') return;
    if (visualizationSource) {
      showVisualization();
      return;
    }
    setVisualizationStatus('loading');
    try {
      const previewUrl = await onReadVisualization(item.visualization.path);
      setVisualizationSource(previewUrl);
      setVisualizationStatus('idle');
      showVisualization();
    } catch {
      setVisualizationStatus('failed');
    }
  }

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

  if (item.kind === 'progress') {
    return (
      <details className={`progress-card${active ? ' live' : ''}`} open>
        <summary>{t('进度更新', 'Progress update')}</summary>
        <pre><TypewriterText text={item.text} active={active} /></pre>
      </details>
    );
  }
  const copyLabel = copyState === 'copied'
    ? t('已复制', 'Copied')
    : copyState === 'failed'
      ? t('复制失败', 'Copy failed')
      : t('复制消息', 'Copy message');
  const completedDateTime = dateTimeValue(item.completedAt);
  return (
    <div className={`message ${item.kind}${copyable ? ' copyable' : ''}${active ? ' live' : ''}${summarySettling ? ' settling' : ''}`}>
      {item.contexts?.length ? (
        <div className="message-contexts" aria-label={t('消息来源', 'Message context')}>
          {item.contexts.map((context, index) => {
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
      ) : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
            if (item.attachment?.path === localPath) return null;
            return (
              <a href={src} onClick={(event) => {
                event.preventDefault();
                onDownloadFile(localPath);
              }}>{alt || localFileName(localPath)}</a>
            );
          },
        }}
      >
        {item.text}
      </ReactMarkdown>
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
          <img
            src={imageSource}
            alt={item.attachment.name}
            onClick={(event) => event.stopPropagation()}
          />
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
      {copyable && (
        <div className="message-meta">
          {item.completedAt && completedDateTime && (
            <time className="message-time" dateTime={completedDateTime}>{formatDate(item.completedAt)}</time>
          )}
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
      )}
    </div>
  );
}
