import { useEffect, useMemo, useState } from 'react';
import { t } from './i18n';

type HighlightRuntime = {
  highlighter: (typeof import('highlight.js/lib/common'))['default'];
  purifier: (typeof import('dompurify'))['default'];
};

type HighlightState =
  | { source: string; language: string; status: 'plain'; html: '' }
  | { source: string; language: string; status: 'loading'; html: '' }
  | { source: string; language: string; status: 'ready'; html: string };

const MAX_HIGHLIGHT_CHARACTERS = 512 * 1024;
const MAX_DECORATED_DIFF_LINES = 2_000;
let runtimePromise: Promise<HighlightRuntime> | undefined;

export type DiffPreviewLine = {
  kind: 'file' | 'path-old' | 'path-new' | 'hunk' | 'addition' | 'deletion' | 'context' | 'meta';
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export function parseUnifiedDiffLines(content: string): DiffPreviewLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let inHunk = false;
  const rows = String(content || '').replace(/\r\n/g, '\n').split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows.map((text) => {
    if (text.startsWith('diff --git ')) {
      oldLine = null;
      newLine = null;
      inHunk = false;
      return { kind: 'file', text, oldLine: null, newLine: null };
    }
    if (!inHunk && text.startsWith('--- ')) return { kind: 'path-old', text, oldLine: null, newLine: null };
    if (!inHunk && text.startsWith('+++ ')) return { kind: 'path-new', text, oldLine: null, newLine: null };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: 'hunk', text, oldLine: null, newLine: null };
    }
    if (text.startsWith('+')) {
      const line = newLine;
      if (newLine !== null) newLine += 1;
      return { kind: 'addition', text, oldLine: null, newLine: line };
    }
    if (text.startsWith('-')) {
      const line = oldLine;
      if (oldLine !== null) oldLine += 1;
      return { kind: 'deletion', text, oldLine: line, newLine: null };
    }
    if (text.startsWith(' ') && oldLine !== null && newLine !== null) {
      const row = { kind: 'context' as const, text, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return row;
    }
    return { kind: 'meta', text, oldLine: null, newLine: null };
  });
}

function diffFileLabel(value: string) {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(value);
  return match?.[2] || value.replace(/^diff --git\s+/, '');
}

function diffDisplayText(line: DiffPreviewLine) {
  if (line.kind === 'addition' || line.kind === 'deletion' || line.kind === 'context') {
    return line.text.slice(1) || ' ';
  }
  return line.text || ' ';
}

function isVisibleDiffLine(line: DiffPreviewLine) {
  return line.kind === 'file'
    || line.kind === 'addition'
    || line.kind === 'deletion'
    || line.kind === 'context';
}

function loadHighlightRuntime() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import('highlight.js/lib/common'),
      import('dompurify'),
    ]).then(([highlightModule, purifierModule]) => ({
      highlighter: highlightModule.default,
      purifier: purifierModule.default,
    })).catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}

export function CodePreview({ content, language }: { content: string; language: string }) {
  const normalizedLanguage = String(language || 'plaintext').toLowerCase();
  const [wrapDiffLines, setWrapDiffLines] = useState(true);
  const diffLines = useMemo(
    () => normalizedLanguage === 'diff' ? parseUnifiedDiffLines(content) : [],
    [content, normalizedLanguage],
  );
  const decoratedDiff = normalizedLanguage === 'diff' && diffLines.length <= MAX_DECORATED_DIFF_LINES;
  const canHighlight = normalizedLanguage !== 'plaintext'
    && !decoratedDiff
    && content.length <= MAX_HIGHLIGHT_CHARACTERS;
  const [highlight, setHighlight] = useState<HighlightState>({
    source: content,
    language: normalizedLanguage,
    status: canHighlight ? 'loading' : 'plain',
    html: '',
  });

  useEffect(() => {
    let active = true;
    if (!canHighlight) {
      setHighlight({ source: content, language: normalizedLanguage, status: 'plain', html: '' });
      return () => { active = false; };
    }
    setHighlight({ source: content, language: normalizedLanguage, status: 'loading', html: '' });
    void loadHighlightRuntime().then(({ highlighter, purifier }) => {
      if (!highlighter.getLanguage(normalizedLanguage)) {
        if (active) setHighlight({ source: content, language: normalizedLanguage, status: 'plain', html: '' });
        return;
      }
      const highlighted = highlighter.highlight(content, {
        language: normalizedLanguage,
        ignoreIllegals: true,
      }).value;
      const sanitized = purifier.sanitize(highlighted, {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class'],
        RETURN_TRUSTED_TYPE: false,
      });
      if (active) setHighlight({
        source: content, language: normalizedLanguage, status: 'ready', html: sanitized,
      });
    }).catch(() => {
      if (active) setHighlight({ source: content, language: normalizedLanguage, status: 'plain', html: '' });
    });
    return () => { active = false; };
  }, [canHighlight, content, normalizedLanguage]);

  const current = highlight.source === content && highlight.language === normalizedLanguage ? highlight : {
    source: content,
    language: normalizedLanguage,
    status: canHighlight ? 'loading' as const : 'plain' as const,
    html: '',
  };
  if (decoratedDiff) {
    return (
      <section
        className={`code-file-preview diff-file-preview${wrapDiffLines ? ' wrap-lines' : ''}`}
        aria-label={t('代码变更', 'Code changes')}
      >
        <div className="code-file-preview-language diff-preview-toolbar">
          <span>{t('统一 Diff', 'Unified diff')}</span>
          <span className="diff-preview-actions">
            <span className="diff-preview-legend" aria-hidden="true">
              <i className="addition" />{t('新增', 'Added')}
              <i className="deletion" />{t('删除', 'Deleted')}
            </span>
            <button
              type="button"
              className="diff-wrap-toggle"
              aria-pressed={wrapDiffLines}
              title={t(wrapDiffLines ? '关闭自动换行' : '开启自动换行', wrapDiffLines ? 'Disable wrapping' : 'Enable wrapping')}
              onClick={() => setWrapDiffLines((enabled) => !enabled)}
            >
              <span aria-hidden="true">↵</span>{t('自动换行', 'Wrap')}
            </button>
          </span>
        </div>
        <div className="diff-preview-grid" role="table">
          {diffLines.filter(isVisibleDiffLine).map((line, index) => line.kind === 'file'
            ? (
              <div className="diff-file-row" role="row" key={`${index}:${line.text}`} title={line.text}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 3h7l4 4v14H7zM14 3v5h5M10 13h5M10 17h5" />
                </svg>
                <span className="diff-file-path" role="cell">{diffFileLabel(line.text)}</span>
              </div>
            )
            : (
              <div className={`diff-line ${line.kind}`} role="row" key={`${index}:${line.text}`}>
                <span className="diff-line-number old" role="cell">{line.oldLine ?? ''}</span>
                <span className="diff-line-number new" role="cell">{line.newLine ?? ''}</span>
                <code role="cell">{diffDisplayText(line)}</code>
              </div>
            ))}
        </div>
      </section>
    );
  }
  return (
    <section className="code-file-preview" aria-label={`${normalizedLanguage} code`}>
      <div className="code-file-preview-language">{normalizedLanguage}</div>
      <pre>
        {current.status === 'ready'
          ? <code className={`hljs language-${normalizedLanguage}`} dangerouslySetInnerHTML={{ __html: current.html }} />
          : <code>{content}</code>}
      </pre>
    </section>
  );
}
