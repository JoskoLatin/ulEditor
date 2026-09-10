/**
 * Office documents — Word, Excel and OpenDocument.
 *
 * This is the item that makes the "everything in one place" thesis hold as early
 * as v0.1: without it ulEditor opens code, text and PDF, but a `.docx` from an
 * email attachment still needs another program.
 *
 * Each editor declares exactly what it can do to the file it opened, and no
 * more. Word text is rewritten a run at a time, straight into the archive it
 * came from; OpenDocument text a stretch of characters at a time, and Excel and
 * OpenDocument cells one cell at a time, all into the file they were read from.
 * The old binary `.xls` has no seam to cut into, so its save is a conversion
 * into a new `.xlsx` beside the original — declared as `edit` because the cells
 * genuinely are editable, with the cost named before the first write. The old
 * binary `.doc` and Rich Text have neither a seam nor a conversion, and declare
 * no `edit` at all.
 *
 * The full editors of phase 2 (ProseMirror for Word, Univer for Excel) change
 * how much can be done, not this rule about saying so.
 *
 * One editor drives all three document formats and one drives all four
 * spreadsheet ones. What a save costs is the format's own business, and it is
 * settled behind [`Preview.source`](./docx.ts) — the editor above it asks for
 * the file with these rewrites in it and never asks which format it is looking
 * at.
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

import { renderDocx, type NewParagraph, type Preview } from './docx.js';
import { applyCellEdits, findCells, typedKind, writeXlsx } from './xlsx-edit.js';
import { readText, type Archive } from './ooxml.js';
import { readOds, readOdt } from './odf.js';
import { applyOdsEdits, type OdsEdit } from './ods-edit.js';
import { writeOdf } from './odf-package.js';
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

/** Everything an undo has to put back: the rewrites and the plan, together. */
interface Snapshot {
  edits: Map<number, string>;
  steps: NewParagraph[];
}

/**
 * One editor for every document this program can draw as paragraphs.
 *
 * It was written for Word and named for it, and then a `.doc`, an `.odt` and an
 * `.rtf` arrived in it — four formats that agree on nothing below the seam they
 * are read through. Two of them can be written back into, and the difference
 * between them lives entirely in `Preview.source`: this class asks for the file
 * with its rewrites in it and never asks which format that file is.
 */
class DocumentPreviewEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #view: HTMLElement | null = null;
  #flow: PagedFlow | null = null;
  #reading = false;
  #words: number;

  /** The rewritten runs: ordinal in the document → new text. */
  #edits = new Map<number, string>();
  /**
   * The paragraphs that are not in the file yet.
   *
   * A plan, in the sense [`editor-pdf`](../../editor-pdf/src/document.ts) means
   * it: nothing is applied until a save, and a save applies the whole of it to
   * the file as it was opened. So it outlives the save it was written by, and a
   * person can still take back a paragraph they added ten minutes ago.
   */
  #steps: NewParagraph[] = [];
  #undoStack: Snapshot[] = [];
  #redoStack: Snapshot[] = [];
  /** The plan as the file on disk holds it; anything else means unsaved. */
  #saved: string;
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
    this.#saved = this.#key();
  }

  /* ── what is changed, and what is saved ──────────────────────────── */

  /**
   * The whole plan as one comparable string.
   *
   * The document is dirty when this differs from what was last written, which
   * is a different question from "has anything been typed": undoing back to the
   * state that was saved makes the document clean again, and saving does not
   * throw away the history that got there.
   *
   * A step with no text is left out, because a step with no text is never
   * written — an empty paragraph nobody typed into is not a change to the file.
   */
  #key(): string {
    const edits = [...this.#edits].sort((a, b) => a[0] - b[0]);
    return JSON.stringify([edits, this.#steps.filter((step) => step.text.length > 0)]);
  }

  /**
   * The state to come back to.
   *
   * A step with nothing typed into it is left out on purpose. It is never
   * written, so it is not part of what an undo is undoing — and restoring one
   * would leave the person a one-character box on the page to find and dismiss,
   * when what they meant by undoing an insertion was the insertion.
   */
  #capture(): Snapshot {
    return {
      edits: new Map(this.#edits),
      steps: this.#steps.filter((step) => step.text.length > 0).map((step) => ({ ...step })),
    };
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
          ? this.preview.source.paragraphs
            ? t(
                'Text can be retyped — double-click it. Ctrl+Enter adds a paragraph below. Layout and styles stay as they are.',
              )
            : t('Text can be retyped — double-click it. Layout and styles stay as they are.')
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
    /* Which step this is, resolved now while the numbering on the page is
       fresh — not at the moment the caret leaves, by which time an undo may
       have rebuilt every node of the plan under it. */
    const added = target.closest<HTMLElement>('[data-new]');
    this.#openForTyping(target, added ? this.#steps[Number(added.dataset.new)] : undefined);
  };

  /**
   * Opens one piece of text for typing, whether it is in the file or only in the
   * plan.
   *
   * The two cases differ in exactly one place — where the typed text is written
   * down when the caret leaves — and that difference is the last two lines.
   */
  #openForTyping(target: HTMLElement, step?: NewParagraph): void {
    const before = target.textContent ?? '';

    target.contentEditable = 'plaintext-only';
    target.focus();
    document.getSelection()?.selectAllChildren(target);

    const finish = () => {
      target.removeEventListener('blur', finish);
      target.removeEventListener('keydown', onKey);
      target.contentEditable = 'false';

      /*
       * A browser writing into a `contenteditable` turns a space it thinks might
       * collapse into a non-breaking one — U+00A0, a different character, which
       * would be written into the document as itself. Where the text held none
       * to begin with, none came from the person typing either.
       */
      const typed = target.textContent ?? '';
      const after = before.includes('\u00A0') ? typed : typed.replace(/\u00A0/g, ' ');

      if (step) this.#recordStep(step, after);
      else if (after !== before) this.#record(Number(target.dataset.run), after);
    };

    const onKey = (key: KeyboardEvent) => {
      if (key.key === 'Escape') {
        key.stopPropagation();
        target.textContent = before;
        target.blur();
        return;
      }
      /* A new line in Word is an element of its own, not a character in the
         text — and adding one is a command of its own, not this key. Enter here
         means "done", which is what it has always meant in this editor and what
         the browser check at tools/verify-office-editing.mjs relies on. */
      if (key.key === 'Enter') {
        key.preventDefault();
        target.blur();
      }
    };

    target.addEventListener('blur', finish);
    target.addEventListener('keydown', onKey);
  }

  #record(index: number, text: string): void {
    this.#undoStack.push(this.#capture());
    this.#redoStack = [];
    this.#edits.set(index, text);
    this.#emitDirty();
  }

  /* ── a paragraph that is not in the file yet ─────────────────────── */

  /**
   * Adds a paragraph after the one the cursor is in.
   *
   * The command is offered only where the seam offers it, and refuses out loud
   * rather than quietly: a table cell is a different problem — the grid around
   * it declares row and column counts this program does not maintain — and a
   * command that appears to do nothing teaches people the program is unreliable.
   */
  insertParagraph(): void {
    const source = this.preview.source;
    if (!source?.paragraphs) return;

    /* Read where the cursor is BEFORE anything moves, because the two lines
       after this move a great deal. */
    const at = this.#insertionPoint();

    /*
     * Then finish whatever is being typed, and finish it now.
     *
     * The redraw below replaces every node of the plan, and a node taken out
     * from under a caret blurs into a handler whose element is already gone —
     * and, if the text was left empty, into a handler that removes a step and
     * renumbers the ones after it. Letting that happen first, and then asking
     * again where the step it anchored to has ended up, is the difference
     * between a paragraph landing where the person was looking and landing
     * somewhere else entirely.
     */
    const typing = document.activeElement;
    if (typing instanceof HTMLElement && typing.isContentEditable) typing.blur();

    if ('refusal' in at) {
      this.#statusEmitter.fire(at.refusal);
      return;
    }

    /*
     * No undo entry yet, deliberately. An empty paragraph is not a change to the
     * file, and one that is abandoned without a word typed into it disappears on
     * its own — an undo step that restores the same state is a keystroke that
     * appears not to work. The history is written when there is something in it.
     */
    const position = this.#positionFor(at);
    const step: NewParagraph = { after: at.after, text: '' };
    this.#steps.splice(position, 0, step);
    this.#syncSteps();
    this.#emitDirty();

    const fresh = this.preview.body.querySelector<HTMLElement>(
      `[data-new="${position}"] .ul-office-run`,
    );
    if (fresh) {
      this.#flow?.scrollTo(fresh);
      this.#openForTyping(fresh, step);
    }
  }

  /** Where a new paragraph would go, or why it would not. */
  #insertionPoint(): { after: number; behind: NewParagraph | null } | { refusal: string } {
    const body = this.preview.body;
    const anchor = document.getSelection()?.anchorNode ?? null;
    const inside = anchor && body.contains(anchor) ? anchor : null;
    const element = inside instanceof Element ? inside : (inside?.parentElement ?? null);

    /* Inside a paragraph that is itself only a plan: the new one follows the
       same paragraph of the file, and sits immediately behind this one. */
    const added = element?.closest<HTMLElement>('[data-new]');
    if (added) {
      const step = this.#steps[Number(added.dataset.new)];
      if (step) return { after: step.after, behind: step };
    }

    const paragraph = element?.closest<HTMLElement>('[data-paragraph]');
    if (paragraph) return { after: Number(paragraph.dataset.paragraph), behind: null };

    /* A cell is the one refusal the view can answer by itself, and the only one
       the real corpus ever produces — every nested paragraph in those 49
       documents is in a `w:tc`. Asking the seam covers the rest, and reaching
       it needs an editable run to ask about. */
    if (element?.closest('td, th')) {
      return {
        refusal: t('A new paragraph can only go into the body of the document — not into a table cell or a text box.'),
      };
    }

    const run = element?.closest<HTMLElement>('.ul-office-run[data-run]');
    const refusal = run ? this.preview.source?.paragraphs?.refusalNear(Number(run.dataset.run)) : null;
    return { refusal: refusal ?? t('Put the cursor in a paragraph of the document first.') };
  }

  /**
   * The place in the list that puts the new paragraph where the eye expects it.
   *
   * Steps sharing a source paragraph are drawn in list order, so a paragraph
   * added from the source itself belongs **before** the ones already following
   * it, and one added from inside a step belongs directly behind that step. The
   * step is looked up by identity rather than by the position it had a moment
   * ago, because finishing the typing above may have removed it.
   */
  #positionFor(at: { after: number; behind: NewParagraph | null }): number {
    if (at.behind) {
      const found = this.#steps.indexOf(at.behind);
      if (found !== -1) return found + 1;
    }
    const first = this.#steps.findIndex((step) => step.after === at.after);
    return first === -1 ? this.#steps.length : first;
  }

  /**
   * What was typed into a paragraph of the plan.
   *
   * The step is passed by identity rather than by the position it held when the
   * typing began, because between those two moments an undo may have rebuilt the
   * list; a step that is no longer in it is one this typing has nothing to say
   * about.
   *
   * Left empty, it goes. An empty new paragraph is one nobody typed into: it is
   * never written, so leaving it on the page would be showing a line the file
   * will not have — and it would be a line with no run in it, which is a line
   * nobody could ever click into again.
   */
  #recordStep(step: NewParagraph, text: string): void {
    const position = this.#steps.indexOf(step);
    if (position === -1) return;

    if (text.length === 0) {
      /* Nothing was ever typed into it, so there is nothing to undo back to —
         it leaves as quietly as it arrived. */
      if (step.text.length === 0) {
        this.#steps.splice(position, 1);
        this.#syncSteps();
        this.#emitDirty();
        return;
      }
    } else if (step.text === text) {
      return;
    }

    this.#undoStack.push(this.#capture());
    this.#redoStack = [];
    if (text.length === 0) this.#steps.splice(position, 1);
    else step.text = text;

    this.#syncSteps();
    this.#emitDirty();
  }

  /**
   * Draws the plan onto the page.
   *
   * Rebuilt whole rather than patched, because an undo can change the list in
   * any way at all and a redraw of a handful of nodes is cheaper than being
   * wrong about which ones moved. The tag is taken from what the new paragraph
   * follows, so a paragraph added inside a numbered list is a list item and the
   * browser renumbers the list exactly as the reopened file will.
   */
  #syncSteps(): void {
    const body = this.preview.body;
    for (const stale of [...body.querySelectorAll('[data-new]')]) stale.remove();

    const last = new Map<number, HTMLElement>();
    this.#steps.forEach((step, position) => {
      const anchor =
        last.get(step.after) ?? body.querySelector<HTMLElement>(`[data-paragraph="${step.after}"]`);
      if (!anchor) return;

      const element = document.createElement(anchor.tagName === 'LI' ? 'li' : 'p');
      element.dataset.new = String(position);
      if (anchor.style.textAlign) element.style.textAlign = anchor.style.textAlign;

      const piece = document.createElement('span');
      piece.className = 'ul-office-run is-new';
      piece.textContent = step.text;
      element.appendChild(piece);

      anchor.after(element);
      last.set(step.after, element);
    });

    /* The flow measures the document once and keeps the number; a document that
       grew and did not say so has a last page nobody can reach. */
    this.#flow?.relayout();
  }

  #restore(snapshot: Snapshot): void {
    const source = this.preview.source;
    this.#edits = snapshot.edits;
    this.#steps = snapshot.steps;
    if (!source) return;

    /* Only the pieces that stand for something in the file — a piece that is
       only in the plan has no ordinal there, and asking for one would answer
       with the empty string and blank the paragraph. */
    for (const el of this.preview.body.querySelectorAll<HTMLElement>('.ul-office-run[data-run]')) {
      const index = Number(el.dataset.run);
      el.textContent = snapshot.edits.get(index) ?? source.textOf(index);
    }
    this.#syncSteps();
    this.#emitDirty();
  }

  #emitDirty(): void {
    const dirty = this.#key() !== this.#saved;
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#dirtyEmitter.fire(dirty);
    }
    const changes = this.#edits.size + this.#steps.filter((step) => step.text.length > 0).length;
    this.#statusEmitter.fire(
      dirty
        ? t('{words} words · {n} edits', { words: this.#words, n: changes })
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
    const edits = [...this.#edits].map(([index, text]) => ({ index, text }));
    const added = this.#steps.filter((step) => step.text.length > 0);

    await this.host.fs.writeBytes(uri, source.write(edits, added));

    /*
     * Nothing is cleared and nothing is committed. Every save writes the file as
     * it was opened with the whole plan applied to it, so saving twice writes
     * the same bytes — and the history stays, which is the only way changing
     * your mind about a paragraph you added is something a person can do. What
     * is recorded is simply which plan the file on disk now holds.
     */
    this.#saved = this.#key();
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
    this.#redoStack.push(this.#capture());
    this.#restore(previous);
  }

  redo(): void {
    const next = this.#redoStack.pop();
    if (!next) return;
    this.#undoStack.push(this.#capture());
    this.#restore(next);
  }

  canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  /**
   * Whether this document can take a new paragraph at all.
   *
   * Not whether the cursor is somewhere one may go — that is answered out loud,
   * with a reason, when the command runs. This is the coarser question the shell
   * needs to decide whether the entry belongs in this document's menu: a Word
   * document says yes, and the OpenDocument text, the old binary `.doc` and the
   * Rich Text driven by this same class all say no, because their seams offer
   * nothing to say it with.
   */
  canInsertParagraph(): boolean {
    return this.preview.source?.paragraphs !== undefined;
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
        /* Whatever the status was before reading began, not a flat claim of
           read-only — a document with unsaved changes is neither. */
        this.#emitDirty();
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

    /* No fidelity warning here for the same reason `DocumentPreviewEditor` gives
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
    await this.host.fs.writeBytes(uri, writeOdf(archive, next));

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

  /**
   * A range off the grid, in two forms at once.
   *
   * **`text/plain` is the browser's own serialisation and has to stay that
   * way.** It is the key the shell matches a paste against: the system
   * clipboard holds whatever the browser put there, and a payload whose text
   * disagreed with it by one character would never be recognised as belonging
   * to it — the structure would be silently dropped on every paste. So the
   * string is left exactly as the selection produced it, row numbers and all.
   *
   * The **table** is built from the cells instead, which is what makes it worth
   * having: `td[data-ref]` is a cell of the sheet, the row-number gutter is not
   * one, and a cell that spans two columns is one value rather than a tab.
   */
  async copySelection(): Promise<ClipboardPayload | null> {
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text.trim()) return null;

    const payload = plainPayload(text, { editorId: 'org.uleditor.xlsx', uri: this.doc.uri });
    const table = this.#selectedCells(selection);
    return table ? { ...payload, 'application/x-uleditor-table': table } : payload;
  }

  /** The selected cells as rows, or nothing if the selection is not in a grid. */
  #selectedCells(selection: Selection | null): { rows: string[][]; headerRow: boolean } | null {
    const root = this.#root;
    if (!selection || selection.rangeCount === 0 || !root) return null;

    const rows: string[][] = [];
    const kinds: string[][] = [];
    for (const tr of root.querySelectorAll('table.ul-sheet tbody tr')) {
      const cells: string[] = [];
      const cellKinds: string[] = [];
      for (const cell of tr.querySelectorAll<HTMLElement>('td[data-ref]')) {
        /* `containsNode` with `partlyContained`, because a selection that
           starts in the middle of one cell and ends in the middle of another
           still means every cell between them. */
        if (!selection.containsNode(cell, true)) continue;
        cells.push(cell.textContent ?? '');
        cellKinds.push(cell.dataset.kind ?? '');
      }
      if (cells.length > 0) {
        rows.push(cells);
        kinds.push(cellKinds);
      }
    }

    if (rows.length === 0) return null;
    return { rows, headerRow: looksLikeHeader(kinds) };
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#root?.focus();
  }
}

/**
 * Whether the first of these rows is a heading rather than data.
 *
 * A spreadsheet has no such notion — a header row is a convention people keep,
 * not something the format records — so this is a guess, and it is made out of
 * what the cells *are* rather than what they say. Text across the whole of the
 * first row and something that is not text somewhere in the second is the shape
 * of a table with headings: `Month | Amount` over `January | 1.234,50`.
 *
 * Guessing wrong costs one row in the wrong place, and guessing at all is worth
 * it because the alternative is worse. Markdown has no headerless table: the
 * delimiter row is part of the syntax, so a table declared to have no heading
 * arrives with an empty one — a blank strip above the data in every renderer
 * that draws it.
 */
function looksLikeHeader(kinds: string[][]): boolean {
  const [first, second] = kinds;
  if (!first || first.length === 0 || !second || second.length === 0) return false;

  const allText = first.every((kind) => kind === 'text' || kind === '');
  const someNotText = second.some((kind) => kind !== 'text' && kind !== '');
  return allText && someNotText;
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
    return new DocumentPreviewEditor(host, doc, renderDocx(await doc.bytes()));
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
 * OpenDocument text — in the same reading room, and written back into itself.
 *
 * The same view a `.docx` gets, and now the same editor over it: text is
 * retyped in place, the `.odt` it came from is what a save writes, and every
 * byte outside the rewritten text is carried across untouched. What it takes to
 * do that in a format where the formatting is an ancestor rather than a sibling
 * is in [`odt-edit.ts`](./odt-edit.ts); what it takes to be sure the piece on
 * screen is the piece in the file is in `pairPieces`.
 */
export const odtPreviewProvider: EditorProvider = {
  id: 'org.uleditor.odt',
  displayName: 'OpenDocument Text',
  matches: {
    extensions: ['odt', 'ott'],
    mimeTypes: ['application/vnd.oasis.opendocument.text'],
  },
  /* `read` as well as `edit`, and for the same reason a `.docx` claims both:
     the reading room is the same room, and it is reached from the same view. */
  capabilities: ['view', 'search', 'read', 'edit'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new DocumentPreviewEditor(host, doc, readOdt(await doc.bytes()));
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
    return new DocumentPreviewEditor(host, doc, readDoc(await doc.bytes()));
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
    return new DocumentPreviewEditor(host, doc, readRtf(await doc.bytes()));
  },
};

export { readXls } from './xls.js';
export { readDoc, parseDoc } from './doc.js';
export { readRtf, parseRtf } from './rtf.js';
export { readOds, readOdt } from './odf.js';
export { DocumentPreviewEditor, XlsxPreviewEditor };
