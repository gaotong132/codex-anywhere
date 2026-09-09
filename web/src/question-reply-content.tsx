import type { QuestionReply } from '../../src/shared/async-questions';
import type { TextPreviewDocument } from './app-types';
import { MessageMarkdown } from './message-markdown';
import { t } from './i18n';

export function QuestionReplyContent({ replies, onDownloadFile, onReadTextFile }: {
  replies: QuestionReply[];
  onDownloadFile: (path: string) => void;
  onReadTextFile?: (path: string) => Promise<TextPreviewDocument>;
}) {
  return <div className="question-replies">
    {replies.map((reply) => <section className="question-reply" key={reply.questionItemId}>
      <details className="question-reply-context">
        <summary>
          <span className="question-reply-heading">
            <span>{t('回复的问题', 'In reply to')}</span>
            <span className="question-reply-toggle">
              <span className="when-collapsed">{t('展开', 'Expand')}</span>
              <span className="when-expanded">{t('收起', 'Collapse')}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
            </span>
          </span>
        </summary>
        <div className="question-reply-full">{reply.question}</div>
      </details>
      <div className="question-reply-answer">
        <MessageMarkdown text={reply.answer} onDownloadFile={onDownloadFile} onReadTextFile={onReadTextFile} />
      </div>
    </section>)}
  </div>;
}
