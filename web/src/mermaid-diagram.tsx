import { useEffect, useState } from 'react';
import { t } from './i18n';

type MermaidPreviewState =
  | { status: 'loading'; url: '' }
  | { status: 'ready'; url: string }
  | { status: 'failed'; url: '' };

type MermaidApi = (typeof import('mermaid'))['default'];

let mermaidLoad: Promise<MermaidApi> | undefined;
let diagramSequence = 0;

export function isMermaidCodeClass(className: unknown) {
  return typeof className === 'string'
    && className.split(/\s+/).some((value) => value.toLowerCase() === 'language-mermaid');
}

function loadMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: 50_000,
        maxEdges: 500,
        theme: 'dark',
      });
      return mermaid;
    }).catch((error: unknown) => {
      mermaidLoad = undefined;
      throw error;
    });
  }
  return mermaidLoad;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [preview, setPreview] = useState<MermaidPreviewState>({ status: 'loading', url: '' });

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const diagramId = `codex-anywhere-mermaid-${++diagramSequence}`;
    setPreview({ status: 'loading', url: '' });

    void loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, source))
      .then(({ svg }) => {
        objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = '';
          return;
        }
        setPreview({ status: 'ready', url: objectUrl });
      })
      .catch(() => {
        if (active) setPreview({ status: 'failed', url: '' });
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  if (preview.status === 'ready') {
    return (
      <figure className="mermaid-diagram ready">
        <img src={preview.url} alt={t('Mermaid 图表', 'Mermaid diagram')} />
      </figure>
    );
  }

  if (preview.status === 'failed') {
    return (
      <figure className="mermaid-diagram failed">
        <figcaption>{t('Mermaid 图表渲染失败，已显示源代码。', 'Mermaid rendering failed; showing the source.')}</figcaption>
        <pre><code>{source}</code></pre>
      </figure>
    );
  }

  return (
    <figure className="mermaid-diagram loading" aria-busy="true">
      <figcaption>{t('正在渲染 Mermaid 图表…', 'Rendering Mermaid diagram…')}</figcaption>
    </figure>
  );
}
