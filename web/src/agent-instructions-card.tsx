import { useEffect, useId, useState } from 'react';
import type { AgentInstructions } from '../../src/shared/agent-instructions';
import type { TextPreviewDocument } from './app-types';
import { MessageMarkdown } from './message-markdown';
import { t } from './i18n';

export function AgentInstructionsCard({ instructions, onDownloadFile, onReadTextFile }: {
  instructions: AgentInstructions;
  onDownloadFile: (path: string) => void;
  onReadTextFile?: (path: string) => Promise<TextPreviewDocument>;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [instructions.body, instructions.scope]);
  const contentId = useId();
  const title = /^#[ \t]+([^\r\n]+)$/m.exec(instructions.body)?.[1] || t('项目指令', 'Agent instructions');
  const sections = [...instructions.body.matchAll(/^##[ \t]+[^\r\n]+/gm)].length;
  return <section className="agent-instructions-card" aria-label={t('AGENTS.md 指令', 'AGENTS.md instructions')}>
    <button className="agent-instructions-toggle" type="button" aria-expanded={expanded} aria-controls={expanded ? contentId : undefined}
      onClick={() => setExpanded(value => !value)}>
      <svg className="agent-instructions-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H6V3h1m7 0v5h4M9 12h6m-6 4h6" /></svg>
      <span className="agent-instructions-heading">
        <strong title={title}>{title}</strong>
        <small>AGENTS.md{sections > 0 ? t(` · ${sections} 个章节`, ` · ${sections} sections`) : ''}</small>
      </span>
      <span className="agent-instructions-action">{expanded ? t('收起', 'Collapse') : t('展开', 'Expand')}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
      </span>
    </button>
    {expanded && <div className="agent-instructions-body" id={contentId} tabIndex={0} role="region" aria-label={t('指令内容', 'Instruction contents')}>
      {instructions.scope && <p className="agent-instructions-scope">{instructions.scope}</p>}
      <MessageMarkdown text={instructions.body} onDownloadFile={onDownloadFile} onReadTextFile={onReadTextFile} />
    </div>}
  </section>;
}
