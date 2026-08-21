/**
 * Search across the whole workspace.
 *
 * Two passes, and the second is why this exists at all:
 *
 * 1. **Text files** — scanned by Rust (`Workspace::search`). The content does not
 *    cross the IPC boundary; the query goes up, only the hits come back.
 * 2. **Documents** — PDF, Word, Excel, e-books. Rust does not read them, but it
 *    reports them as candidates, so here they are opened with the same parsers
 *    the editors use for display. That is the difference from grep and from every
 *    code editor: a sentence from a contract in a PDF turns up alongside the
 *    results from code.
 *
 * The second pass is **optional and slower**, so it runs on request and reports
 * progress rather than standing silent.
 */

import { create } from 'zustand';
import { FORMATS, type FormatId, type Uri } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { detectByName } from '../host/detect.js';

/** Above this the second pass takes longer than anyone waits. */
const MAX_DOCUMENTS = 60;
/** A document larger than this is skipped — parsing would block the window. */
const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024;

export interface ProjectHit {
  uri: Uri;
  name: string;
  /** Where the hit is: "line 42" in text, "Chapter 3" or "Sheet1!B4" in a document. */
  where: string;
  preview: string;
  /** The line for text files; documents have none. */
  line?: number;
  format: FormatId;
}

export type SearchPhase = 'idle' | 'text' | 'documents' | 'done';

interface ProjectSearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Enables the second pass through PDF, Word, Excel and e-books. */
  searchDocuments: boolean;

  phase: SearchPhase;
  hits: ProjectHit[];
  scanned: number;
  truncated: boolean;
  /** How many documents are left for the second pass — for the progress bar. */
  pending: number;
  error: string | null;

  setQuery(query: string): void;
  toggle(key: 'caseSensitive' | 'wholeWord' | 'searchDocuments'): void;
  reset(): void;
}

export const useProjectSearch = create<ProjectSearchState>((set) => ({
  query: '',
  caseSensitive: false,
  wholeWord: false,
  searchDocuments: false,

  phase: 'idle',
  hits: [],
  scanned: 0,
  truncated: false,
  pending: 0,
  error: null,

  setQuery: (query) => set({ query }),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<ProjectSearchState>),
  reset: () =>
    set({ phase: 'idle', hits: [], scanned: 0, truncated: false, pending: 0, error: null }),
}));

/* ── execution ───────────────────────────────────────────────────────── */

/** Raste sa svakim pokretanjem; stariji prolaz prestaje objavljivati rezultate. */
let runId = 0;

interface RustHit {
  uri: string;
  name: string;
  line: number;
  column: number;
  preview: string;
}

interface RustOutcome {
  hits: RustHit[];
  scanned: number;
  truncated: boolean;
  documents: { uri: string; name: string; format: FormatId }[];
}

export async function runProjectSearch(shell: Shell): Promise<void> {
  const state = useProjectSearch.getState();
  const query = state.query.trim();
  const run = ++runId;

  if (!query) {
    state.reset();
    return;
  }

  useProjectSearch.setState({
    phase: 'text',
    hits: [],
    scanned: 0,
    truncated: false,
    pending: 0,
    error: null,
  });

  let outcome: RustOutcome;
  try {
    outcome =
      shell.platform === 'desktop'
        ? await searchViaCore(state, query)
        : await searchViaVfs(shell, state, query);
  } catch (err) {
    useProjectSearch.setState({ phase: 'done', error: describe(err) });
    return;
  }

  if (run !== runId) return;

  const hits: ProjectHit[] = outcome.hits.map((hit) => ({
    uri: hit.uri,
    name: hit.name,
    where: t('line {n}', { n: hit.line }),
    preview: hit.preview,
    line: hit.line,
    format: 'code',
  }));

  const documents = state.searchDocuments ? outcome.documents.slice(0, MAX_DOCUMENTS) : [];

  useProjectSearch.setState({
    hits,
    scanned: outcome.scanned,
    truncated: outcome.truncated,
    phase: documents.length > 0 ? 'documents' : 'done',
    pending: documents.length,
  });

  if (documents.length === 0) return;

  /* The second pass: documents, one at a time, publishing after each. */
  for (const candidate of documents) {
    if (run !== runId) return;

    try {
      const found = await searchDocument(shell, candidate, query, state.caseSensitive);
      if (run !== runId) return;
      if (found.length > 0) {
        useProjectSearch.setState((s) => ({ hits: [...s.hits, ...found] }));
      }
    } catch {
      // A damaged or protected document must not abort the search.
    } finally {
      if (run === runId) {
        useProjectSearch.setState((s) => ({ pending: Math.max(0, s.pending - 1) }));
      }
    }
  }

  if (run === runId) useProjectSearch.setState({ phase: 'done' });
}

/**
 * Searching one document with its own parser.
 *
 * Parsers load lazily and only for a format that actually turned up — a folder
 * with no PDF in it never pulls in pdf.js.
 */
async function searchDocument(
  shell: Shell,
  candidate: { uri: string; name: string; format: FormatId },
  query: string,
  caseSensitive: boolean,
): Promise<ProjectHit[]> {
  const stat = await shell.fs.stat(candidate.uri);
  if (stat.size > MAX_DOCUMENT_BYTES) return [];

  const bytes = await shell.fs.readBytes(candidate.uri);
  const needle = caseSensitive ? query : query.toLowerCase();

  const hit = (where: string, text: string, at: number): ProjectHit => ({
    uri: candidate.uri,
    name: candidate.name,
    where,
    preview: text
      .slice(Math.max(0, at - 40), at + query.length + 60)
      .replace(/\s+/g, ' ')
      .trim(),
    format: candidate.format,
  });

  const scan = (where: string, text: string, out: ProjectHit[], limit = 5): void => {
    const haystack = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    while (out.length < limit) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      out.push(hit(where, text, at));
      from = at + needle.length;
    }
  };

  const out: ProjectHit[] = [];

  switch (candidate.format) {
    case 'epub': {
      const { openEpub } = await import('@uleditor/editor-book');
      const book = openEpub(bytes);
      try {
        for (const chapter of book.chapters) {
          if (out.length >= 20) break;
          scan(chapter.title, chapter.text, out);
        }
      } finally {
        book.release();
      }
      break;
    }

    case 'docx': {
      const { renderDocx } = await import('@uleditor/editor-office');
      const preview = renderDocx(bytes);
      try {
        scan(t('document'), preview.text, out, 20);
      } finally {
        preview.release();
      }
      break;
    }

    case 'xlsx': {
      const { readXlsx, columnName } = await import('@uleditor/editor-office');
      const workbook = readXlsx(bytes);
      for (const sheet of workbook.sheets) {
        for (const [key, cell] of sheet.cells) {
          if (out.length >= 20) break;
          const haystack = caseSensitive ? cell.text : cell.text.toLowerCase();
          if (!haystack.includes(needle)) continue;
          const [row, col] = key.split(',').map(Number) as [number, number];
          out.push(hit(`${sheet.name}!${columnName(col)}${row + 1}`, cell.text, 0));
        }
      }
      break;
    }

    case 'pdf': {
      const { extractPdfText } = await import('@uleditor/editor-pdf');
      const pages = await extractPdfText(bytes);
      for (const page of pages) {
        if (out.length >= 20) break;
        scan(t('page {n}', { n: page.page }), page.text, out, 20);
      }
      break;
    }

    default:
      break;
  }

  return out;
}

/** Desktop: the scan happens in Rust, the content does not cross the IPC boundary. */
async function searchViaCore(
  state: { caseSensitive: boolean; wholeWord: boolean },
  query: string,
): Promise<RustOutcome> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RustOutcome>('search_workspace', {
    query: {
      query,
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      limit: 500,
      perFile: 20,
    },
  });
}

/**
 * Web: the same job through `VirtualFileSystem`.
 *
 * It is slower because every file goes through the File System Access API, so the
 * limits are tighter. It exists so search is not a feature that "only works on
 * desktop" — the same panel, the same results, a different speed.
 */
async function searchViaVfs(
  shell: Shell,
  state: { caseSensitive: boolean; wholeWord: boolean },
  query: string,
): Promise<RustOutcome> {
  const outcome: RustOutcome = { hits: [], scanned: 0, truncated: false, documents: [] };
  const needle = state.caseSensitive ? query : query.toLowerCase();
  const roots = await shell.fs.roots();

  const visit = async (uri: Uri): Promise<void> => {
    if (outcome.truncated) return;

    for (const entry of await shell.fs.readDirectory(uri)) {
      if (outcome.truncated) return;

      if (entry.kind === 'directory') {
        await visit(entry.uri);
        continue;
      }

      const format = detectByName(entry.name).format;
      if (DOCUMENT_FORMATS.has(format)) {
        if (outcome.documents.length < WEB_DOCUMENT_LIMIT) {
          outcome.documents.push({ uri: entry.uri, name: entry.name, format });
        }
        continue;
      }
      if (!FORMATS[format].textual || entry.size > WEB_MAX_FILE_BYTES) continue;

      let text: string;
      try {
        text = await shell.fs.readText(entry.uri);
      } catch {
        continue;
      }
      outcome.scanned += 1;

      let inFile = 0;
      text.split(/\r?\n/).forEach((line, index) => {
        if (inFile >= 20 || outcome.truncated) return;
        const haystack = state.caseSensitive ? line : line.toLowerCase();

        let from = 0;
        while (inFile < 20) {
          const at = haystack.indexOf(needle, from);
          if (at === -1) break;
          if (outcome.hits.length >= WEB_HIT_LIMIT) {
            outcome.truncated = true;
            return;
          }
          if (!state.wholeWord || bounded(line, at, at + query.length)) {
            outcome.hits.push({
              uri: entry.uri,
              name: entry.name,
              line: index + 1,
              column: at + 1,
              preview: line.slice(Math.max(0, at - 40), at + query.length + 90).trim(),
            });
            inFile += 1;
          }
          from = at + Math.max(1, needle.length);
        }
      });
    }
  };

  for (const root of roots) await visit(root.uri);
  return outcome;
}

const DOCUMENT_FORMATS = new Set<FormatId>(['pdf', 'epub', 'docx', 'xlsx', 'odf']);
const WEB_MAX_FILE_BYTES = 1024 * 1024;
const WEB_HIT_LIMIT = 300;
const WEB_DOCUMENT_LIMIT = 40;

function bounded(line: string, start: number, end: number): boolean {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
  return !isWord(line[start - 1]) && !isWord(line[end]);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
