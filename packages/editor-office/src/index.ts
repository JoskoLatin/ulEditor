/**
 * Office documents — Word, Excel and OpenDocument.
 *
 * This is the item that makes the "everything in one place" thesis hold as early
 * as v0.1: without it ulEditor opens code, text and PDF, but a `.docx` from an
 * email attachment still needs another program.
 *
 * Each editor declares exactly what it can do to the file it opened, and no
 * more. Word text is rewritten a run at a time, straight into the archive it
 * came from; Excel cells and OpenDocument ones are retyped the same way. The
 * old binary `.xls` has no seam to cut into, so its save is a conversion into a
 * new `.xlsx` beside the original — declared as `edit` because the cells
 * genuinely are editable, with the cost named before the first write. The old
 * binary `.doc` and OpenDocument text have neither a seam nor a conversion, and
 * declare no `edit` at all.
 *
 * The full editors of phase 2 (ProseMirror for Word, Univer for Excel) change
 * how much can be done, not this rule about saying so.
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
import { applyCellEdits, findCells, typedKind, writeXlsx } from './xlsx-edit.js';
import { readText, type Archive } from './ooxml.js';
import { readOds, readOdt } from './odf.js';
import { applyOdsEdits, writeOds, type OdsEdit } from './ods-edit.js';
import { readDoc } from './doc.js';
import { readRtf } from './rtf.js';
import { readXls } from './xls.js';
import { buildXlsx, convertedName } from './xlsx-write.js';
import { columnName, readXlsx, renderSheet, type Sheet, type Workbook } from './xlsx.js';

export { renderDocx } from './docx.js';
export { columnName, readXlsx, renderSheet } from './xlsx.js';
export type { Preview } from './docx.js';
export type { Sheet, Workbook } from './xlsx.js';

/* ── shared ──────────────────────────────────────────────────────────── */

/**
 * The bar that states what may be done with the document and what the view does
 * not show.
 *
 * The scope has to be written down before the user presses `Ctrl+S`, not after:
 * in Word the text can be rewritten, but the layout, the styles and everything
 * else stay as they are.
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

/** Search over the displayed text — the same procedure for Word and for a spreadsheet. */
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

  /** The rewritten runs: ordinal in the document → new text. */
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
        /* No seam to write into means no promise of writing. The reading room,
           the outline and the search are the same either way. */
        this.preview.source
          ? t('Text can be retyped — double-click it. Layout and styles stay as they are.')
          : t('This document is shown, not edited — it opens for reading and searching.'),
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

  /* ── editing the text ────────────────────────────────────────────── */

  /**
   * A double-click opens **a single run** — a piece of text with one formatting.
   *
   * Why a run and not a paragraph: a paragraph often holds a dozen of them, so
   * rewriting a whole paragraph would require the program to guess which
   * formatting applies to which new letter. A run is rewritten without a single
   * such decision.
   *
   * A single click stays free for selecting text while reading.
   */
  #onDoubleClick = (event: MouseEvent): void => {
    if (!this.preview.source) return;
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
      // A new line in Word is an element of its own, not a character in the text.
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
    const source = this.preview.source;
    this.#edits = edits;
    if (!source) return;
    // The view returns to whatever the edit list says, including the original text.
    for (const el of this.preview.body.querySelectorAll<HTMLElement>('.ul-office-run')) {
      const index = Number(el.dataset.run);
      const run = source.runs[index];
      el.textContent = edits.get(index) ?? (run ? runText(source.xml, run) : el.textContent);
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
        : this.preview.source
          ? t('{n} words · double-click text to edit', { n: this.#words })
          : t('{n} words · read-only', { n: this.#words }),
    );
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async save(target?: SaveTarget): Promise<SaveResult> {
    const source = this.preview.source;
    /* A view with no seam declares no `edit` capability, so the shell never
       offers this — the guard is for the keyboard shortcut, which asks the
       editor directly. */
    if (!source) throw new Error(t('This document is open for reading only.'));

    const uri = target?.uri ?? this.doc.uri;
    const { archive, xml, runs } = source;

    const edits = [...this.#edits].map(([index, text]) => ({ index, text }));
    const nextXml = applyRunEdits(xml, runs, edits);

    await this.host.fs.writeBytes(uri, writeDocx(archive, runs, xml, edits));

    /*
     * What was saved becomes the new starting point. Without this the next save
     * would begin from the original XML with an empty edit list — and quietly
     * revert the document.
     *
     * Run ordinals survive because only the content of `w:t` changes, not their
     * order; the ranges are recomputed.
     */
    source.xml = nextXml;
    source.runs = findRuns(nextXml);
    this.#edits.clear();
    this.#undoStack = [];
    this.#redoStack = [];
    this.#emitDirty();

    /*
     * No fidelity warning, and for a reason: the write changes exactly the
     * ranges the user rewrote, and every other part of the archive passes
     * through untouched. A warning on every save blunts the one that actually
     * means something.
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
        // Outside reading mode the document returns to a scroll in the application colours.
        this.#flow?.apply({ ...(this.#flow.options ?? options), flow: 'scroll' }, this.#root);
        this.#statusEmitter.fire(t('{n} words · read-only', { n: this.#words }));
      },
    };
  }
}

/** The nearest heading above the hit — a more meaningful trail than a line number. */
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
  /** Grids are built lazily — a workbook can hold dozens of sheets. */
  #rendered = new Map<number, HTMLElement>();

  /** The retyped cells: `sheet:row,col` → what was typed. */
  #edits = new Map<string, string>();
  #undoStack: Map<string, string>[] = [];
  #redoStack: Map<string, string>[] = [];
  #dirty = false;

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
      buildNotes(
        this.workbook.notes,
        this.workbook.convert
          ? t('Cells can be retyped — double-click one. Saving writes a new .xlsx beside the original, which is left untouched.')
          : t('Cells can be retyped — double-click one. Formulas, styles and layout stay as they are.'),
      ),
    );

    const grid = document.createElement('div');
    grid.className = 'ul-sheet-scroll';
    grid.addEventListener('dblclick', this.#onDoubleClick);
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

    this.#emitStatus();
  }

  unmount(): void {
    showHit(null);
    this.#grid?.removeEventListener('dblclick', this.#onDoubleClick);
    this.#rendered.clear();
    this.#root?.remove();
    this.#root = null;
    this.#grid = null;
  }

  /* ── editing the cells ───────────────────────────────────────────── */

  /**
   * A double-click opens **one cell**, exactly as a double-click in Word opens
   * one run. A formula cell is refused with its formula named: the number it
   * shows is a result, and overwriting a result with a literal is the quietest
   * way to destroy a workbook. A single click stays free for selecting.
   */
  #onDoubleClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest('td[data-ref]');
    if (!(target instanceof HTMLElement) || target.isContentEditable) return;

    const sheet = this.workbook.sheets[this.#active];
    const ref = target.dataset.ref ?? '';
    if (!sheet || !ref) return;

    const cell = sheet.cells.get(ref);

    /* The old format keeps no formula text — only the number it last worked
       out. Retyping that number is allowed, and it is the conversion warning
       that says the formula itself will not survive; refusing here would
       forbid editing a column of totals for a formula nobody can see. */
    if (cell?.formula) {
      this.host.notify.show(
        'info',
        t('The cell holds a formula (={formula}) — formulas are not edited yet.', {
          formula: cell.formula,
        }),
      );
      return;
    }

    event.preventDefault();
    const key = `${this.#active}:${ref}`;
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
      this.#record(key, after);
      target.dataset.kind = typedKind(after);
    };

    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.stopPropagation();
        target.textContent = before;
        target.blur();
        return;
      }
      // A value ends at Enter — a new line inside a cell is not offered.
      if (keyEvent.key === 'Enter') {
        keyEvent.preventDefault();
        target.blur();
      }
    };

    target.addEventListener('blur', finish);
    target.addEventListener('keydown', onKey);
  };

  #record(key: string, value: string): void {
    this.#undoStack.push(new Map(this.#edits));
    this.#redoStack = [];
    this.#edits.set(key, value);
    this.#emitDirty();
  }

  #restore(edits: Map<string, string>): void {
    this.#edits = edits;
    for (const [index, table] of this.#rendered) {
      const sheet = this.workbook.sheets[index];
      if (!sheet) continue;
      for (const td of table.querySelectorAll<HTMLElement>('td[data-ref]')) {
        const ref = td.dataset.ref ?? '';
        const edited = edits.get(`${index}:${ref}`);
        const original = sheet.cells.get(ref);
        td.textContent = edited ?? original?.text ?? '';
        const kind = edited !== undefined ? typedKind(edited) : original?.kind;
        if (kind) td.dataset.kind = kind;
        else delete td.dataset.kind;
      }
    }
    this.#emitDirty();
  }

  #emitDirty(): void {
    const dirty = this.#edits.size > 0;
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#dirtyEmitter.fire(dirty);
    }
    this.#emitStatus();
  }

  #emitStatus(): void {
    const sheet = this.workbook.sheets[this.#active];
    if (!sheet) return;
    const base = t('{sheet} · {rows} × {cols} · {cells} cells', {
      sheet: sheet.name,
      rows: sheet.rows,
      cols: columnName(Math.max(0, sheet.cols - 1)),
      cells: sheet.cells.size,
    });
    this.#statusEmitter.fire(
      this.#edits.size > 0 ? `${base} · ${t('{n} edits', { n: this.#edits.size })}` : base,
    );
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async save(target?: SaveTarget): Promise<SaveResult> {
    if (this.workbook.convert) return this.#saveAsConverted(target);

    const { archive } = this.workbook;
    if (!archive) throw new Error(t('The workbook cannot be written.'));
    if (this.workbook.kind === 'odf') return this.#saveOds(archive, target);

    const uri = target?.uri ?? this.doc.uri;

    /* The edits, gathered per sheet part — one part is rewritten per edited
       sheet, everything else passes through untouched. */
    const parts = new Map<string, string>();
    const bySheet = new Map<number, { ref: string; value: string }[]>();
    for (const [key, value] of this.#edits) {
      const [indexPart, refPart] = key.split(':') as [string, string];
      const [row, col] = refPart.split(',').map(Number) as [number, number];
      const list = bySheet.get(Number(indexPart)) ?? [];
      list.push({ ref: `${columnName(col)}${row + 1}`, value });
      bySheet.set(Number(indexPart), list);
    }

    for (const [index, edits] of bySheet) {
      const sheet = this.workbook.sheets[index];
      const xml = sheet ? readText(archive, sheet.path) : null;
      if (!sheet || xml === null) continue;
      parts.set(sheet.path, applyCellEdits(xml, findCells(xml), edits));
    }

    await this.host.fs.writeBytes(uri, writeXlsx(archive, parts));

    /*
     * What was saved becomes the new starting point — the archive parts, and
     * the cell map the grid draws from. Without this the next save would begin
     * from the original parts with an empty edit list and quietly revert.
     */
    const encoder = new TextEncoder();
    for (const [path, xml] of parts) archive[path] = encoder.encode(xml);
    for (const [key, value] of this.#edits) {
      const [indexPart, refPart] = key.split(':') as [string, string];
      const cells = this.workbook.sheets[Number(indexPart)]?.cells;
      if (!cells) continue;
      if (value === '') cells.delete(refPart);
      else cells.set(refPart, this.#typedCell(value));
    }
    this.#edits.clear();
    this.#undoStack = [];
    this.#redoStack = [];
    this.#emitDirty();

    /* No fidelity warning here for the same reason `DocxPreviewEditor` gives
       none: only the rewritten elements changed. The stale formula caches are
       handled, not lost — the workbook recalculates when Excel opens it. */
    return { uri, lostFidelity: [] };
  }

  /**
   * The OpenDocument save: the `.ods` it came from, with only the retyped
   * cells changed.
   *
   * A separate method rather than a branch inside the one above, because the
   * two formats disagree about everything except the idea. There, a cell is
   * named `B4` and every sheet is its own part; here a cell's position is
   * wherever the counting has reached, and the whole spreadsheet is one
   * `content.xml` — so the edits carry a sheet ordinal and a row and column,
   * and the writer splits the repeated groups they land in.
   */
  async #saveOds(archive: Archive, target?: SaveTarget): Promise<SaveResult> {
    const uri = target?.uri ?? this.doc.uri;
    const xml = readText(archive, 'content.xml');
    if (xml === null) throw new Error(t('The workbook cannot be written.'));

    const edits: OdsEdit[] = [];
    for (const [key, value] of this.#edits) {
      const [indexPart, refPart] = key.split(':') as [string, string];
      const [row, col] = refPart.split(',').map(Number) as [number, number];
      edits.push({ sheet: Number(indexPart), row, col, value });
    }

    const next = applyOdsEdits(xml, edits);
    await this.host.fs.writeBytes(uri, writeOds(archive, next));

    /* What was saved becomes the new starting point — the part and the cell
       map the grid draws from. Without this the next save would begin from the
       original bytes with an empty edit list, and quietly revert. */
    archive['content.xml'] = new TextEncoder().encode(next);
    for (const [key, value] of this.#edits) {
      const [indexPart, refPart] = key.split(':') as [string, string];
      const cells = this.workbook.sheets[Number(indexPart)]?.cells;
      if (!cells) continue;
      if (value === '') cells.delete(refPart);
      else cells.set(refPart, this.#typedCell(value));
    }
    this.#edits.clear();
    this.#undoStack = [];
    this.#redoStack = [];
    this.#emitDirty();

    /* No fidelity warning, for the reason the other two in-place saves give
       none: only the rewritten cells changed. */
    return { uri, lostFidelity: [] };
  }

  /**
   * Saving a workbook that has no file to be written back into.
   *
   * The old binary `.xls` has no safe seam to cut into, so what is saved is a
   * **new `.xlsx` beside the original**, which is left exactly as it was. The
   * first save asks where it should go, defaulting to the same name with the
   * new extension; later saves go back to the same place, so `Ctrl+S` twice
   * does not produce two files.
   *
   * `lostFidelity` carries what the conversion cannot bring along, so the
   * shell can ask before it happens — the project's central rule, and the one
   * case in this editor where it genuinely applies.
   */
  async #saveAsConverted(target?: SaveTarget): Promise<SaveResult> {
    const convert = this.workbook.convert!;
    const uri = target?.uri ?? convert.target ?? (await this.#pickConvertTarget());
    if (!uri) throw new DOMException('The save was cancelled.', 'AbortError');

    await this.host.fs.writeBytes(uri, buildXlsx(this.workbook.sheets));

    /* Where it went, so the next save goes to the same file rather than asking
       again — and the losses are reported only for the save that first writes
       it, since the second save of the same grid loses nothing new. */
    const first = convert.target === undefined;
    convert.target = uri;

    for (const [key, value] of this.#edits) {
      const [indexPart, refPart] = key.split(':') as [string, string];
      const cells = this.workbook.sheets[Number(indexPart)]?.cells;
      if (!cells) continue;
      if (value === '') cells.delete(refPart);
      else cells.set(refPart, this.#typedCell(value));
    }
    this.#edits.clear();
    this.#undoStack = [];
    this.#redoStack = [];
    this.#emitDirty();

    return { uri, lostFidelity: first ? convert.losses.map((loss) => t(loss)) : [] };
  }

  async #pickConvertTarget(): Promise<string | null> {
    return this.host.fs.pickSaveTarget(convertedName(this.doc.name), ['xlsx']);
  }

  /** A retyped value as the grid and a written file both need it. */
  #typedCell(value: string): { text: string; kind: 'number' | 'date' | 'text'; raw: number | string } {
    const kind = typedKind(value);
    if (kind === 'number') return { text: value, kind, raw: Number(value.replace(',', '.')) };
    return { text: value, kind, raw: value };
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

  /**
   * Search runs over the data, not over the rendered grid — otherwise it would
   * find only the sheet currently open, which is not what anyone expects.
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

    // A table on the clipboard carries structure too — the Markdown editor knows
    // to insert it as a table instead of tab-separated mush.
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
  /* `edit` means exactly what the editor can genuinely do: rewrite existing
     text. The layout, the styles and everything else are left alone, and that is
     stated above the document. */
  capabilities: ['view', 'search', 'read', 'edit'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocxPreviewEditor(host, doc, renderDocx(await doc.bytes()));
  },
};

export const xlsxPreviewProvider: EditorProvider = {
  id: 'org.uleditor.xlsx',
  displayName: 'Excel',
  matches: {
    extensions: ['xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  /* `edit` means exactly what the editor can genuinely do: retype the value of
     a cell. Formulas, styles and layout are left alone, and that is stated
     above the grid. */
  capabilities: ['view', 'search', 'edit'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new XlsxPreviewEditor(host, doc, readXlsx(await doc.bytes()));
  },
};

/**
 * The old binary `.xls`, in the same grid — and editable, by conversion.
 *
 * Its own provider rather than a branch of the one above because the two save
 * differently, and that difference is the whole point: this one cannot write
 * back into the file it came from, so saving writes a new `.xlsx` beside it
 * and the original is left untouched. `edit` is therefore honest — the cells
 * really are editable — while the fidelity warning names what the conversion
 * cannot carry, before it carries anything.
 */
export const xlsPreviewProvider: EditorProvider = {
  id: 'org.uleditor.xls',
  displayName: 'Excel 97-2003',
  matches: {
    extensions: ['xls'],
    mimeTypes: ['application/vnd.ms-excel'],
  },
  capabilities: ['view', 'search', 'edit'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new XlsxPreviewEditor(host, doc, readXls(await doc.bytes()));
  },
};

/**
 * OpenDocument text — shown, not written.
 *
 * The same reading room a `.docx` gets: headings, formatting, lists, tables,
 * images, the outline, the search and the reading mode. No `edit`, because the
 * `Preview` it is handed carries no seam to write into — see `readOdt`.
 */
export const odtPreviewProvider: EditorProvider = {
  id: 'org.uleditor.odt',
  displayName: 'OpenDocument Text',
  matches: {
    extensions: ['odt', 'ott'],
    mimeTypes: ['application/vnd.oasis.opendocument.text'],
  },
  capabilities: ['view', 'search', 'read'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocxPreviewEditor(host, doc, readOdt(await doc.bytes()));
  },
};

/**
 * OpenDocument spreadsheet — in the grid, and written back into itself.
 *
 * Its own provider rather than a branch of the `.xlsx` one because the two save
 * differently even though both save in place: one cell in an `.xlsx` is named
 * `B4` and lives in its own sheet part, while one in an `.ods` has no name at
 * all and its position has to be counted out of the repeat attributes in a
 * single `content.xml`. See `#saveOds`.
 */
export const odsPreviewProvider: EditorProvider = {
  id: 'org.uleditor.ods',
  displayName: 'OpenDocument Spreadsheet',
  matches: {
    extensions: ['ods', 'ots'],
    mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
  },
  capabilities: ['view', 'search', 'edit'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new XlsxPreviewEditor(host, doc, readOds(await doc.bytes()));
  },
};

/**
 * The old binary Word — shown, not written.
 *
 * The same reading room as the `.odt` above and for the same reason: the
 * `Preview` [`readDoc`](./doc.ts) hands over carries no seam to write into, so
 * no `edit` is claimed. Its own provider rather than a branch of the `.docx`
 * one because nothing about the two formats is shared but the word Word.
 */
export const docPreviewProvider: EditorProvider = {
  id: 'org.uleditor.doc',
  displayName: 'Word 97-2003',
  matches: {
    extensions: ['doc'],
    mimeTypes: ['application/msword'],
  },
  capabilities: ['view', 'search', 'read'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocxPreviewEditor(host, doc, readDoc(await doc.bytes()));
  },
};

/**
 * Rich Text — shown, not written.
 *
 * The same reading room again, and the third format to land in it from a
 * completely different direction: a `.docx` is XML in a ZIP, a `.doc` is a
 * compound file of byte offsets, and an `.rtf` is a stream of instructions with
 * no structure at all until it has been read from the first byte. All three end
 * as paragraphs, and one view draws them.
 *
 * `.doc` is deliberately absent from `extensions` even though a good number of
 * files with that name are Rich Text underneath. The bytes decide that, not the
 * list: detection reads the signature, hands the tab the `rtf` format, and the
 * shell arrives here having already answered the question.
 */
export const rtfPreviewProvider: EditorProvider = {
  id: 'org.uleditor.rtf',
  displayName: 'Rich Text',
  matches: {
    extensions: ['rtf'],
    mimeTypes: ['application/rtf', 'text/rtf'],
  },
  capabilities: ['view', 'search', 'read'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocxPreviewEditor(host, doc, readRtf(await doc.bytes()));
  },
};

export { readXls } from './xls.js';
export { readDoc, parseDoc } from './doc.js';
export { readRtf, parseRtf } from './rtf.js';
export { readOds, readOdt } from './odf.js';
export { DocxPreviewEditor, XlsxPreviewEditor };
