import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate } from './app-utils';
import { localFileName, localFilePathFromHref } from './file-utils';
import { t } from './i18n';
import type { TimelineItem } from './history-utils';
import type { FileDownloadState } from './app-types';

type SidebarIconName = 'plus' | 'search' | 'panel-open' | 'panel-close';

export type CustomSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
}: {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  const openMenu = (index = selectedIndex) => {
    if (disabled || !options.length) return;
    setActiveIndex(index);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const move = (offset: number) => {
    if (!options.length) return;
    setActiveIndex((current) => (current + offset + options.length) % options.length);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      openMenu(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className={`custom-select${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        title={selected?.label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span>{selected?.label || ''}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="custom-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              id={`${listboxId}-${index}`}
              key={option.value}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === selectedIndex}
              className={`custom-select-option${index === activeIndex ? ' active' : ''}${index === selectedIndex ? ' selected' : ''}`}
              title={option.label}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {index === selectedIndex && <i aria-hidden="true">✓</i>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function dateTimeValue(value: TimelineItem['completedAt']) {
  if (!value) return '';
  const numeric = typeof value === 'number' && value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

type MessageCopyState = 'idle' | 'copied' | 'failed';

function MessageMetadata({
  item,
  copyState,
  onCopy,
}: {
  item: TimelineItem;
  copyState: MessageCopyState;
  onCopy: () => void;
}) {
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
        onClick={onCopy}
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

export function TypewriterText({
  text,
  active,
  className = '',
  as = 'span',
  showCaret = true,
  completeContent,
  durationMs = 480,
  onComplete,
}: {
  text: string;
  active: boolean;
  className?: string;
  as?: 'span' | 'strong';
  showCaret?: boolean;
  completeContent?: ReactNode;
  durationMs?: number;
  onComplete?: () => void;
}) {
  const [visibleText, setVisibleText] = useState(active ? '' : text);
  const visibleTextRef = useRef(visibleText);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!active || reduceMotion) {
      visibleTextRef.current = text;
      setVisibleText(text);
      onCompleteRef.current?.();
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
    if (remaining <= 0) {
      onCompleteRef.current?.();
      return undefined;
    }

    const frameMs = 30;
    const frameCount = Math.max(1, Math.round(durationMs / frameMs));
    const charactersPerFrame = Math.max(1, Math.ceil(remaining / frameCount));
    let timer: ReturnType<typeof setInterval>;
    const reveal = () => {
      index = Math.min(characters.length, index + charactersPerFrame);
      const next = characters.slice(0, index).join('');
      visibleTextRef.current = next;
      setVisibleText(next);
      if (index >= characters.length) {
        clearInterval(timer);
        onCompleteRef.current?.();
      }
    };
    timer = setInterval(reveal, frameMs);
    reveal();
    return () => clearInterval(timer);
  }, [active, durationMs, text]);

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
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
  }
  return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>;
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
  const [copyState, setCopyState] = useState<MessageCopyState>('idle');
  const [imageExpanded, setImageExpanded] = useState(false);
  const [visualizationOpen, setVisualizationOpen] = useState(false);
  const [visualizationSource, setVisualizationSource] = useState('');
  const [visualizationStatus, setVisualizationStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualizationHistoryEntry = useRef(false);
  const copyable = item.kind === 'user' || item.kind === 'assistant';
  const finalReplyArriving = item.kind === 'assistant' && Boolean(item.transient && item.completedAt);

  useEffect(() => {
    setCopyState('idle');
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, [item.text]);

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
        <pre><TypewriterText className="progress-typewriter" text={item.text} active={active} durationMs={1_200} /></pre>
      </details>
    );
  }
  return (
    <div className={`message-block ${item.kind}${copyable ? ' copyable' : ''}`}>
      <div className={`message ${item.kind}${copyable ? ' copyable' : ''}${active ? ' live' : ''}${finalReplyArriving ? ' final-arriving' : ''}`}>
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
      </div>
      {copyable && (
        <MessageMetadata item={item} copyState={copyState} onCopy={() => void copyMessage()} />
      )}
    </div>
  );
}
