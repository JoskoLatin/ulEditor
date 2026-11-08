import { useCallback, useRef, useState } from 'react';
import { t } from '@uleditor/i18n';

import { closeTab, openUri, saveActive } from '../../shell/actions.js';
import { selectActiveTabId, useWorkspace } from '../../state/workspace.js';
import { DocumentStage } from './DocumentStage.js';
import { useFind } from './find.js';
import { closeLayer, isLayerOpen, openLayer, useLayers } from './history.js';
import { useLibraryView } from './library-view.js';
import type { InterfaceProps } from './MobileApp.js';
import { answer, useQuestions } from './questions.js';
import { useSwipe, type SwipeDirection } from './swipe.js';
import { ToolRow } from './ToolRow.js';

import './dev.css';

const FIND = 'find';
const TEST_LAYER = 'dev-layer';

/**
 * **The development view: not an interface, and not a design.**
 *
 * It stands in for Palac and Četiri boje until each is built (ADR 0009, K7 and
 * K8); Arak has been itself since K6a. It is here so that the shared layer can
 * be driven end to end apart from any interface: the library, a document on
 * `DocumentStage`, Back through `history`, the questions, `--kb-inset`, the
 * tool row and the swipe. It starts in a debug build only, as the whole mobile
 * shell does until Arak passes K6, and it goes when the last interface comes
 * in.
 *
 * Everything a check finds, it finds by a `data-ul-role` marker, as the
 * interfaces' drivers will (ADR 0009, "Testing"). The two test questions and
 * the test layer are for the checks too: a question whose Cancel is not first
 * and one with no Cancel at all are the cases Back has to get right, and no
 * question of the shell's is shaped like either.
 */
export default function DevView({ shell, ui }: InterfaceProps) {
  const tabs = useWorkspace((s) => s.tabs);
  const front = useWorkspace(selectActiveTabId);
  const activateTab = useWorkspace((s) => s.activateTab);
  const stack = useLayers((s) => s.stack);
  const { questions, notices } = useQuestions(shell);
  const library = useLibraryView();
  const find = useFind();

  const [lastAnswer, setLastAnswer] = useState<{ id: string; label: string } | null>(null);
  const [swipe, setSwipe] = useState<SwipeDirection | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const onSwipe = useCallback((direction: SwipeDirection) => setSwipe(direction), []);
  useSwipe(stage, onSwipe);

  const findOpen = isLayerOpen(stack, FIND);
  const testOpen = isLayerOpen(stack, TEST_LAYER);

  const ask = (withCancel: boolean) => {
    const answered = (id: string, label: string) => () => {
      handle.dispose();
      setLastAnswer({ id, label });
    };
    const handle = withCancel
      ? shell.notify.show('warning', t('A test question. Back answers it with Cancel.'), [
          { label: t('First answer'), run: answered('first', t('First answer')) },
          { label: t('Cancel'), cancel: true, run: answered('cancel', t('Cancel')) },
        ])
      : shell.notify.show('warning', t('A test question with no Cancel. Back leaves it standing.'), [
          { label: t('Only answer'), run: answered('only', t('Only answer')) },
        ]);
  };

  const count = find.searching
    ? t('searching…')
    : find.query
      ? find.results.length === 0
        ? t('no results')
        : `${find.current + 1} / ${find.results.length}`
      : '';

  return (
    <div className="m-dev" data-ul-role="mobile-shell" data-ui={ui} data-layers={stack.length}>
      <header className="m-dev-banner" data-ul-role="dev-banner">
        <strong>{t('Mobile shell: development view')}</strong>
        <span>{t('Interface: {name}. Not a design: it stands in until the interface is built.', { name: ui })}</span>
      </header>

      <ToolRow label={t('Tools')}>
        <button data-ul-role="save" onClick={() => void saveActive(shell)}>
          {t('Save')}
        </button>
        <button data-ul-role="undo" onClick={() => void shell.commands.execute('edit.undo')}>
          {t('Undo')}
        </button>
        <button data-ul-role="find" onClick={() => openLayer({ id: FIND }, { onBack: () => find.setQuery('') })}>
          {t('Find')}
        </button>
        <button data-ul-role="close" disabled={!front} onClick={() => front && void closeTab(shell, front)}>
          {t('Close')}
        </button>
        <button data-ul-role="dev-layer" onClick={() => openLayer({ id: TEST_LAYER })}>
          {t('Open a test layer')}
        </button>
        <button data-ul-role="dev-ask" onClick={() => ask(true)}>
          {t('Ask a test question')}
        </button>
        <button data-ul-role="dev-ask-no-cancel" onClick={() => ask(false)}>
          {t('Ask with no Cancel')}
        </button>
      </ToolRow>

      {findOpen && (
        <div className="m-dev-find" data-ul-role="find-row">
          <input
            data-ul-role="find-field"
            value={find.query}
            onChange={(event) => find.setQuery(event.target.value)}
            placeholder={t('Find in document…')}
            aria-label={t('Find in document')}
            autoFocus
          />
          <span data-ul-role="find-count">{count}</span>
          <ToolRow label={t('Find in document')}>
            <button aria-label={t('Previous match')} title={t('Previous match')} onClick={find.previous}>
              ↑
            </button>
            <button aria-label={t('Next match')} title={t('Next match')} onClick={find.next}>
              ↓
            </button>
            <button
              data-ul-role="find-close"
              onClick={() => {
                find.setQuery('');
                closeLayer(FIND);
              }}
            >
              {t('Close search')}
            </button>
          </ToolRow>
        </div>
      )}

      {testOpen && (
        <div className="m-dev-layer" data-ul-role="layer" data-layer={TEST_LAYER}>
          <p>{t('A test layer. Back closes it.')}</p>
          <button data-ul-role="layer-close" onClick={() => closeLayer(TEST_LAYER)}>
            {t('Close')}
          </button>
        </div>
      )}

      <section className="m-dev-library" data-ul-role="library" data-phase={library.phase}>
        <div className="m-dev-row">
          <strong>{t('Library')}</strong>
          <input
            value={library.filter}
            onChange={(event) => library.setFilter(event.target.value)}
            placeholder={t('Filter by name')}
            aria-label={t('Filter by name')}
          />
          <button onClick={() => void library.rescan()}>{t('Scan again')}</button>
        </div>
        {library.phase === 'scanning' && <p>{t('Looking for documents…')}</p>}
        {library.phase === 'done' && library.blocked && <p data-ul-role="library-blocked">{t('Documents are hidden')}</p>}
        {library.error && <p data-ul-role="library-error">{library.error}</p>}
        {library.phase === 'done' && !library.error && library.total === 0 && (
          <p>{t('No documents found on this device.')}</p>
        )}
        {library.items.slice(0, 50).map((item) => (
          <button
            key={item.uri}
            className="m-dev-item"
            data-ul-role="library-row"
            onClick={() => void openUri(shell, item.uri, { adopt: true })}
          >
            {item.name}
          </button>
        ))}
      </section>

      <nav className="m-dev-row" data-ul-role="open-documents" aria-label={t('Open documents')}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            data-ul-role="document-tab"
            data-front={tab.id === front ? 'true' : undefined}
            data-dirty={tab.dirty ? 'true' : undefined}
            onClick={() => activateTab(tab.id)}
          >
            {tab.dirty ? `• ${tab.name}` : tab.name}
          </button>
        ))}
      </nav>

      <div ref={stage} className="m-dev-stage" data-ul-role="stage" data-swipe={swipe ?? undefined}>
        {tabs.length === 0 ? (
          <p className="m-dev-empty">{t('Nothing is open. Drop a file here, or open one from the library.')}</p>
        ) : (
          <DocumentStage />
        )}
      </div>

      <p className="m-dev-readout" data-ul-role="dev-readout" data-answer={lastAnswer?.id}>
        {t('Last answer: {answer}', { answer: lastAnswer?.label ?? '—' })} ·{' '}
        {t('Last swipe: {direction}', { direction: swipe === 'left' ? '←' : swipe === 'right' ? '→' : '—' })}
      </p>

      {/* Above the keyboard, whatever else is open: a question nobody can see is
          a question answered by guessing (ADR 0009, "Testing"). */}
      <div className="m-dev-questions">
        {questions.map((question) => (
          <div key={question.id} className="m-dev-question" data-ul-role="question" data-level={question.level}>
            <p>{question.message}</p>
            {question.details && question.details.length > 0 && (
              <ul>
                {question.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
            <div className="m-dev-row">
              {question.actions.map((action, index) => (
                <button
                  key={action.label}
                  data-ul-role="question-action"
                  data-cancel={action.cancel ? 'true' : undefined}
                  onClick={() => answer(question, index)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {notices.map((notice) => (
          <div key={notice.id} className="m-dev-question" data-ul-role="notice" data-level={notice.level}>
            <p>{notice.message}</p>
            <button onClick={() => shell.notify.dismiss(notice.id)}>{t('OK')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
