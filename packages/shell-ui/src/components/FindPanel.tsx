import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FindResult } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { activeInstance, useWorkspace } from '../state/workspace.js';
import { IconClose, IconSearch } from './Icons.js';

/**
 * In-document search — the same panel whatever the format.
 *
 * It drives `EditorInstance.find()` from the plugin contract, so it behaves
 * identically over code, Markdown and PDF. That is a concrete benefit of one
 * contract: a PDF otherwise has no search interface at all, and here it gets one
 * for free.
 *
 * CodeMirror keeps its own Ctrl+F because it also offers replace, which the
 * contract does not have yet. Unifying the two is a phase 1 task — it needs
 * `replace` in `EditorInstance`.
 */
export function FindPanel() {
  const open = useWorkspace((s) => s.findOpen);
  const setOpen = useWorkspace((s) => s.setFindOpen);
  const activeTabId = useWorkspace((s) => s.activeTabId);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<FindResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Broj zadnje pokrenute pretrage — starije se odbacuju. */
  const runId = useRef(0);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The query is deliberately kept when switching tabs — looking for the same
  // term across several documents is a common thing to do. The results are
  // recomputed against the new document (see the dependencies of the debounced
  // effect below).
  //
  // But the old results have to disappear AT ONCE: they belong to the previous
  // document, so their `reveal()` would jump into an editor no longer in front.
  useEffect(() => {
    runId.current++;
    setResults([]);
    setSelected(0);
  }, [activeTabId]);

  const run = useCallback(
    async (text: string, opts: { caseSensitive: boolean; regex: boolean }) => {
      const id = ++runId.current;
      if (!text) {
        setResults([]);
        setSearching(false);
        return;
      }

      const instance = activeInstance();
      if (!instance) {
        setResults([]);
        return;
      }

      setSearching(true);
      try {
        const found = await instance.find({
          query: text,
          caseSensitive: opts.caseSensitive,
          regex: opts.regex,
        });
        // A PDF reads the text of every page, so a slow search can arrive after a
        // newer one. Only the newest is kept.
        if (id !== runId.current) return;
        setResults(found);
        setSelected(0);
      } catch {
        if (id === runId.current) setResults([]);
      } finally {
        if (id === runId.current) setSearching(false);
      }
    },
    [],
  );

  // The debounce: without it every keystroke launches a search of the whole PDF.
  // `activeTabId` is among the dependencies so switching tabs re-runs the same
  // query against the new document.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void run(query, { caseSensitive, regex }), 160);
    return () => clearTimeout(timer);
  }, [open, query, caseSensitive, regex, activeTabId, run]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const go = (index: number) => {
    const result = results[index];
    if (!result) return;
    setSelected(index);
    result.reveal();
  };

  const step = (direction: number) => {
    if (results.length === 0) return;
    go((selected + direction + results.length) % results.length);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        activeInstance()?.focus();
        break;
      case 'Enter':
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        break;
      default:
        break;
    }
  };

  const count = searching
    ? t('searching…')
    : query
      ? results.length === 0
        ? t('no results')
        : `${selected + 1} / ${results.length}`
      : '';

  return (
    <div className="findpanel" onKeyDown={onKeyDown}>
      <div className="findpanel-bar">
        <IconSearch size={14} />
        <input
          ref={inputRef}
          value={query}
          placeholder={t('Find in document…')}
          aria-label={t('Find in document')}
          onChange={(e) => setQuery(e.target.value)}
        />

        <span className="findpanel-count">{count}</span>

        <button
          className="findpanel-toggle"
          data-active={caseSensitive}
          title={t('Match case')}
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className="findpanel-toggle"
          data-active={regex}
          title={t('Regular expression')}
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>

        <button className="findpanel-toggle" title={t('Previous (Shift+Enter)')} onClick={() => step(-1)}>
          ↑
        </button>
        <button className="findpanel-toggle" title={t('Next (Enter)')} onClick={() => step(1)}>
          ↓
        </button>
        <button
          className="findpanel-toggle"
          title={t('Close (Esc)')}
          aria-label={t('Close search')}
          onClick={() => {
            setOpen(false);
            activeInstance()?.focus();
          }}
        >
          <IconClose size={11} />
        </button>
      </div>

      {results.length > 0 && (
        <div className="findpanel-list" ref={listRef}>
          {results.slice(0, 200).map((result, index) => (
            <button
              key={`${result.label}-${index}`}
              className="findpanel-hit"
              data-active={index === selected}
              onClick={() => go(index)}
            >
              <span className="where">{result.label}</span>
              <span className="what">{result.preview}</span>
            </button>
          ))}
          {results.length > 200 && (
            <div className="findpanel-more">
              {t('…and {n} more results', { n: results.length - 200 })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
