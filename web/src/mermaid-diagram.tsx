import { useEffect, useState } from 'react';
import { t } from './i18n';

type MermaidPreviewState =
  | { status: 'loading'; svg: '' }
  | { status: 'ready'; svg: string }
  | { status: 'failed'; svg: '' };

type MermaidApi = (typeof import('mermaid'))['default'];
type DomPurifyApi = (typeof import('dompurify'))['default'];
type MermaidRuntime = { mermaid: MermaidApi; purifier: DomPurifyApi };

let mermaidLoad: Promise<MermaidRuntime> | undefined;
let diagramSequence = 0;

export function isMermaidCodeClass(className: unknown) {
  return typeof className === 'string'
    && className.split(/\s+/).some((value) => value.toLowerCase() === 'language-mermaid');
}

function loadMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = Promise.all([import('mermaid'), import('dompurify')]).then(([
      { default: mermaid }, { default: purifier },
    ]) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: 50_000,
        maxEdges: 500,
        theme: 'dark',
      });
      return { mermaid, purifier };
    }).catch((error: unknown) => {
      mermaidLoad = undefined;
      throw error;
    });
  }
  return mermaidLoad;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [preview, setPreview] = useState<MermaidPreviewState>({ status: 'loading', svg: '' });

  useEffect(() => {
    let active = true;
    const diagramId = `codex-anywhere-mermaid-${++diagramSequence}`;
    setPreview({ status: 'loading', svg: '' });

    void loadMermaid()
      .then(async ({ mermaid, purifier }) => {
        const { svg } = await mermaid.render(diagramId, source);
        const sanitizedSvg = purifier.sanitize(svg, {
          ADD_TAGS: ['foreignobject'],
          ADD_ATTR: ['dominant-baseline'],
          HTML_INTEGRATION_POINTS: { foreignobject: true },
          RETURN_TRUSTED_TYPE: false,
        });
        if (!/^\s*<svg(?:\s|>)/i.test(sanitizedSvg)) throw new Error('mermaid_svg_invalid');
        return sanitizedSvg;
      })
      .then((svg) => {
        if (active) setPreview({ status: 'ready', svg });
      })
      .catch(() => {
        if (active) setPreview({ status: 'failed', svg: '' });
      });

    return () => {
      active = false;
    };
  }, [source]);

  if (preview.status === 'ready') {
    return (
      <figure className="mermaid-diagram ready">
        <div
          className="mermaid-diagram-svg"
          role="img"
          aria-label={t('Mermaid 图表', 'Mermaid diagram')}
          dangerouslySetInnerHTML={{ __html: preview.svg }}
        />
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
