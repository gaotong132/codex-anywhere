import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localFilePathFromHref } from './file-utils';
import { t } from './i18n';
import type { TimelineItem } from './history-utils';
import type { FileDownloadState } from './app-types';

type SidebarIconName = 'plus' | 'search' | 'panel-open' | 'panel-close';

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
  if (item.kind === 'progress') {
    return (
      <details className="progress-card" open>
        <summary>{t('进度更新', 'Progress update')}</summary>
        <pre>{item.text}</pre>
      </details>
    );
  }
  return (
    <div className={`message ${item.kind}`}>
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
        }}
      >
        {item.text}
      </ReactMarkdown>
      {item.attachment && imageSource !== '' && (
        <figure className="message-image">
          {imageSource === undefined && <div className="message-image-state">{t('正在加载图片…', 'Loading image…')}</div>}
          {imageSource === '' && <div className="message-image-state">{t('图片已过期或无法读取', 'Image expired or unavailable')}</div>}
          {imageSource && (
            <a href={imageSource} target="_blank" rel="noreferrer noopener" aria-label={t('查看原图', 'View full image')}>
              <img src={imageSource} alt={item.attachment.name} loading="lazy" />
            </a>
          )}
          <figcaption>{item.attachment.name}</figcaption>
        </figure>
      )}
    </div>
  );
}
