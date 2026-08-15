/**
 * Brzo otvaranje datoteke po imenu (`Ctrl+P`).
 *
 * Popis dolazi iz Rusta jednom po otvaranju, ne iz stabla: stablo se učitava
 * lijeno, pa bi datoteka u mapi koju korisnik nikad nije razgranao bila
 * nevidljiva — a upravo nju najčešće traži.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openUri } from '../shell/actions.js';
import { detectByName } from '../host/detect.js';
import { useWorkspace } from '../state/workspace.js';
import { FormatIcon, IconSearch } from './Icons.js';
import { FORMATS } from '@uleditor/plugin-sdk';

/** Iznad ovoga popis prestaje biti koristan, a dohvat jeftin. */
const MAX_FILES = 20000;
const MAX_SHOWN = 60;

interface Entry {
  uri: string;
  name: string;
  /** Putanja relativno na korijen — razlikuje istoimene datoteke. */
  hint: string;
}

/** Podniz-podudaranje: "shui" pronalazi "shell-ui". Vraća pozicije za isticanje. */
function fuzzy(text: string, query: string): number[] | null {
  if (!query) return [];
  const lower = text.toLowerCase();
  const positions: number[] = [];
  let cursor = 0;

  for (const char of query.toLowerCase()) {
    if (char === ' ') continue;
    const index = lower.indexOf(char, cursor);
    if (index === -1) return null;
    positions.push(index);
    cursor = index + 1;
  }
  return positions;
}

/** Pogodak u imenu vrijedi više od pogotka u putanji, a uzastopni znakovi najviše. */
function score(entry: Entry, positions: number[], nameLength: number): number {
  if (positions.length === 0) return 0;
  let value = -(positions[0] ?? 0);
  const inName = positions.filter((p) => p >= entry.hint.length).length;
  value += inName * 3;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === (positions[i - 1] ?? 0) + 1) value += 4;
  }
  return value - nameLength * 0.01;
}

export function QuickOpen() {
  const shell = useShell();
  const open = useWorkspace((s) => s.quickOpen);
  const setOpen = useWorkspace((s) => s.setQuickOpen);
  const roots = useWorkspace((s) => s.tree);

  const [files, setFiles] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fokus mora biti sinkron: `requestAnimationFrame` gubi utrku s tipkanjem.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
      return;
    }
    if (shell.platform !== 'desktop') return;

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const stats = await invoke<{ uri: string; name: string }[]>('list_files', {
          limit: MAX_FILES,
        });
        if (cancelled) return;

        const prefixes = roots.map((root) => root.uri);
        setFiles(
          stats.map((stat) => ({
            uri: stat.uri,
            name: stat.name,
            hint: relativeDir(stat.uri, stat.name, prefixes),
          })),
        );
      } catch {
        if (!cancelled) setFiles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, shell, roots]);

  const matches = useMemo(() => {
    if (!open) return [];
    const found = [];
    for (const entry of files) {
      const label = `${entry.hint}${entry.name}`;
      const positions = fuzzy(label, query);
      if (positions) found.push({ entry, label, positions, rank: score(entry, positions, entry.name.length) });
    }
    found.sort((a, b) => b.rank - a.rank);
    return found.slice(0, MAX_SHOWN);
  }, [files, query, open]);

  useEffect(() => setSelected(0), [query]);

  if (!open) return null;

  const choose = (uri: string) => {
    setOpen(false);
    void openUri(shell, uri);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setSelected((i) => (matches.length ? (i + 1) % matches.length : 0));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelected((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
        break;
      case 'Enter': {
        event.preventDefault();
        const match = matches[selected];
        if (match) choose(match.entry.uri);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="palette" role="dialog" aria-label={t('Open file by name')} onKeyDown={onKeyDown}>
        <div className="palette-input">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('Type a file name…')}
            aria-label={t('Open file by name')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="palette-list">
          {loading && <div className="palette-empty">{t('Reading the file list…')}</div>}

          {!loading && files.length === 0 && (
            <div className="palette-empty">{t('Open a folder first.')}</div>
          )}

          {!loading &&
            files.length > 0 &&
            matches.length === 0 && <div className="palette-empty">{t('No matching file.')}</div>}

          {matches.map(({ entry, label, positions }, index) => (
            <button
              key={entry.uri}
              className="palette-item"
              data-active={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(entry.uri)}
              title={entry.uri}
            >
              <FormatIcon family={FORMATS[detectByName(entry.name).format].family} size={14} />
              <Highlighted text={label} positions={positions} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <span>{text}</span>;
  const marked = new Set(positions);
  return (
    <span>
      {[...text].map((char, index) =>
        marked.has(index) ? <mark key={index}>{char}</mark> : <span key={index}>{char}</span>,
      )}
    </span>
  );
}

/** `C:\proj\src\a.ts` uz korijen `C:\proj` → `src\`. */
function relativeDir(uri: string, name: string, prefixes: string[]): string {
  let path = uri.slice(0, Math.max(0, uri.length - name.length));

  const matched = prefixes.find((prefix) => prefix && path.startsWith(prefix));
  if (matched) {
    path = path.slice(matched.length);
  } else {
    // Korijen još nije poznat (stablo se učitava lijeno). Puna putanja u
    // popisu je šum kroz koji se ne vidi ime, pa ostaju zadnje dvije mape.
    const parts = path.split(/[\\/]+/).filter(Boolean);
    path = parts.slice(-2).join('/');
    if (path) path += '/';
  }

  return path.replace(/^[\\/]+/, '');
}
