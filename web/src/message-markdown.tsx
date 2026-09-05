import { isValidElement, memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localFileName, localFilePathFromHref, localFilePathFromRelativeHref } from './file-utils';
import { isSvgCodeClass, isSvgFilePath, LocalSvgImage, SvgPreview } from './svg-preview';
import { isMermaidCodeClass, MermaidDiagram } from './mermaid-diagram';
import type { TextPreviewDocument } from './app-types';

const markdownPlugins = [remarkGfm];

function messageUrlTransform(url: string) {
  return localFilePathFromHref(url) ? url : defaultUrlTransform(url);
}

export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  attachmentPath,
  basePath,
  onDownloadFile,
  onReadTextFile,
}: {
  text: string;
  attachmentPath?: string;
  basePath?: string;
  onDownloadFile: (path: string) => void;
  onReadTextFile?: (path: string) => Promise<TextPreviewDocument>;
}) {
  const components = useMemo<Components>(() => ({
    pre: ({ node: _node, children, ...props }) => {
      const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
        && children.type === 'code' ? children : null;
      if (code && isMermaidCodeClass(code.props.className)) {
        const source = String(code.props.children ?? '').replace(/\n$/, '');
        return <MermaidDiagram source={source} />;
      }
      if (code && isSvgCodeClass(code.props.className)) {
        return <SvgPreview source={String(code.props.children ?? '').replace(/\n$/, '')} />;
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
      if (isSvgFilePath(localPath) && onReadTextFile) {
        return <LocalSvgImage path={localPath} name={alt || localFileName(localPath)}
          onRead={onReadTextFile} onOpen={onDownloadFile} />;
      }
      return (
        <a href={src} onClick={(event) => {
          event.preventDefault();
          onDownloadFile(localPath);
        }}>{alt || localFileName(localPath)}</a>
      );
    },
  }), [attachmentPath, basePath, onDownloadFile, onReadTextFile]);
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
