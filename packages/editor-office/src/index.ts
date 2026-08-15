/**
 * Pregled Office dokumenata — Word i Excel, samo čitanje.
 *
 * Ovo je stavka zbog koje teza "sve na jednom mjestu" vrijedi već u v0.1: bez
 * nje ulEditor otvara kod, tekst i PDF, ali `.docx` iz privitka pošte i dalje
 * traži drugi program.
 *
 * Uređivanje stiže u fazi 2 (ProseMirror za Word, Univer za Excel) i tek tada
 * postaje važno pravilo o vjernosti. Dok se ne sprema, ništa se ne može tiho
 * pokvariti — zato ovi editori nemaju sposobnost `edit`, a ne "imaju je, ali
 * javljaju grešku".
 */

import {
  Emitter,
  plainPayload,
  type ClipboardPayload,
  type DocumentHandle,
  type EditorHost,
  type EditorInstance,
  type EditorProvider,
  type FindQuery,
  type FindResult,
  type ReadingOptions,
  type ReadingSession,
  type SaveResult,
} from '@uleditor/plugin-sdk';

import { PagedFlow, headingOutline, showHit, textNodesOf, wordCount } from '@uleditor/reader-core';

import { renderDocx, type Preview } from './docx.js';
import { columnName, readXlsx, renderSheet, type Sheet, type Workbook } from './xlsx.js';

export { renderDocx } from './docx.js';
export { readXlsx, renderSheet } from './xlsx.js';
export type { Preview } from './docx.js';
export type { Sheet, Workbook } from './xlsx.js';

/* ── zajedničko ──────────────────────────────────────────────────────── */

/**
 * Traka koja kaže dvije stvari: da se dokument ne može uređivati i što pregled
 * ne pokazuje. Prva vrijedi uvijek — korisnik mora znati zašto Ctrl+S ne radi
 * prije nego ga pritisne, a ne poslije.
 */
function buildNotes(notes: string[]): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'ul-office-notes';

  const label = document.createElement('strong');
  label.textContent = 'Pregled samo za čitanje — uređivanje stiže u fazi 2.';
  bar.appendChild(label);

  const list = document.createElement('ul');
  for (const note of notes) {
    const li = document.createElement('li');
    li.textContent = note;
    list.appendChild(li);
  }
  bar.appendChild(list);

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'U redu';
  close.addEventListener('click', () => bar.remove());
  bar.appendChild(close);

  return bar;
}

/** Pretraga nad prikazanim tekstom — isti postupak za Word i za tablicu. */
function searchIn(
  root: HTMLElement,
  query: FindQuery,
  labelOf: (node: Text) => string,
  reveal: (node: Text, range: Range) => void,
): FindResult[] {
  if (!query.query) return [];

  const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
  const results: FindResult[] = [];

  for (const node of textNodesOf(root)) {
    const value = node.nodeValue ?? '';
    const haystack = query.caseSensitive ? value : value.toLowerCase();

    let from = 0;
    while (results.length < 500) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const to = at + needle.length;

      results.push({
        label: labelOf(node),
        preview: value.slice(Math.max(0, at - 40), to + 40).replace(/\s+/g, ' ').trim(),
        reveal: () => {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, Math.min(to, value.length));
          showHit(range);
          reveal(node, range);
        },
      });
      from = to;
    }
    if (results.length >= 500) break;
  }

  return results;
}

/* ── Word ────────────────────────────────────────────────────────────── */

class DocxPreviewEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #view: HTMLElement | null = null;
  #flow: PagedFlow | null = null;
  #reading = false;
  #words: number;

  #dirtyEmitter = new Emitter<boolean>();
  #statusEmitter = new Emitter<string>();
  #progressEmitter = new Emitter<import('@uleditor/plugin-sdk').ReadingProgress>();
  readonly onDirtyChange = this.#dirtyEmitter.event;
  readonly onStatusChange = this.#statusEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    private readonly preview: Preview,
  ) {
    this.#words = wordCount(preview.text);
  }

  mount(container: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'ul-office ul-read';
    root.tabIndex = 0;
    root.dataset.reading = 'false';

    root.appendChild(buildNotes(this.preview.notes));

    const view = document.createElement('div');
    view.className = 'ul-read-view ul-office-view';

    const flow = document.createElement('article');
    flow.className = 'ul-read-flow';
    flow.appendChild(this.preview.body);
    view.appendChild(flow);

    for (const side of ['prev', 'next'] as const) {
      const edge = document.createElement('button');
      edge.type = 'button';
      edge.className = `ul-read-edge ${side}`;
      edge.setAttribute('aria-label', side === 'prev' ? 'Prethodna stranica' : 'Sljedeća stranica');
      edge.addEventListener('click', () => this.#flow?.page(side === 'prev' ? -1 : 1));
      view.appendChild(edge);
    }

    root.appendChild(view);
    container.appendChild(root);

    this.#root = root;
    this.#view = view;
    this.#flow = new PagedFlow({
      view,
      flow,
      words: this.#words,
      onProgress: (progress) => {
        this.#progressEmitter.fire(progress);
        this.#statusEmitter.fire(
          this.#reading
            ? `${progress.label} · još ~${progress.minutesLeft} min`
            : `${this.#words} riječi · ~${progress.minutesLeft} min čitanja`,
        );
      },
    });

    this.#statusEmitter.fire(`${this.#words} riječi · samo za čitanje`);
  }

  unmount(): void {
    this.#flow?.destroy();
    this.#flow = null;
    showHit(null);
    this.#root?.remove();
    this.#root = null;
    this.#view = null;
    this.preview.release();
  }

  isDirty(): boolean {
    return false;
  }

  async save(): Promise<SaveResult> {
    throw new Error('Word dokumenti su za sada samo za čitanje — uređivanje stiže u fazi 2.');
  }

  undo(): void {}
  redo(): void {}
  canUndo(): boolean {
    return false;
  }
  canRedo(): boolean {
    return false;
  }

  async find(query: FindQuery): Promise<FindResult[]> {
    const root = this.preview.body;
    return searchIn(
      root,
      query,
      (node) => nearestHeading(node) ?? this.doc.name,
      (node) => {
        const holder = node.parentElement;
        if (holder) this.#flow?.scrollTo(holder);
        this.#root?.focus();
      },
    );
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    const text = window.getSelection()?.toString() ?? '';
    if (!text.trim()) return null;
    return plainPayload(text, { editorId: 'org.uleditor.docx', uri: this.doc.uri });
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#root?.focus();
  }

  beginReading(options: ReadingOptions): ReadingSession {
    this.#reading = true;
    if (this.#root) this.#root.dataset.reading = 'true';
    if (this.#root) this.#flow?.apply(options, this.#root);

    return {
      apply: (next) => {
        if (this.#root) this.#flow?.apply(next, this.#root);
      },
      page: (delta) => this.#flow?.page(delta),
      seek: (fraction) => this.#flow?.seek(fraction),
      outline: () => headingOutline(this.preview.body),
      goTo: (id) => {
        const target = this.preview.body.querySelector(`#${CSS.escape(id)}`);
        if (target instanceof HTMLElement) this.#flow?.scrollTo(target);
      },
      onProgress: this.#progressEmitter.event,
      end: () => {
        if (!this.#reading) return;
        this.#reading = false;
        if (!this.#root) return;
        this.#root.dataset.reading = 'false';
        // Izvan čitanja dokument se vraća u svitak s bojama aplikacije.
        this.#flow?.apply({ ...(this.#flow.options ?? options), flow: 'scroll' }, this.#root);
        this.#statusEmitter.fire(`${this.#words} riječi · samo za čitanje`);
      },
    };
  }
}

/** Najbliži naslov iznad pogotka — smisleniji trag od broja retka. */
function nearestHeading(node: Text): string | null {
  let current: Element | null = node.parentElement;
  while (current) {
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (/^h[1-6]$/i.test(sibling.tagName)) return (sibling.textContent ?? '').trim().slice(0, 60);
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return null;
}

/* ── Excel ───────────────────────────────────────────────────────────── */

class XlsxPreviewEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #grid: HTMLElement | null = null;
  #active = 0;
  /** Mreže se grade lijeno — radna knjiga zna imati desetke listova. */
  #rendered = new Map<number, HTMLElement>();

  #dirtyEmitter = new Emitter<boolean>();
  #statusEmitter = new Emitter<string>();
  readonly onDirtyChange = this.#dirtyEmitter.event;
  readonly onStatusChange = this.#statusEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    private readonly workbook: Workbook,
  ) {}

  mount(container: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'ul-office ul-sheet-book';
    root.tabIndex = 0;

    root.appendChild(buildNotes(this.workbook.notes));

    const grid = document.createElement('div');
    grid.className = 'ul-sheet-scroll';
    root.appendChild(grid);

    const tabs = document.createElement('div');
    tabs.className = 'ul-sheet-tabs';
    this.workbook.sheets.forEach((sheet, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = sheet.name;
      button.dataset.active = String(index === 0);
      button.addEventListener('click', () => this.#showSheet(index));
      tabs.appendChild(button);
    });
    root.appendChild(tabs);

    container.appendChild(root);
    this.#root = root;
    this.#grid = grid;

    this.#showSheet(0);
  }

  #showSheet(index: number): void {
    const sheet = this.workbook.sheets[index];
    const grid = this.#grid;
    if (!sheet || !grid) return;

    this.#active = index;

    let table = this.#rendered.get(index);
    if (!table) {
      table = renderSheet(sheet);
      this.#rendered.set(index, table);
    }
    grid.replaceChildren(table);

    for (const [i, button] of [...(this.#root?.querySelectorAll('.ul-sheet-tabs button') ?? [])].entries()) {
      if (button instanceof HTMLElement) button.dataset.active = String(i === index);
    }

    this.#statusEmitter.fire(
      `${sheet.name} · ${sheet.rows} × ${columnName(Math.max(0, sheet.cols - 1))} · ${sheet.cells.size} ćelija`,
    );
  }

  unmount(): void {
    showHit(null);
    this.#rendered.clear();
    this.#root?.remove();
    this.#root = null;
    this.#grid = null;
  }

  isDirty(): boolean {
    return false;
  }

  async save(): Promise<SaveResult> {
    throw new Error('Excel tablice su za sada samo za čitanje — uređivanje stiže u fazi 2.');
  }

  undo(): void {}
  redo(): void {}
  canUndo(): boolean {
    return false;
  }
  canRedo(): boolean {
    return false;
  }

  /**
   * Pretraga ide po podacima, ne po prikazanoj mreži — inače bi našla samo
   * list koji je trenutno otvoren, a to nije ono što itko očekuje.
   */
  async find(query: FindQuery): Promise<FindResult[]> {
    if (!query.query) return [];
    const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
    const results: FindResult[] = [];

    this.workbook.sheets.forEach((sheet, index) => {
      for (const [key, cell] of sheet.cells) {
        if (results.length >= 500) return;
        const haystack = query.caseSensitive ? cell.text : cell.text.toLowerCase();
        if (!haystack.includes(needle)) continue;

        const [row, col] = key.split(',').map(Number) as [number, number];
        results.push({
          label: `${sheet.name}!${columnName(col)}${row + 1}`,
          preview: cell.text.slice(0, 120),
          reveal: () => {
            if (this.#active !== index) this.#showSheet(index);
            this.#revealCell(row, col);
          },
        });
      }
    });

    return results;
  }

  #revealCell(row: number, col: number): void {
    const table = this.#rendered.get(this.#active);
    const grid = this.#grid;
    if (!table || !grid) return;

    const target = table.querySelector(`td[data-ref="${row},${col}"]`);
    if (!(target instanceof HTMLElement)) return;

    for (const previous of [...table.querySelectorAll('td[data-hit="true"]')]) {
      previous.removeAttribute('data-hit');
    }
    target.dataset.hit = 'true';
    target.scrollIntoView({ block: 'center', inline: 'center' });
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    const text = window.getSelection()?.toString() ?? '';
    if (!text.trim()) return null;

    // Tablica u međuspremniku nosi i strukturu — Markdown editor je zna
    // umetnuti kao tablicu umjesto kao tab-razdvojenu kašu.
    const rows = text.split(/\r?\n/).map((line) => line.split('\t'));
    return {
      ...plainPayload(text, { editorId: 'org.uleditor.xlsx', uri: this.doc.uri }),
      'application/x-uleditor-table': { rows, headerRow: false },
    };
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#root?.focus();
  }
}

/* ── provideri ───────────────────────────────────────────────────────── */

export const docxPreviewProvider: EditorProvider = {
  id: 'org.uleditor.docx',
  displayName: 'Word pregled',
  matches: {
    extensions: ['docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  capabilities: ['view', 'search', 'read'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocxPreviewEditor(host, doc, renderDocx(await doc.bytes()));
  },
};

export const xlsxPreviewProvider: EditorProvider = {
  id: 'org.uleditor.xlsx',
  displayName: 'Excel pregled',
  matches: {
    extensions: ['xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  capabilities: ['view', 'search'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new XlsxPreviewEditor(host, doc, readXlsx(await doc.bytes()));
  },
};

export { DocxPreviewEditor, XlsxPreviewEditor };
