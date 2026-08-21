/**
 * Project-wide search — the third panel in the side bar.
 *
 * Kept apart from `FindPanel`, which searches the open document. The difference
 * is not only in scope but in what comes back: here the results are grouped by
 * file and lead into a file that is not open yet.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { FORMATS } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openUri } from '../shell/actions.js';
import { runProjectSearch, useProjectSearch, type ProjectHit } from '../shell/project-search.js';
import { activeInstance, useWorkspace } from '../state/workspace.js';
import { FormatIcon, IconSearch } from './Icons.js';

export function SearchPanel() {
  const shell = useShell();
  const {
    query,
    setQuery,
    caseSensitive,
    wholeWord,
    searchDocuments,
    toggle,
    phase,
    hits,
    scanned,
    truncated,
    pending,
    error,
  } = useProjectSearch();

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const groups = useMemo(() => groupByFile(hits), [hits]);
  const running = phase === 'text' || phase === 'documents';

  return (
    <div className="search-panel">
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runProjectSearch(shell);
        }}
      >
        <div className="search-input">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('Search in project…')}
            aria-label={t('Search in project')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="search-toggles">
          <button
            type="button"
            data-active={caseSensitive}
            onClick={() => toggle('caseSensitive')}
            title={t('Match case')}
          >
            Aa
          </button>
          <button
            type="button"
            data-active={wholeWord}
            onClick={() => toggle('wholeWord')}
            title={t('Whole word')}
          >
            ab|
          </button>
          <button type="submit" className="search-run" disabled={running}>
            {running ? t('Searching…') : t('Search')}
          </button>
        </div>

        {/*
          The second pass is what sets this program apart from a code editor
          koda — i skuplji je, pa se bira, ne pretpostavlja.
        */}
        <label className="search-docs">
          <input
            type="checkbox"
            checked={searchDocuments}
            onChange={() => toggle('searchDocuments')}
          />
          <span>{t('Also search inside PDF, Word, Excel and e-books')}</span>
        </label>
      </form>

      <Summary
        phase={phase}
        hits={hits.length}
        files={groups.length}
        scanned={scanned}
        pending={pending}
        truncated={truncated}
        error={error}
      />

      <div className="search-results">
        {groups.map((group) => (
          <FileGroup key={group.uri} group={group} />
        ))}
      </div>
    </div>
  );
}

function Summary({
  phase,
  hits,
  files,
  scanned,
  pending,
  truncated,
  error,
}: {
  phase: string;
  hits: number;
  files: number;
  scanned: number;
  pending: number;
  truncated: boolean;
  error: string | null;
}) {
  if (error) return <p className="search-note" data-tone="error">{error}</p>;
  if (phase === 'idle') return null;

  if (phase === 'text') return <p className="search-note">{t('Scanning files…')}</p>;

  if (phase === 'documents') {
    return (
      <p className="search-note">
        {t('{hits} results · reading {n} documents…', { hits, n: pending })}
      </p>
    );
  }

  if (hits === 0) {
    return <p className="search-note">{t('No results in {n} files.', { n: scanned })}</p>;
  }

  return (
    <p className="search-note">
      {t('{hits} results in {files} files · {scanned} scanned', { hits, files, scanned })}
      {truncated ? ` · ${t('stopped at the limit')}` : ''}
    </p>
  );
}

interface Group {
  uri: string;
  name: string;
  format: ProjectHit['format'];
  hits: ProjectHit[];
}

function groupByFile(hits: ProjectHit[]): Group[] {
  const map = new Map<string, Group>();
  for (const hit of hits) {
    const group = map.get(hit.uri);
    if (group) group.hits.push(hit);
    else map.set(hit.uri, { uri: hit.uri, name: hit.name, format: hit.format, hits: [hit] });
  }
  return [...map.values()];
}

function FileGroup({ group }: { group: Group }) {
  const shell = useShell();
  const [open, setOpen] = useState(true);

  return (
    <div className="search-group">
      <button className="search-file" onClick={() => setOpen(!open)} data-open={open}>
        <FormatIcon family={FORMATS[group.format].family} size={14} />
        <span className="name">{group.name}</span>
        <span className="count">{group.hits.length}</span>
      </button>

      {open &&
        group.hits.map((hit, index) => (
          <button
            key={`${hit.uri}-${hit.where}-${index}`}
            className="search-hit"
            title={hit.uri}
            onClick={() => void reveal(shell, hit)}
          >
            <span className="where">{hit.where}</span>
            <span className="what">{hit.preview}</span>
          </button>
        ))}
    </div>
  );
}

/**
 * Opens a file and, where it is text, jumps to the line.
 *
 * The jump goes through `find()` from the contract rather than a separate API: an
 * editor that can find a string can also reach it, so the same route works for
 * code, Markdown and PDF.
 */
async function reveal(shell: ReturnType<typeof useShell>, hit: ProjectHit): Promise<void> {
  await openUri(shell, hit.uri);

  const store = useWorkspace.getState();
  const tab = store.tabs.find((entry) => entry.uri === hit.uri);
  if (tab) store.activateTab(tab.id);

  // The instance is created asynchronously; without waiting, the jump would arrive before the mount.
  await new Promise((resolve) => setTimeout(resolve, 120));

  const instance = activeInstance();
  const query = useProjectSearch.getState().query.trim();
  if (!instance || !query) return;

  const results = await instance.find({
    query,
    caseSensitive: useProjectSearch.getState().caseSensitive,
  });
  results[0]?.reveal();
}
