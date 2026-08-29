import { useEffect, useRef, useState } from 'react';
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
  imageSource,
  onDownloadFile,
}: {
  item: TimelineItem;
  imageSource?: string;
  onDownloadFile: (path: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyable = item.kind === 'user' || item.kind === 'assistant';

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

  if (item.kind === 'progress') {
    return (
      <details className="progress-card" open>
        <summary>{t('进度更新', 'Progress update')}</summary>
        <pre>{item.text}</pre>
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
    <div className={`message ${item.kind}${copyable ? ' copyable' : ''}`}>
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
            <a href={imageSource} target="_blank" rel="noreferrer noopener" aria-label={t('查看图片预览', 'View image preview')}>
              <img src={imageSource} alt={item.attachment.name} loading="lazy" />
            </a>
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
