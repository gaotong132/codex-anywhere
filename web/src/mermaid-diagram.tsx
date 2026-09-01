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

export const mermaidThemeVariables = {
  darkMode: true,
  background: '#0c121c',
  primaryColor: '#1d3f66',
  primaryTextColor: '#f4f7fb',
  primaryBorderColor: '#79a8dc',
  secondaryColor: '#294f45',
  secondaryTextColor: '#f2fbf8',
  secondaryBorderColor: '#78baa9',
  tertiaryColor: '#18283d',
  tertiaryTextColor: '#e8f0fb',
  tertiaryBorderColor: '#5f7fa7',
  lineColor: '#a9c3e3',
  textColor: '#e7eef8',
  mainBkg: '#1d3f66',
  nodeBorder: '#79a8dc',
  clusterBkg: '#14243a',
  clusterBorder: '#547ba8',
  defaultLinkColor: '#a9c3e3',
  edgeLabelBackground: '#17263b',
  nodeTextColor: '#f4f7fb',
  noteBkgColor: '#263d5c',
  noteTextColor: '#f4f7fb',
  noteBorderColor: '#79a8dc',
  actorBkg: '#1d3f66',
  actorBorder: '#79a8dc',
  actorTextColor: '#f4f7fb',
  actorLineColor: '#8eadd2',
  signalColor: '#c5d7ec',
  signalTextColor: '#f4f7fb',
  labelBoxBkgColor: '#1d3f66',
  labelBoxBorderColor: '#79a8dc',
  labelTextColor: '#f4f7fb',
  loopTextColor: '#f4f7fb',
  activationBorderColor: '#78baa9',
  activationBkgColor: '#294f45',
  sequenceNumberColor: '#0c121c',
} as const;

type PresentationProperty = 'color' | 'fill' | 'stroke';

function hasInlineDeclaration(element: Element, property: PresentationProperty) {
  const style = element.getAttribute('style') ?? '';
  return new RegExp(`(?:^|;)\\s*${property}\\s*:`, 'i').test(style);
}

function setPresentationFallback(
  element: Element,
  property: PresentationProperty,
  value: string,
) {
  if (!element.hasAttribute(property) && !hasInlineDeclaration(element, property)) {
    element.setAttribute(property, value);
  }
}

function applyPresentationFallbacks(
  root: Element,
  selector: string,
  properties: Partial<Record<PresentationProperty, string>>,
) {
  root.querySelectorAll(selector).forEach((element) => {
    Object.entries(properties).forEach(([property, value]) => {
      if (value) setPresentationFallback(element, property as PresentationProperty, value);
    });
  });
}

/**
 * Some older Android/Huawei browsers render an inline SVG but ignore its embedded
 * stylesheet. Mermaid normally keeps nearly all of its colors in that stylesheet,
 * which makes the diagram fall back to black shapes and lines. Presentation
 * attributes are supported by those browsers and remain subordinate to author
 * styles, so add them only where Mermaid did not already emit an explicit value.
 */
export function applyMermaidPresentationFallback(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'text/html');
  const root = document.body.firstElementChild;
  if (!root || root.localName.toLowerCase() !== 'svg') {
    throw new Error('mermaid_svg_parse_failed');
  }

  const theme = mermaidThemeVariables;
  setPresentationFallback(root, 'color', theme.textColor);

  applyPresentationFallbacks(
    root,
    '.node rect, .node circle, .node ellipse, .node polygon, .node path, '
      + 'rect.actor, rect.actor-top, rect.actor-bottom, rect.labelBox, rect.entityBox, rect.classBox',
    { fill: theme.primaryColor, stroke: theme.primaryBorderColor },
  );
  applyPresentationFallbacks(
    root,
    '.cluster rect, .cluster polygon, .cluster path, .stateGroup rect',
    { fill: theme.clusterBkg, stroke: theme.clusterBorder },
  );
  applyPresentationFallbacks(
    root,
    '.note rect, rect.note, .activation0, .activation1, .activation2',
    { fill: theme.noteBkgColor, stroke: theme.noteBorderColor },
  );
  applyPresentationFallbacks(
    root,
    '.edgeLabel rect, .labelBkg, .edgeLabel .background',
    { fill: theme.edgeLabelBackground },
  );
  applyPresentationFallbacks(
    root,
    '.flowchart-link, .edgePaths path, .actor-line, .messageLine0, .messageLine1, '
      + '.loopLine, .relationshipLine, .transition, .edge-thickness-normal, '
      + '.edge-thickness-thick',
    { fill: 'none', stroke: theme.lineColor },
  );
  applyPresentationFallbacks(
    root,
    'marker path, marker polygon, .arrowheadPath',
    { fill: theme.lineColor, stroke: theme.lineColor },
  );
  applyPresentationFallbacks(
    root,
    'text, tspan, .nodeLabel, .edgeLabel, .label, .actor, .messageText, '
      + '.labelText, .loopText, .noteText, .cluster-label',
    { color: theme.primaryTextColor, fill: theme.primaryTextColor },
  );

  root.querySelectorAll('foreignObject, foreignObject *').forEach((element) => {
    if (!hasInlineDeclaration(element, 'color')) {
      const style = element.getAttribute('style');
      element.setAttribute(
        'style',
        `${style ? `${style.trim().replace(/;?$/, ';')} ` : ''}color: ${theme.primaryTextColor};`,
      );
    }
  });

  return root.outerHTML;
}

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
        theme: 'base',
        darkMode: true,
        themeVariables: mermaidThemeVariables,
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
        return applyMermaidPresentationFallback(sanitizedSvg);
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
