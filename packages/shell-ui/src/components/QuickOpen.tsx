/**
 * Quick open by file name (`Ctrl+P`).
 *
 * The list comes from Rust once per open — in a browser from the VFS — not from the tree: the tree loads
 * lazily, so a file in a folder the user has never expanded would be invisible —
 * and that is exactly the one they look for most.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { useShell } from '../shell/context.js';
import { openUri } from '../shell/actions.js';
import { detectByName } from '../host/detect.js';
import { useWorkspace } from '../state/workspace.js';
import { FormatIcon, IconSearch } from './Icons.js';
import { FORMATS } from '@uleditor/plugin-sdk';
import { native } from '../host/native.js';

/** Above this the list stops being useful and the fetch stops being cheap. */
const MAX_FILES = 20000;
const MAX_SHOWN = 60;
/** Every file whose own name holds the query ranks above every one that needs its path to. */
const NAME_MATCH = 1000;

/**
 * The browser's list: the open folders walked through the VFS, which skips the
 * same noise the Rust walk does. Without it `Ctrl+P` in a browser opened an
 * empty palette and answered "No matching file." to every name.
 */
async function listViaVfs(
  shell: Shell,
  limit: number,
  stopped: () => boolean,
): Promise<{ uri: string; name: string }[]> {
  const found: { uri: string; name: string }[] = [];
  const visit = async (uri: string): Promise<void> => {
    for (const entry of await shell.fs.readDirectory(uri)) {
      if (found.length >= limit || stopped()) return;
      if (entry.kind === 'directory') await visit(entry.uri);
      else found.push({ uri: entry.uri, name: entry.name });
    }
  };
  for (const root of await shell.fs.roots()) {
    if (found.length >= limit || stopped()) break;
    await visit(root.uri);
  }
  return found;
}

interface Entry {
  uri: string;
  name: string;
  /** The path relative to the root — it tells same-named files apart. */
  hint: string;
}

/** Subsequence matching: "shui" finds "shell-ui". It returns the positions to highlight. */
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

/** A hit in the name counts for more than a hit in the path, and consecutive characters most of all. */
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

  // The focus has to be synchronous: `requestAnimationFrame` loses the race with typing.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
      return;
    }
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const stats =
          shell.platform === 'desktop'
            ? await (await native.core()).invoke<{ uri: string; name: string }[]>('list_files', {
                limit: MAX_FILES,
              })
            : await listViaVfs(shell, MAX_FILES, () => cancelled);
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
      /* The name first. Matched over the whole label, the letters are taken
         from the left, so "sales" spent its s and a on a folder called
         `ul-search` and `module.ts` ranked above `sales.xlsx`. */
      const inName = fuzzy(entry.name, query);
      const positions = inName ? inName.map((p) => p + entry.hint.length) : fuzzy(label, query);
      if (positions) found.push({ entry, label, positions, rank: score(entry, positions, entry.name.length) + (inName ? NAME_MATCH : 0) });
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

/** `C:\proj\src\a.ts` against the root `C:\proj` → `src\`. */
function relativeDir(uri: string, name: string, prefixes: string[]): string {
  let path = uri.slice(0, Math.max(0, uri.length - name.length));

  const matched = prefixes.find((prefix) => prefix && path.startsWith(prefix));
  if (matched) {
    path = path.slice(matched.length);
  } else {
    // The root is not known yet (the tree loads lazily). A full path in the list
    // is noise the name cannot be seen through, so the last two folders remain.
    const parts = path.split(/[\\/]+/).filter(Boolean);
    path = parts.slice(-2).join('/');
    if (path) path += '/';
  }

  return path.replace(/^[\\/]+/, '');
}
