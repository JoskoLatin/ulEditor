import { t } from '@uleditor/i18n';

import type { Shell } from '../../../host/index.js';
import { answer, useQuestions } from '../../common/questions.js';

/**
 * The shell's questions, drawn as Arak's own sheet above the keyboard.
 *
 * None of the prototypes drew them (ADR 0009, "What the matrix added", 4), so
 * this is Arak's answer: a sheet of paper on the keyboard's top edge, edged in
 * the stamp's ink like *crta*, over a dimmed desk. The question and its answers
 * are the shell's (`shell.notify`): unsaved work on Odloži, formatting a save
 * would lose, a file changed outside. A tap runs the answer as the desktop's
 * toast does; Back runs the one marked as the cancel, never the first in the
 * list (`questions.ts`, `history.ts`), and a question with no cancel stays.
 *
 * The cancel is drawn as the quiet answer, the last of the others as the main
 * one, whatever their order. Notices, which only tell, come below with an OK.
 */
export function Questions({ shell }: { shell: Shell }) {
  const { questions, notices } = useQuestions(shell);
  if (questions.length === 0 && notices.length === 0) return null;

  return (
    <>
      {questions.length > 0 && <div className="arak-scrim" aria-hidden="true" />}
      <div className="arak-questions">
        {questions.map((question) => {
          const main = question.actions.findLastIndex((action) => action.cancel !== true);
          return (
            <section
              key={question.id}
              className="arak-question"
              role="alertdialog"
              aria-label={question.message}
              data-ul-role="question"
              data-level={question.level}
            >
              <p>{question.message}</p>
              {question.details && question.details.length > 0 && (
                <ul>
                  {question.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
              <div className="arak-question-actions">
                {question.actions.map((action, index) => (
                  <button
                    key={`${index}:${action.label}`}
                    className={`arak-pill ${index === main ? 'main' : 'second'}`}
                    data-ul-role="question-action"
                    data-cancel={action.cancel ? 'true' : undefined}
                    onClick={() => answer(question, index)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {notices.map((notice) => (
          <section key={notice.id} className="arak-question notice" role="status" data-ul-role="notice" data-level={notice.level}>
            <p>{notice.message}</p>
            <div className="arak-question-actions">
              <button className="arak-pill second" data-ul-role="notice-dismiss" onClick={() => shell.notify.dismiss(notice.id)}>
                {t('OK')}
              </button>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
