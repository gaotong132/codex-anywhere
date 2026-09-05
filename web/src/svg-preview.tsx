import { useEffect, useState } from 'react';
import { CodePreview } from './code-preview';
import { t } from './i18n';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function isSvgFilePath(path: string) {
  return /\.svg$/i.test(path);
}

export function isSvgCodeClass(className?: string) {
  return /(?:^|\s)language-svg(?:\s|$)/i.test(className || '');
}

export function svgImageDocument(source: string) {
  if (new Blob([source]).size > 2 * 1024 * 1024 || source.includes('\0') || /<!ENTITY\b/i.test(source)) {
    throw new Error('svg_content_invalid');
  }
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (document.querySelector('parsererror') || root?.localName !== 'svg'
    || (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE)) throw new Error('svg_content_invalid');
  if (!root.namespaceURI) root.setAttribute('xmlns', SVG_NAMESPACE);
  // Only load this document as an image. Never insert it into the application DOM
  // or navigate to it: the image context disables scripts and external resources.
  return new XMLSerializer().serializeToString(root);
}

export function SvgImage({ source, alt }: { source: string; alt: string }) {
  const [image, setImage] = useState<{ source: string; url: string } | null>(null);
  useEffect(() => {
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([svgImageDocument(source)], { type: 'image/svg+xml' }));
    } catch { /* Keep the source and download available for malformed SVGs. */ }
    setImage({ source, url });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [source]);
  if (image?.source !== source) return <span role="status">{t('正在渲染 SVG…', 'Rendering SVG…')}</span>;
  if (!image.url) return <span role="status">{t('SVG 预览失败，可查看源码或下载文件。', 'SVG preview failed; view the source or download the file.')}</span>;
  return <img className="svg-preview-image" src={image.url} alt={alt} onError={() => {
    setImage((current) => current?.url === image.url ? { source, url: '' } : current);
  }} />;
}

export function SvgPreview({ source, name = 'SVG' }: { source: string; name?: string }) {
  const [showSource, setShowSource] = useState(false);
  return (
    <section className="svg-preview" aria-label={t('SVG 预览', 'SVG preview')}>
      <div className="svg-preview-toolbar">
        <span>{name}</span>
        <button type="button" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{t('图形', 'Image')}</button>
        <button type="button" aria-pressed={showSource} onClick={() => setShowSource(true)}>{t('源码', 'Source')}</button>
      </div>
      {showSource ? <CodePreview content={source} language="xml" />
        : <div className="svg-preview-canvas"><SvgImage source={source} alt={name} /></div>}
    </section>
  );
}

export function LocalSvgImage({ path, name, onRead, onOpen }: {
  path: string;
  name: string;
  onRead: (path: string) => Promise<{ content: string }>;
  onOpen: (path: string) => void;
}) {
  const [document, setDocument] = useState<{ path: string; content?: string } | null>(null);
  useEffect(() => {
    let active = true;
    setDocument(null);
    void onRead(path).then(({ content }) => {
      if (active) setDocument({ path, content });
    }).catch(() => { if (active) setDocument({ path }); });
    return () => { active = false; };
  }, [path, onRead]);
  return (
    <a className="local-svg-image" href={path} onClick={(event) => { event.preventDefault(); onOpen(path); }}>
      {document?.path === path && document.content !== undefined
        ? <SvgImage source={document.content} alt={name} />
        : <span>{name} · {document?.path === path ? t('点击重试预览', 'Retry preview') : t('加载中…', 'Loading…')}</span>}
    </a>
  );
}
