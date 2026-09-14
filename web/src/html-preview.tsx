import { useEffect, useRef, useState } from 'react';
import { CodePreview } from './code-preview';
import { t } from './i18n';
import { localFilePathFromHref, localFilePathFromRelativeHref } from './file-utils';

export function isHtmlFilePath(path: string) {
  return /\.html?$/i.test(path);
}

export function prepareHtmlPreview(source: string, path: string) {
  const document = new DOMParser().parseFromString(source, 'text/html');
  const links: string[] = [], images: string[] = [];
  document.querySelectorAll('[data-anywhere-link], [data-anywhere-image]').forEach(element => {
    element.removeAttribute('data-anywhere-link'); element.removeAttribute('data-anywhere-image');
  });
  document.querySelectorAll('base').forEach(element => element.remove());
  const resolve = (href: string | null) => localFilePathFromHref(href || '') || localFilePathFromRelativeHref(href || '', path);
  document.querySelectorAll('a[href]').forEach(link => {
    const target = resolve(link.getAttribute('href'));
    if (!target || links.length >= 200) return;
    link.setAttribute('data-anywhere-link', String(links.length));
    link.setAttribute('href', '#'); links.push(target);
  });
  document.querySelectorAll('img[src]').forEach(img => {
    const target = resolve(img.getAttribute('src'));
    if (!target || !/\.(png|jpe?g|webp)$/i.test(target) || images.length >= 100) return;
    img.setAttribute('data-anywhere-image', String(images.length));
    img.removeAttribute('src'); img.removeAttribute('srcset'); images.push(target);
  });
  return { html: '<!doctype html>' + document.documentElement.outerHTML, links, images };
}

type HtmlPreviewProps = { source: string; name: string; path: string; onOpen: (path: string) => void; onReadImage?: (path: string) => Promise<string> };

function HtmlDocument({ source, name, path, onOpen, onReadImage }: HtmlPreviewProps) {
  const sent = useRef(false);
  const [failed, setFailed] = useState(false);
  const portRef = useRef<MessagePort | null>(null);
  useEffect(() => () => { portRef.current?.close(); portRef.current = null; }, []);
  if (failed) return <div className="markdown-preview-state failed">{t('网页预览失败，可查看源码或下载文件。', 'Page preview failed; view the source or download the file.')}</div>;
  return <iframe src="/html-preview" title={name} sandbox="allow-scripts" referrerPolicy="no-referrer"
    onLoad={(event) => {
      // document.close() fires another load, and the document may navigate.
      // Never send private file contents to a subsequent document.
      if (sent.current) return;
      sent.current = true;
      let prepared: ReturnType<typeof prepareHtmlPreview>;
      try {
        prepared = prepareHtmlPreview(source, path);
        if (prepared.html.length > 4 * 1024 * 1024) throw new Error('html_preview_too_large');
      } catch { setFailed(true); return; }
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      const requested = new Set<number>();
      const queue: number[] = [];
      let active = 0, bytes = 0;
      const drain = () => {
        while (active < 3 && queue.length && bytes < 32 * 1024 * 1024 && portRef.current === channel.port1) {
          const id = queue.shift()!; active++;
          void onReadImage!(prepared.images[id]).then(url => {
            bytes += url.length;
            if (portRef.current === channel.port1 && bytes <= 32 * 1024 * 1024) channel.port1.postMessage({ type: 'image', id, url });
          }).catch(() => undefined).finally(() => { active--; drain(); });
        }
      };
      channel.port1.onmessage = (event) => {
        const id = event.data?.id;
        if (!Number.isInteger(id) || id < 0) return;
        if (event.data.type === 'link' && prepared.links[id]) onOpen(prepared.links[id]);
        if (event.data.type === 'image' && onReadImage && prepared.images[id] && !requested.has(id)) {
          requested.add(id); queue.push(id); drain();
        }
      };
      event.currentTarget.contentWindow?.postMessage({ type: 'anywhere.html-preview', html: prepared.html }, '*', [channel.port2]);
    }} />;
}

export function HtmlPreview(props: HtmlPreviewProps) {
  const [showSource, setShowSource] = useState(false);
  return <section className="html-preview" aria-label={t('HTML 预览', 'HTML preview')}>
    <div className="html-preview-toolbar">
      <button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{t('网页', 'Page')}</button>
      <button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>{t('源码', 'Source')}</button>
    </div>
    {showSource ? <CodePreview content={props.source} language="xml" /> : <HtmlDocument {...props} />}
  </section>;
}
