import { useRef, useState } from 'react';
import type { AsyncQuestion, QuestionReply } from '../../src/shared/async-questions';
import { t } from './i18n';

export function AsyncQuestionCard({ questions, answers, disabled, onReply }: {
  questions: AsyncQuestion[];
  answers: ReadonlyMap<string, string>;
  disabled: boolean;
  onReply?: (replies: QuestionReply[]) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const pending = questions.filter((question) => !answers.has(question.id));
  const ready = pending.length > 0 && pending.every((question) => drafts[question.id]?.trim());

  async function submit() {
    if (!onReply || disabled || !ready || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const sent = await onReply(pending.map((question) => ({
        questionItemId: question.id, question: question.title, answer: drafts[question.id].trim(),
      })));
      setFailed(!sent);
    } catch { setFailed(true); }
    finally { inFlight.current = false; setSubmitting(false); }
  }

  return (
    <form className="async-question-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <strong>{pending.length ? t('需要你补充信息', 'Your input is requested') : t('已回答', 'Answered')}</strong>
      {questions.map((question) => {
        const answer = answers.get(question.id);
        return (
          <fieldset key={question.id} disabled={disabled || submitting || answer !== undefined}>
            <legend>{question.title}</legend>
            {answer !== undefined ? <p className="async-question-answer">{answer}</p> : <>
              {question.options.length > 0 && <div className="async-question-options">
                {question.options.map((option, index) => (
                  <label key={index}>
                    <input type="radio" name={question.id} value={option}
                      checked={drafts[question.id] === option}
                      onChange={() => setDrafts((current) => ({ ...current, [question.id]: option }))} />
                    <span>{option}</span>
                  </label>
                ))}
              </div>}
              <textarea rows={2} maxLength={16_000} value={drafts[question.id] || ''}
                aria-label={t(`回答：${question.title}`, `Answer: ${question.title}`)}
                placeholder={question.options.length ? t('也可以输入自己的回答', 'Or enter your own answer') : t('输入回答…', 'Enter your answer…')}
                onChange={(event) => setDrafts((current) => ({ ...current, [question.id]: event.target.value }))} />
            </>}
          </fieldset>
        );
      })}
      {pending.length > 0 && <div className="async-question-actions">
        {failed && <span role="alert">{t('回答未发送，请重试。', 'Answer was not sent. Please retry.')}</span>}
        <button type="submit" disabled={disabled || submitting || !ready || !onReply}>
          {submitting ? t('正在发送…', 'Sending…') : t('发送回答', 'Send answer')}
        </button>
      </div>}
    </form>
  );
}
