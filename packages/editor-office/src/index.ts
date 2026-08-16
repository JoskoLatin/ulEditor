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
  type SaveTarget,
} from '@uleditor/plugin-sdk';

import { PagedFlow, headingOutline, showHit, textNodesOf, wordCount } from '@uleditor/reader-core';
import { t } from '@uleditor/i18n';

import { renderDocx, type Preview } from './docx.js';
import { applyRunEdits, findRuns, runText, writeDocx } from './docx-edit.js';
import { columnName, readXlsx, renderSheet, type Sheet, type Workbook } from './xlsx.js';

export { renderDocx } from './docx.js';
export { columnName, readXlsx, renderSheet } from './xlsx.js';
export type { Preview } from './docx.js';
export type { Sheet, Workbook } from './xlsx.js';

/* ── zajedničko ──────────────────────────────────────────────────────── */

/**
 * Traka koja kaže što se s dokumentom smije i što pregled ne pokazuje.
 *
 * Opseg mora stajati napisan prije nego korisnik pritisne `Ctrl+S`, a ne
 * poslije: u Wordu se tekst da prepisati, ali raspored, stilovi i sve ostalo
 * ostaju kakvi jesu.
 */
function buildNotes(notes: string[], headline: string): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'ul-office-notes';

  const label = document.createElement('strong');
  label.textContent = headline;
  bar.appendChild(label);

  const list = document.createElement('ul');
  for (const note of notes) {
    const li = document.createElement('li');
    li.textContent = t(note);
    list.appendChild(li);
  }
  bar.appendChild(list);

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = t('OK');
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

  /** Prepisani runovi: redni broj u dokumentu → novi tekst. */
  #edits = new Map<number, string>();
  #undoStack: Map<number, string>[] = [];
  #redoStack: Map<number, string>[] = [];
  #dirty = false;

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

    root.appendChild(
      buildNotes(
        this.preview.notes,
        t('Text can be retyped — double-click it. Layout and styles stay as they are.'),
      ),
    );

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
      edge.setAttribute('aria-label', side === 'prev' ? t('Previous page') : t('Next page'));
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
            ? `${progress.label} · ${t('~{n} min left', { n: progress.minutesLeft ?? 0 })}`
            : t('{words} words · ~{minutes} min read', {
                words: this.#words,
                minutes: progress.minutesLeft ?? 0,
              }),
        );
      },
    });

    root.addEventListener('dblclick', this.#onDoubleClick);
    this.#emitDirty();
  }

  unmount(): void {
    this.#root?.removeEventListener('dblclick', this.#onDoubleClick);
    this.#flow?.destroy();
    this.#flow = null;
    showHit(null);
    this.#root?.remove();
    this.#root = null;
    this.#view = null;
    this.preview.release();
  }

  /* ── izmjena teksta ──────────────────────────────────────────────── */

  /**
   * Dvostruki klik otvara **jedan run** — komad teksta s jednim
   * formatiranjem.
   *
   * Zašto run, a ne odlomak: odlomak ih zna imati desetak, pa bi prepisivanje
   * cijelog odlomka tražilo da program pogodi koje formatiranje ide na koje
   * novo slovo. Run se prepisuje bez ijedne takve odluke.
   *
   * Jednostruki klik ostaje slobodan za označavanje teksta pri čitanju.
   */
  #onDoubleClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest('.ul-office-run');
    if (!(target instanceof HTMLElement) || target.isContentEditable) return;

    event.preventDefault();
    const index = Number(target.dataset.run);
    const before = target.textContent ?? '';

    target.contentEditable = 'plaintext-only';
    target.focus();
    document.getSelection()?.selectAllChildren(target);

    const finish = () => {
      target.removeEventListener('blur', finish);
      target.removeEventListener('keydown', onKey);
      target.contentEditable = 'false';

      const after = target.textContent ?? '';
      if (after === before) return;
      this.#record(index, after);
    };

    const onKey = (key: KeyboardEvent) => {
      if (key.key === 'Escape') {
        key.stopPropagation();
        target.textContent = before;
        target.blur();
        return;
      }
      // Novi redak u Wordu je vlastiti element, ne znak u tekstu.
      if (key.key === 'Enter') {
        key.preventDefault();
        target.blur();
      }
    };

    target.addEventListener('blur', finish);
    target.addEventListener('keydown', onKey);
  };

  #record(index: number, text: string): void {
    this.#undoStack.push(new Map(this.#edits));
    this.#redoStack = [];
    this.#edits.set(index, text);
    this.#emitDirty();
  }

  #restore(edits: Map<number, string>): void {
    this.#edits = edits;
    // Pregled se vraća na ono što u izmjenama piše, uključujući izvorni tekst.
    for (const el of this.preview.body.querySelectorAll<HTMLElement>('.ul-office-run')) {
      const index = Number(el.dataset.run);
      const run = this.preview.source.runs[index];
      el.textContent = edits.get(index) ?? (run ? runText(this.preview.source.xml, run) : el.textContent);
    }
    this.#emitDirty();
  }

  #emitDirty(): void {
    const dirty = this.#edits.size > 0;
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#dirtyEmitter.fire(dirty);
    }
    this.#statusEmitter.fire(
      dirty
        ? t('{words} words · {n} edits', { words: this.#words, n: this.#edits.size })
        : t('{n} words · double-click text to edit', { n: this.#words }),
    );
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async save(target?: SaveTarget): Promise<SaveResult> {
    const uri = target?.uri ?? this.doc.uri;
    const { archive, xml, runs } = this.preview.source;

    const edits = [...this.#edits].map(([index, text]) => ({ index, text }));
    const nextXml = applyRunEdits(xml, runs, edits);

    await this.host.fs.writeBytes(uri, writeDocx(archive, runs, xml, edits));

    /*
     * Spremljeno postaje nova polazna točka. Bez toga bi sljedeće spremanje
     * krenulo od izvornog XML-a s praznim popisom izmjena — i tiho vratilo
     * dokument na staro.
     *
     * Redni brojevi runova preživljavaju jer se mijenja samo sadržaj `w:t`,
     * ne i njihov redoslijed; rasponi se preračunavaju.
     */
    this.preview.source.xml = nextXml;
    this.preview.source.runs = findRuns(nextXml);
    this.#edits.clear();
    this.#undoStack = [];
    this.#redoStack = [];
    this.#emitDirty();

    /*
     * Bez upozorenja o vjernosti, i to s razlogom: zapis mijenja točno one
     * raspone koje je korisnik prepisao, a svaki drugi dio arhive prolazi
     * nedirnut. Upozorenje na svako spremanje otupi ono jedno koje stvarno
     * nešto znači.
     */
    return { uri, lostFidelity: [] };
  }

  undo(): void {
    const previous = this.#undoStack.pop();
    if (!previous) return;
    this.#redoStack.push(new Map(this.#edits));
    this.#restore(previous);
  }

  redo(): void {
    const next = this.#redoStack.pop();
    if (!next) return;
    this.#undoStack.push(new Map(this.#edits));
    this.#restore(next);
  }

  canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.#redoStack.length > 0;
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
        this.#statusEmitter.fire(t('{n} words · read-only', { n: this.#words }));
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

    root.appendChild(
      buildNotes(this.workbook.notes, t('Read-only preview — editing arrives in phase 2.')),
    );

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
      t('{sheet} · {rows} × {cols} · {cells} cells', {
        sheet: sheet.name,
        rows: sheet.rows,
        cols: columnName(Math.max(0, sheet.cols - 1)),
        cells: sheet.cells.size,
      }),
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
    throw new Error(t('Excel spreadsheets are read-only for now — editing arrives in phase 2.'));
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
  displayName: 'Word',
  matches: {
    extensions: ['docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  /* `edit` znači točno ono što editor doista može: prepisati postojeći tekst.
     Raspored, stilovi i sve ostalo se ne dira, i to piše iznad dokumenta. */
  capabilities: ['view', 'search', 'read', 'edit'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocxPreviewEditor(host, doc, renderDocx(await doc.bytes()));
  },
};

export const xlsxPreviewProvider: EditorProvider = {
  id: 'org.uleditor.xlsx',
  displayName: 'Excel preview',
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
