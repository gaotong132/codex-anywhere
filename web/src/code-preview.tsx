import { useEffect, useState } from 'react';

type HighlightRuntime = {
  highlighter: (typeof import('highlight.js/lib/common'))['default'];
  purifier: (typeof import('dompurify'))['default'];
};

type HighlightState =
  | { source: string; language: string; status: 'plain'; html: '' }
  | { source: string; language: string; status: 'loading'; html: '' }
  | { source: string; language: string; status: 'ready'; html: string };

const MAX_HIGHLIGHT_CHARACTERS = 512 * 1024;
let runtimePromise: Promise<HighlightRuntime> | undefined;

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
  const canHighlight = normalizedLanguage !== 'plaintext'
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
