/**
 * Markdown editor — izvor uz živi pregled.
 *
 * Renderirani HTML uvijek prolazi kroz DOMPurify. Markdown može sadržavati
 * doslovni HTML, a dokument dolazi s korisnikovog diska ili s mreže —
 * `html: true` bez sanitizacije bio bi XSS u vlastitoj aplikaciji.
 */

import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { indentOnInput } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { ulTheme } from '@uleditor/editor-code';

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

import {
  Emitter,
  plainPayload,
  tableToPlain,
  type ClipboardPayload,
  type DocumentHandle,
  type EditorHost,
  type EditorInstance,
  type EditorProvider,
  type FindQuery,
  type FindResult,
  type ReadingOptions,
  type ReadingProgress,
  type ReadingSession,
  type SaveResult,
  type SaveTarget,
} from '@uleditor/plugin-sdk';

import { PagedFlow, headingOutline, wordCount } from '@uleditor/reader-core';
import { t } from '@uleditor/i18n';

export type MarkdownViewMode = 'split' | 'source' | 'preview';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
});

function render(source: string): string {
  return DOMPurify.sanitize(md.render(source), {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input'],
  });
}

/** Markdown tablica iz reprezentacije clipboarda — za paste iz tablice. */
function tableToMarkdown(rows: string[][], headerRow: boolean): string {
  if (!rows.length) return '';
  const escape = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => {
    const filled = [...row];
    while (filled.length < width) filled.push('');
    return filled;
  };

  const lines: string[] = [];
  const [first, ...rest] = rows;
  const head = headerRow ? pad(first ?? []) : Array.from({ length: width }, () => '');
  lines.push(`| ${head.map(escape).join(' | ')} |`);
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  for (const row of headerRow ? rest : rows) {
    lines.push(`| ${pad(row).map(escape).join(' | ')} |`);
  }
  return lines.join('\n');
}

class MarkdownEditor implements EditorInstance {
  #view: EditorView | null = null;
  #root: HTMLElement | null = null;
  #preview: HTMLElement | null = null;
  #savedText: string;
  #dirty = false;
  #mode: MarkdownViewMode;
  /** Sprječava povratnu petlju kad sinkroniziramo scroll dviju ploča. */
  #syncing = false;

  /** Sloj čitanja živi paralelno s uređivanjem — izvor se ne demontira. */
  #readingLayer: HTMLElement | null = null;
  #readingDoc: HTMLElement | null = null;
  #paged: PagedFlow | null = null;

  #dirtyEmitter = new Emitter<boolean>();
  #statusEmitter = new Emitter<string>();
  #progressEmitter = new Emitter<ReadingProgress>();
  readonly onDirtyChange = this.#dirtyEmitter.event;
  readonly onStatusChange = this.#statusEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    private readonly initial: string,
  ) {
    this.#savedText = initial;
    this.#mode = host.settings.get<MarkdownViewMode>('markdown.viewMode', 'split');
  }

  mount(container: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'ul-md';
    root.dataset.mode = this.#mode;

    const source = document.createElement('div');
    source.className = 'ul-md-source';

    const divider = document.createElement('div');
    divider.className = 'ul-md-divider';

    const preview = document.createElement('div');
    preview.className = 'ul-md-preview';
    const inner = document.createElement('div');
    inner.className = 'inner';
    preview.appendChild(inner);

    root.append(source, divider, preview);
    container.appendChild(root);

    this.#root = root;
    this.#preview = inner;

    this.#view = new EditorView({
      state: EditorState.create({
        doc: this.initial,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          markdown(),
          EditorView.lineWrapping,
          ulTheme,
          keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.#recomputeDirty();
              this.#renderPreview();
            }
            if (update.docChanged || update.selectionSet) this.#emitStatus();
          }),
        ],
      }),
      parent: source,
    });

    this.#wireScrollSync(preview);
    this.#renderPreview();
    this.#emitStatus();
  }

  /** Proporcionalna sinkronizacija — dovoljna bez mapiranja izvor↔izlaz. */
  #wireScrollSync(preview: HTMLElement): void {
    const scroller = this.#view?.scrollDOM;
    if (!scroller) return;

    const ratio = (el: HTMLElement) => {
      const range = el.scrollHeight - el.clientHeight;
      return range > 0 ? el.scrollTop / range : 0;
    };
    const applyTo = (el: HTMLElement, value: number) => {
      const range = el.scrollHeight - el.clientHeight;
      if (range > 0) el.scrollTop = value * range;
    };

    scroller.addEventListener('scroll', () => {
      if (this.#syncing || this.#mode !== 'split') return;
      this.#syncing = true;
      applyTo(preview, ratio(scroller as HTMLElement));
      requestAnimationFrame(() => (this.#syncing = false));
    });

    preview.addEventListener('scroll', () => {
      if (this.#syncing || this.#mode !== 'split') return;
      this.#syncing = true;
      applyTo(scroller as HTMLElement, ratio(preview));
      requestAnimationFrame(() => (this.#syncing = false));
    });
  }

  unmount(): void {
    this.#paged?.destroy();
    this.#paged = null;
    this.#readingLayer = null;
    this.#readingDoc = null;
    this.#view?.destroy();
    this.#view = null;
    this.#root?.remove();
    this.#root = null;
    this.#preview = null;
  }

  #text(): string {
    return this.#view?.state.doc.toString() ?? this.initial;
  }

  #renderPreview(): void {
    if (this.#preview) this.#preview.innerHTML = render(this.#text());
    // Dok se čita, izvor je i dalje uređiv u pozadini — pregled mora pratiti.
    if (this.#readingDoc) {
      this.#readingDoc.innerHTML = render(this.#text());
      this.#paged?.relayout();
    }
  }

  /* ── način čitanja ─────────────────────────────────────────────────── */

  /**
   * Dugi Markdown (README, dokumentacija, rukopis) čita se kao knjiga. Umjesto
   * da se editor pretvara u čitaonicu, iznad njega se podigne zaseban sloj —
   * CodeMirror ostaje montiran s kursorom i poviješću na mjestu.
   */
  beginReading(options: ReadingOptions): ReadingSession {
    const root = this.#root;
    if (!root) throw new Error('Reading mode needs a mounted editor.');

    const layer = document.createElement('div');
    layer.className = 'ul-md-reading ul-read';
    layer.dataset.reading = 'true';

    const view = document.createElement('div');
    view.className = 'ul-read-view';

    const flow = document.createElement('article');
    flow.className = 'ul-read-flow';

    const doc = document.createElement('div');
    doc.className = 'ul-read-doc';
    doc.innerHTML = render(this.#text());
    flow.appendChild(doc);
    view.appendChild(flow);

    for (const side of ['prev', 'next'] as const) {
      const edge = document.createElement('button');
      edge.type = 'button';
      edge.className = `ul-read-edge ${side}`;
      edge.setAttribute('aria-label', side === 'prev' ? t('Previous page') : t('Next page'));
      edge.addEventListener('click', () => this.#paged?.page(side === 'prev' ? -1 : 1));
      view.appendChild(edge);
    }

    layer.appendChild(view);
    root.appendChild(layer);

    this.#readingLayer = layer;
    this.#readingDoc = doc;

    const paged = new PagedFlow({
      view,
      flow,
      words: wordCount(doc.textContent ?? ''),
      onProgress: (progress) => {
        this.#progressEmitter.fire(progress);
        this.#statusEmitter.fire(
          `${progress.label} · ${t('~{n} min left', { n: progress.minutesLeft ?? 0 })}`,
        );
      },
    });
    this.#paged = paged;
    paged.apply(options, layer);

    return {
      apply: (next) => paged.apply(next, layer),
      page: (delta) => paged.page(delta),
      seek: (fraction) => paged.seek(fraction),
      outline: () => headingOutline(doc),
      goTo: (id) => {
        const target = doc.querySelector(`#${CSS.escape(id)}`);
        if (target instanceof HTMLElement) paged.scrollTo(target);
      },
      onProgress: this.#progressEmitter.event,
      end: () => {
        paged.destroy();
        layer.remove();
        this.#paged = null;
        this.#readingLayer = null;
        this.#readingDoc = null;
        this.#emitStatus();
      },
    };
  }

  #recomputeDirty(): void {
    const dirty = this.#text() !== this.#savedText;
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.#dirtyEmitter.fire(dirty);
  }

  #emitStatus(): void {
    const text = this.#text();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const view = this.#view;
    const position = view
      ? `${t('Line {n}', { n: view.state.doc.lineAt(view.state.selection.main.head).number })}  ·  `
      : '';
    this.#statusEmitter.fire(`${position}${t('{n} words', { n: words })}`);
  }

  setMode(mode: MarkdownViewMode): void {
    this.#mode = mode;
    if (this.#root) this.#root.dataset.mode = mode;
    this.host.settings.set('markdown.viewMode', mode);
  }

  get mode(): MarkdownViewMode {
    return this.#mode;
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async save(target?: SaveTarget): Promise<SaveResult> {
    const uri = target?.uri ?? this.doc.uri;
    const text = this.#text();
    await this.host.fs.writeText(uri, text);
    this.#savedText = text;
    this.#recomputeDirty();
    return { uri, lostFidelity: [] };
  }

  undo(): void {
    if (this.#view) undo(this.#view);
  }
  redo(): void {
    if (this.#view) redo(this.#view);
  }
  canUndo(): boolean {
    return this.#dirty;
  }
  canRedo(): boolean {
    return true;
  }

  async find(query: FindQuery): Promise<FindResult[]> {
    const view = this.#view;
    if (!view || !query.query) return [];

    const text = view.state.doc.toString();
    const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
    const haystack = query.caseSensitive ? text : text.toLowerCase();

    const results: FindResult[] = [];
    let from = 0;
    while (results.length < 500) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      const line = view.state.doc.lineAt(index);
      const to = index + query.query.length;
      results.push({
        label: t('Line {n}', { n: line.number }),
        preview: line.text.trim().slice(0, 120),
        reveal: () => {
          view.dispatch({
            selection: { anchor: index, head: to },
            effects: EditorView.scrollIntoView(index, { y: 'center' }),
          });
          view.focus();
        },
      });
      from = to;
    }
    return results;
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    const view = this.#view;
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    const slice = view.state.sliceDoc(from, to);
    return {
      ...plainPayload(slice, { editorId: 'org.uleditor.markdown', uri: this.doc.uri }),
      'text/html': { html: render(slice), origin: 'markdown' },
    };
  }

  /**
   * Ovdje se cross-format clipboard zaista isplati: raspon kopiran iz
   * tablice ulazi kao Markdown tablica, ne kao tab-razdvojena kaša.
   */
  async paste(payload: ClipboardPayload): Promise<boolean> {
    const view = this.#view;
    if (!view) return false;

    const table = payload['application/x-uleditor-table'];
    const insert = table
      ? tableToMarkdown(table.rows, table.headerRow) || tableToPlain(table)
      : payload['text/plain'];

    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    return true;
  }

  async plainText(): Promise<string> {
    return this.#text();
  }

  focus(): void {
    this.#view?.focus();
  }
}

export const markdownEditorProvider: EditorProvider = {
  id: 'org.uleditor.markdown',
  displayName: 'Markdown editor',
  matches: {
    extensions: ['md', 'markdown', 'mdx', 'markdown'],
    mimeTypes: ['text/markdown'],
  },
  capabilities: ['view', 'edit', 'search', 'export', 'read'],
  // Viši od editora koda, da .md ne završi kao običan tekst.
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new MarkdownEditor(host, doc, await doc.text());
  },
};

export default markdownEditorProvider;
export { MarkdownEditor };
