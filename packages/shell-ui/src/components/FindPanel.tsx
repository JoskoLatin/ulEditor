import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FindResult } from '@uleditor/plugin-sdk';

import { activeInstance, useWorkspace } from '../state/workspace.js';
import { IconClose, IconSearch } from './Icons.js';

/**
 * Pretraga unutar dokumenta — ista ploča bez obzira na format.
 *
 * Vozi `EditorInstance.find()` iz plugin ugovora, pa radi jednako nad kodom,
 * Markdownom i PDF-om. To je konkretna korist od jedinstvenog ugovora: PDF
 * inače nema nikakvo sučelje za pretragu, a ovdje ga dobiva besplatno.
 *
 * CodeMirror zadržava vlastiti Ctrl+F jer nudi i zamjenu, koju ugovor još
 * nema. Objedinjavanje to dvoje je zadatak faze 1 — traži `replace` u
 * `EditorInstance`.
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

  // Upit se namjerno zadržava pri prebacivanju kartice — tražiti isti pojam
  // kroz nekoliko dokumenata je česta radnja. Rezultati se ponovno računaju
  // nad novim dokumentom (vidi ovisnosti u efektu s odgodom ispod).
  //
  // Ali stari rezultati moraju nestati ODMAH: pripadaju prethodnom dokumentu,
  // pa bi im `reveal()` skočio u editor koji više nije u prvom planu.
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
        // PDF čita tekst svake stranice, pa spora pretraga može stići poslije
        // novije. Zadržava se samo najnovija.
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

  // Odgoda: bez nje svaka tipka pokreće pretragu po cijelom PDF-u.
  // `activeTabId` je među ovisnostima da prebacivanje kartice ponovno pokrene
  // isti upit nad novim dokumentom.
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
    ? 'tražim…'
    : query
      ? results.length === 0
        ? 'nema pogodaka'
        : `${selected + 1} / ${results.length}`
      : '';

  return (
    <div className="findpanel" onKeyDown={onKeyDown}>
      <div className="findpanel-bar">
        <IconSearch size={14} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Traži u dokumentu…"
          aria-label="Traži u dokumentu"
          onChange={(e) => setQuery(e.target.value)}
        />

        <span className="findpanel-count">{count}</span>

        <button
          className="findpanel-toggle"
          data-active={caseSensitive}
          title="Razlikuj velika i mala slova"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className="findpanel-toggle"
          data-active={regex}
          title="Regularni izraz"
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>

        <button className="findpanel-toggle" title="Prethodni (Shift+Enter)" onClick={() => step(-1)}>
          ↑
        </button>
        <button className="findpanel-toggle" title="Sljedeći (Enter)" onClick={() => step(1)}>
          ↓
        </button>
        <button
          className="findpanel-toggle"
          title="Zatvori (Esc)"
          aria-label="Zatvori pretragu"
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
            <div className="findpanel-more">…i još {results.length - 200} pogodaka</div>
          )}
        </div>
      )}
    </div>
  );
}
