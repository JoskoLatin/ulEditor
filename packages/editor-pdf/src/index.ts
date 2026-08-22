/**
 * The PDF viewer, annotator and page organiser.
 *
 * pdf.js displays, pdf-lib writes. On desktop, pdf.js is replaced in phase 1 by
 * pdfium through Rust; the `EditorInstance` contract stays the same, so the shell
 * does not see the difference.
 *
 * Page operations do not change the document until a save — there is only a plan
 * (see `document.ts`). Annotations bind to the SOURCE page, so reordering does
 * not separate a note from what it refers to.
 */

import { PDFDocument } from 'pdf-lib';
import { GlobalWorkerOptions, Util, getDocument } from 'pdfjs-dist';
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

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
  type ReadingOutlineItem,
  type ReadingProgress,
  type ReadingSession,
  type SaveResult,
  type SaveTarget,
} from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import {
  PALETTE,
  NOTE_SIZE,
  fidelityGaps,
  importAnnotations,
  newId,
  type Annotation,
  type Point,
  type Rect,
  type Rgb,
  type TextBoxAnnotation,
} from './annotations.js';
import { ensureWebFont, loadFontBytes } from './fonts.js';
import { fallbackWarning, findEditableLine, type EditableLine } from './edit.js';
import { applyRetype, unwritable } from './retype.js';
import { previewRedaction, type Redaction } from './redact.js';
import {
  DEFAULT_TEXT_SIZE,
  FONT_FAMILY,
  TEXT_FACES,
  TEXT_PADDING,
  TEXT_SIZES,
  layoutTextBox,
  linesOf,
  loadFace,
  standardWidths,
  topOf,
  type FaceMetrics,
  type StandardWidths,
  type TextFace,
} from './text.js';
import {
  describePlan,
  extractPages,
  identityPlan,
  isIdentity,
  mergeInto,
  movePage,
  parseRanges,
  removePage,
  rotatePage,
  pageMapOf,
  saveDocument,
  type PagePlan,
} from './document.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const MARGIN = 48;
/** Below this many pixels of drag we take it that the user merely clicked. */
const INK_MIN_LENGTH = 4;
/** The on-screen size of a note icon — independent of zoom. */
const NOTE_ICON_PX = 20;
const THUMB_WIDTH = 108;

type ZoomMode = 'fit-width' | 'fit-page' | 'custom';
type Tool = 'select' | 'highlight' | 'note' | 'ink' | 'text' | 'edit' | 'redact';

/** Fewer pixels than this is not a drag but a missed click. */
const REDACT_MIN_SIZE = 6;

/** Below this many pixels a move counts as a click, not as dragging the box. */
const TEXT_DRAG_SLOP = 3;

interface TextItemBox {
  str: string;
  start: number;
  end: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PageView {
  /** The page number in the source document — immutable. */
  source: number;
  /** The position in the current view, 1-based. Reordering changes it. */
  position: number;
  /** Dodatna rotacija iz plana. */
  rotate: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  textEl: HTMLElement;
  hitsEl: HTMLElement;
  annotEl: HTMLElement;
  page: PDFPageProxy;
  baseWidth: number;
  baseHeight: number;
  rendered: boolean;
  rendering: boolean;
  boxes: TextItemBox[] | null;
  text: string | null;
  imported: boolean;
}

interface Snapshot {
  annotations: Annotation[];
  redactions: Redaction[];
  plan: PagePlan[];
  /**
   * The source bytes at the moment of the snapshot. They are the same for every
   * step except a merge, which alone cannot be described by a plan over the old
   * source — so the reference is carried along to give merging an undo too.
   */
  source: Uint8Array;
  /**
   * Whether those bytes differ from the file on disk.
   *
   * Retyping a line changes the source itself rather than adding an annotation
   * over it, so nothing else in this snapshot shows that the document is
   * unsaved. Undo has to restore that fact along with the bytes.
   */
  sourceEdited: boolean;
}

/** A rewritten line stays one line; a break sends it down the other route. */
const NEWLINE = /[\r\n]/;

function cssRgb(color: Rgb, alpha = 1): string {
  const [r, g, b] = color;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

function rectToCss(viewport: PageViewport, rect: Rect) {
  const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
  const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

class PdfEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #scroll: HTMLElement | null = null;
  #rail: HTMLElement | null = null;
  #pageInput: HTMLInputElement | null = null;
  #zoomLabel: HTMLElement | null = null;
  #popup: HTMLElement | null = null;

  /** Ordered as displayed; `source` keeps the original page number. */
  #pages: PageView[] = [];
  #observer: IntersectionObserver | null = null;
  #resize: ResizeObserver | null = null;

  #scale = 1;
  #zoomMode: ZoomMode = 'fit-width';
  #current = 1;

  #plan: PagePlan[];
  #annotations: Annotation[] = [];
  /**
   * The areas whose text leaves the document itself.
   *
   * As with page operations: until the save there is only intent, so undo is an
   * ordinary removal from the list rather than restoring deleted content.
   */
  #redactions: Redaction[] = [];
  #undoStack: Snapshot[] = [];
  #redoStack: Snapshot[] = [];
  #dirty = false;
  #railOpen = false;

  #reading = false;
  #outline: ReadingOutlineItem[] = [];
  /** The outline targets SOURCE pages; the plan may move them. */
  #outlineTargets = new Map<string, number>();

  #tool: Tool = 'select';
  #color: Rgb = PALETTE[0]!.color;

  #textSize = DEFAULT_TEXT_SIZE;
  #textFace: TextFace = 'sans';
  /** Text has a colour of its own: yellow works as a highlight, not as a letter. */
  #textColor: Rgb = [0, 0, 0];
  /** The metrics of loaded faces; empty until a font is needed. */
  #metrics = new Map<TextFace, FaceMetrics>();

  /**
   * The box currently being typed.
   *
   * The draft is deliberately **not** in `#annotations` while typing is in
   * progress: that way each completed edit leaves exactly one step in the
   * history, rather than one per keystroke. `origin` is `null` when the box is
   * only just being created.
   */
  #editor: {
    view: PageView;
    draft: TextBoxAnnotation;
    origin: TextBoxAnnotation | null;
    input: HTMLTextAreaElement;
    warning: HTMLElement;
    /** Covers the line being replaced, in the paper's own colour. */
    cover: HTMLElement | null;
    metrics: FaceMetrics;
    /** The area of the source line this edit replaces. */
    replaces: Rect | null;
    /**
     * The line being rewritten, when there is one.
     *
     * Its font is what decides the route: it is asked, on every keystroke,
     * whether it can write what has been typed so far. It can for the vast
     * majority of edits — a wrong figure, a misspelt name — and then the line
     * goes back into the content stream in the document's own letterforms.
     */
    line: EditableLine | null;
    /** What has to be said before saving, regardless of typing. */
    notes: string[];
  } | null = null;

  /**
   * A retype being written into the source.
   *
   * Held so a save cannot start in the middle of one and write the document as
   * it was a moment ago. Nothing else waits on it: the page is redrawn when it
   * finishes, and until then it shows what the user typed.
   */
  #committing: Promise<void> | null = null;
  /** The source differs from the file on disk — see `Snapshot.sourceEdited`. */
  #sourceEdited = false;

  #drawing: { view: PageView; points: Point[] } | null = null;
  #marquee: { view: PageView; origin: Point; el: HTMLElement } | null = null;

  /** The document opened to read its content; it tracks `source`. */
  #contentDoc: { source: Uint8Array; doc: Promise<PDFDocument> } | null = null;
  #standard: Promise<StandardWidths> | null = null;

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  #progressEmitter = new Emitter<ReadingProgress>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly docHandle: DocumentHandle,
    /** Not `readonly`: merging replaces both the document and its bytes. */
    private pdf: PDFDocumentProxy,
    private source: Uint8Array,
  ) {
    this.#plan = identityPlan(pdf.numPages);
  }

  /* ── mounting ──────────────────────────────────────────────────────── */

  async mount(container: HTMLElement): Promise<void> {
    const root = document.createElement('div');
    root.className = 'ul-pdf';
    root.dataset.tool = this.#tool;

    const body = document.createElement('div');
    body.className = 'ul-pdf-body';

    const rail = document.createElement('div');
    rail.className = 'ul-pdf-rail';

    const scroll = document.createElement('div');
    scroll.className = 'ul-pdf-scroll';

    body.append(rail, scroll);
    root.append(this.#buildToolbar(), body);
    container.appendChild(root);

    this.#root = root;
    this.#scroll = scroll;
    this.#rail = rail;

    await this.#buildPages();

    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const source = Number((entry.target as HTMLElement).dataset.source);
          const view = this.#pages.find((v) => v.source === source);
          if (view && entry.isIntersecting) void this.#renderPage(view);
        }
        this.#updateCurrentPage();
      },
      { root: scroll, rootMargin: '100% 0px' },
    );
    for (const view of this.#pages) this.#observer.observe(view.el);

    scroll.addEventListener('scroll', () => this.#updateCurrentPage(), { passive: true });
    scroll.addEventListener('wheel', this.#onWheel, { passive: false });
    scroll.addEventListener('mouseup', this.#onMouseUp);

    this.#resize = new ResizeObserver(() => {
      if (this.#zoomMode !== 'custom') void this.#applyZoom();
    });
    this.#resize.observe(scroll);

    await this.#applyZoom();
    this.#emitStatus();
  }

  #buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ul-pdf-toolbar';

    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'ul-pdf-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    const sep = () => {
      const s = document.createElement('span');
      s.className = 'sep';
      return s;
    };

    const railToggle = button('▤', t('Pages — rotate, delete, reorder'), () =>
      this.toggleRail(),
    );

    const prev = button('‹', t('Previous page'), () => this.goToPage(this.#current - 1));
    const next = button('›', t('Next page'), () => this.goToPage(this.#current + 1));

    const input = document.createElement('input');
    input.className = 'ul-pdf-page-input';
    input.value = '1';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', t('Page number'));
    input.addEventListener('change', () => this.goToPage(Number(input.value)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.goToPage(Number(input.value));
    });
    this.#pageInput = input;

    const total = document.createElement('span');
    total.className = 'ul-pdf-total';
    total.style.padding = '0 4px';

    const zoomOut = button('−', t('Zoom out (Ctrl + wheel)'), () => this.zoomBy(-1));
    const zoomIn = button('+', t('Zoom in (Ctrl + wheel)'), () => this.zoomBy(1));
    const zoomLabel = document.createElement('span');
    zoomLabel.style.minWidth = '44px';
    zoomLabel.style.textAlign = 'center';
    this.#zoomLabel = zoomLabel;

    const fitWidth = button(t('Width'), t('Fit width'), () => this.setZoomMode('fit-width'));
    const fitPage = button(t('Page'), t('Fit page'), () => this.setZoomMode('fit-page'));

    const tools: { tool: Tool; label: string; title: string }[] = [
      { tool: 'select', label: '⌖', title: t('Select and highlight text') },
      { tool: 'highlight', label: '▬', title: t('Highlight selected text') },
      { tool: 'note', label: '✎', title: t('Note — click the page') },
      { tool: 'ink', label: '〰', title: t('Freehand drawing') },
      { tool: 'text', label: 'T', title: t('Add text — click where it should go') },
      /*
       * Two characters where the others have one, and deliberately: this is the
       * tool people come looking for, and `T` with a pencil says what it does
       * without a legend. A single glyph for "rewrite" does not exist that a
       * person would read correctly on sight.
       */
      { tool: 'edit', label: 'T✎', title: t('Rewrite text — click a line of the document') },
      { tool: 'redact', label: '⌫', title: t('Erase text — drag over what should go') },
    ];
    const toolButtons = new Map<Tool, HTMLButtonElement>();
    /* A class, not an inline style: on a narrow screen the bar turns upright and
       the group has to wrap, which an inline style would override. */
    const toolGroup = document.createElement('span');
    toolGroup.className = 'ul-pdf-tools';
    for (const { tool, label, title } of tools) {
      const b = button(label, title, () => this.setTool(tool));
      b.classList.add('ul-pdf-tool');
      toolButtons.set(tool, b);
      toolGroup.appendChild(b);
    }

    const swatches = document.createElement('span');
    swatches.className = 'ul-pdf-swatches';
    const swatchButtons: { el: HTMLButtonElement; color: Rgb }[] = [];
    for (const { name, color } of PALETTE) {
      const b = document.createElement('button');
      b.className = 'ul-pdf-swatch';
      b.title = name;
      b.setAttribute('aria-label', `Boja: ${name}`);
      b.style.background = cssRgb(color);
      b.addEventListener('click', () => this.setColor(color));
      swatches.appendChild(b);
      swatchButtons.push({ el: b, color });
    }

    /* The face and the size concern writing text only, so CSS reveals them once
       that tool is selected — otherwise the bar would carry two controls that do
       nothing ninety per cent of the time. */
    const textOpts = document.createElement('span');
    textOpts.className = 'ul-pdf-text-opts';

    const faceSelect = document.createElement('select');
    faceSelect.className = 'ul-pdf-select';
    faceSelect.setAttribute('aria-label', t('Font style'));
    for (const { id, label } of TEXT_FACES) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = t(label);
      faceSelect.appendChild(option);
    }
    faceSelect.addEventListener('change', () => this.setTextFace(faceSelect.value as TextFace));

    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'ul-pdf-select';
    sizeSelect.setAttribute('aria-label', t('Font size'));
    for (const size of TEXT_SIZES) {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      sizeSelect.appendChild(option);
    }
    sizeSelect.addEventListener('change', () => this.setTextSize(Number(sizeSelect.value)));

    textOpts.append(faceSelect, sizeSelect);

    const count = document.createElement('span');
    count.className = 'ul-pdf-count';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    bar.append(
      railToggle, sep(),
      prev, input, total, next, sep(),
      zoomOut, zoomLabel, zoomIn, sep(),
      fitWidth, fitPage, sep(),
      toolGroup, swatches, textOpts,
      spacer, count,
    );

    this.#syncToolbar = () => {
      railToggle.dataset.active = String(this.#railOpen);
      fitWidth.dataset.active = String(this.#zoomMode === 'fit-width');
      fitPage.dataset.active = String(this.#zoomMode === 'fit-page');
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
      total.textContent = `/ ${this.#plan.length}`;

      for (const [tool, b] of toolButtons) b.dataset.active = String(this.#tool === tool);
      const active = this.#activeColor();
      for (const { el, color } of swatchButtons) {
        el.dataset.active = String(color.every((c, i) => Math.abs(c - active[i]!) < 0.001));
      }
      faceSelect.value = this.#textFace;
      sizeSelect.value = String(this.#textSize);

      const parts: string[] = [];
      if (this.#annotations.length) parts.push(`${this.#annotations.length} anot.`);
      if (this.#redactions.length) parts.push(`${this.#redactions.length} obr.`);
      parts.push(...describePlan(this.#plan, this.pdf.numPages));
      count.textContent = parts.join('  ·  ');
    };

    return bar;
  }

  #syncToolbar: () => void = () => {};

  async #buildPages(): Promise<void> {
    for (let n = 1; n <= this.pdf.numPages; n++) {
      const page = await this.pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });

      const el = document.createElement('div');
      el.className = 'ul-pdf-page';
      el.dataset.source = String(n);
      el.dataset.page = String(n);
      el.dataset.rendered = 'false';

      const canvas = document.createElement('canvas');
      const textEl = document.createElement('div');
      textEl.className = 'ul-pdf-text';
      const hitsEl = document.createElement('div');
      hitsEl.className = 'ul-pdf-hits';
      const annotEl = document.createElement('div');
      annotEl.className = 'ul-pdf-annots';

      el.append(canvas, textEl, hitsEl, annotEl);
      this.#scroll?.appendChild(el);

      const view: PageView = {
        source: n,
        position: n,
        rotate: 0,
        el,
        canvas,
        textEl,
        hitsEl,
        annotEl,
        page,
        baseWidth: viewport.width,
        baseHeight: viewport.height,
        rendered: false,
        rendering: false,
        boxes: null,
        text: null,
        imported: false,
      };

      annotEl.addEventListener('pointerdown', (e) => this.#onPointerDown(e, view));
      this.#pages.push(view);
    }
  }

  /* ── the page plan ─────────────────────────────────────────────────── */

  toggleRail(): void {
    this.#railOpen = !this.#railOpen;
    if (this.#root) this.#root.dataset.rail = String(this.#railOpen);
    if (this.#railOpen) void this.#renderRail();
    this.#syncToolbar();
  }

  get plan(): readonly PagePlan[] {
    return this.#plan;
  }

  #setPlan(plan: PagePlan[]): void {
    if (plan === this.#plan) return;
    this.#snapshot();
    this.#plan = plan;
    void this.#applyPlan();
  }

  rotate(position: number, delta: number): void {
    this.#setPlan(rotatePage(this.#plan, position - 1, delta));
  }

  deletePage(position: number): void {
    if (this.#plan.length <= 1) {
      this.host.notify.show('warning', t('A document must keep at least one page.'));
      return;
    }
    this.#setPlan(removePage(this.#plan, position - 1));
  }

  movePageTo(position: number, delta: number): void {
    this.#setPlan(movePage(this.#plan, position - 1, delta));
  }

  /* ── merging and extracting ────────────────────────────────────────── */

  /**
   * Reloading the document from new bytes.
   *
   * Only a merge requires it: afterwards there are pages that do not exist in the
   * loaded pdf.js document, so the plan can no longer be resolved against it.
   * Rotation, deletion and reordering still work over the same document.
   */
  async #reload(
    bytes: Uint8Array,
    plan: PagePlan[],
    opts?: { keepPosition?: boolean },
  ): Promise<void> {
    const scroll = this.#scroll;
    if (!scroll) return;

    /* Retyping a line rebuilds every page, and without this the document would
       jump to the top on each correction — which is unusable on page forty. The
       pages are the same size as before, so the same offset is the same place. */
    const at = opts?.keepPosition ? scroll.scrollTop : null;

    this.#observer?.disconnect();
    for (const view of this.#pages) {
      view.page.cleanup();
      view.el.remove();
    }
    this.#pages = [];

    const previous = this.pdf;
    this.source = bytes;
    // pdf.js takes over and detaches its buffer, so it gets a copy of its own.
    this.pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
    void previous.destroy();

    this.#plan = plan;
    await this.#buildPages();
    for (const view of this.#pages) this.#observer?.observe(view.el);
    await this.#applyPlan();
    if (at !== null) scroll.scrollTop = at;
  }

  /** Inserts the pages of another PDF after the current one. */
  async mergeFrom(incoming: Uint8Array, at = this.#current): Promise<number> {
    const result = await mergeInto(this.source, this.#plan, incoming, at);
    this.#snapshot();
    await this.#reload(result.bytes, result.plan);
    return result.added;
  }

  /** Opens the file picker and inserts it — the action from the pages rail. */
  async insertPdf(): Promise<void> {
    try {
      const [picked] = await this.host.fs.pickFiles({ extensions: ['pdf'] });
      if (!picked) return;

      const added = await this.mergeFrom(await picked.bytes());
      this.host.notify.show(
        'info',
        t('Inserted {n} pages from {name}. Bookmarks and forms of the inserted document are not carried over.', {
          n: added,
          name: picked.name,
        }),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.host.notify.show(
        'error',
        t('Insert failed: {reason}', { reason: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  /**
   * Extracts a range of pages into a new file. The source stays untouched —
   * nobody wants their document halved on disk because they wanted three pages
   * out of it.
   */
  async extractTo(ranges: string): Promise<void> {
    const positions = parseRanges(ranges, this.#plan.length);
    if (positions.length === 0) {
      this.host.notify.show(
        'warning',
        t('The range "{range}" covers no existing page.', { range: ranges }),
      );
      return;
    }

    try {
      const base = this.docHandle.name.replace(/\.pdf$/i, '');
      const target = await this.host.fs.pickSaveTarget(`${base} - ${t('pages')}.pdf`, ['pdf']);
      if (!target) return;

      await this.host.fs.writeBytes(target, await extractPages(this.source, [...this.#plan], positions));
      this.host.notify.show('info', t('Extracted {n} pages.', { n: positions.length }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.host.notify.show(
        'error',
        t('Extract failed: {reason}', { reason: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  /** Brings the DOM and the view state into line with the current plan. */
  async #applyPlan(): Promise<void> {
    const scroll = this.#scroll;
    if (!scroll) return;

    const bySource = new Map(this.#pages.map((view) => [view.source, view]));
    const ordered: PageView[] = [];

    for (const [index, entry] of this.#plan.entries()) {
      const view = bySource.get(entry.source);
      if (!view) continue;
      view.position = index + 1;
      view.rotate = entry.rotate;
      view.el.dataset.page = String(index + 1);
      ordered.push(view);
    }

    // Pages outside the plan were deleted — they leave the display, but the view
    // is kept because undo can bring them back.
    for (const view of this.#pages) {
      if (!ordered.includes(view)) view.el.remove();
    }
    for (const view of ordered) scroll.appendChild(view.el);

    this.#pages = [...ordered, ...this.#pages.filter((v) => !ordered.includes(v))];

    for (const view of ordered) {
      view.rendered = false;
      view.el.dataset.rendered = 'false';
    }

    this.#markDirty();
    this.#syncToolbar();
    await this.#applyZoom();
    if (this.#railOpen) await this.#renderRail();
    this.#emitStatus();
  }

  /* ── the thumbnail rail ────────────────────────────────────────────── */

  async #renderRail(): Promise<void> {
    const rail = this.#rail;
    if (!rail) return;

    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.#buildRailActions());

    for (const [index, entry] of this.#plan.entries()) {
      const view = this.#pages.find((v) => v.source === entry.source);
      if (!view) continue;

      const item = document.createElement('div');
      item.className = 'ul-pdf-thumb';
      item.dataset.position = String(index + 1);
      item.dataset.current = String(index + 1 === this.#current);

      const canvas = document.createElement('canvas');
      canvas.addEventListener('click', () => this.goToPage(index + 1));
      item.appendChild(canvas);

      const label = document.createElement('span');
      label.className = 'num';
      label.textContent = String(index + 1);
      if (entry.source !== index + 1 || entry.rotate !== 0) label.dataset.changed = 'true';
      item.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const action = (label: string, title: string, onClick: () => void, disabled = false) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
        return b;
      };

      actions.append(
        action('↺', t('Rotate left'), () => this.rotate(index + 1, -90)),
        action('↻', t('Rotate right'), () => this.rotate(index + 1, 90)),
        action('↑', t('Move up'), () => this.movePageTo(index + 1, -1), index === 0),
        action('↓', t('Move down'), () => this.movePageTo(index + 1, 1), index === this.#plan.length - 1),
        action('✕', t('Delete page'), () => this.deletePage(index + 1), this.#plan.length <= 1),
      );
      item.appendChild(actions);
      fragment.appendChild(item);

      // The thumbnail is drawn after insertion so the canvas has a measured width.
      void this.#renderThumb(view, canvas, entry.rotate);
    }

    rail.replaceChildren(fragment);
  }

  /** Actions over the whole document, above the thumbnails. */
  #buildRailActions(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ul-pdf-rail-actions';

    const insert = document.createElement('button');
    insert.className = 'ul-pdf-rail-btn';
    insert.textContent = t('Insert PDF…');
    insert.title = t('Inserts the pages of another PDF after the current one');
    insert.addEventListener('click', () => void this.insertPdf());

    const row = document.createElement('div');
    row.className = 'ul-pdf-rail-extract';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `npr. 1-3, 7`;
    input.title = t('Page ranges to extract');
    input.value = String(this.#current);

    const extract = document.createElement('button');
    extract.className = 'ul-pdf-rail-btn';
    extract.textContent = t('Extract');
    extract.title = t('Saves the chosen pages to a new file; the original stays untouched');
    extract.addEventListener('click', () => void this.extractTo(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.extractTo(input.value);
    });

    row.append(input, extract);
    box.append(insert, row);
    return box;
  }

  async #renderThumb(view: PageView, canvas: HTMLCanvasElement, rotate: number): Promise<void> {
    try {
      const scale = THUMB_WIDTH / view.baseWidth;
      const viewport = view.page.getViewport({
        scale,
        rotation: (view.page.rotate + rotate) % 360,
      });
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;

      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;

      await view.page.render({ canvasContext: context, viewport }).promise;
    } catch (err) {
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
        console.warn(`[uleditor] the thumbnail for page ${view.source} was not drawn`, err);
      }
    }
  }

  /* ── alati ─────────────────────────────────────────────────────────── */

  setTool(tool: Tool): void {
    this.#tool = tool;
    if (this.#root) this.#root.dataset.tool = tool;
    this.#closePopup();
    this.#finishTextEdit();
    // The font is fetched the moment the user reaches for the tool, not on the
    // first click — otherwise the first box appears after a visible wait.
    if (tool === 'text' || tool === 'edit') void this.#face(this.#textFace);
    this.#syncToolbar();
  }

  setColor(color: Rgb): void {
    if (this.#tool === 'text' || this.#tool === 'edit' || this.#editor) {
      this.#textColor = color;
      this.#applyToEditedBox({ color });
    } else {
      this.#color = color;
    }
    this.#syncToolbar();
  }

  /** The colour the swatches refer to — it depends on what is being done. */
  #activeColor(): Rgb {
    return this.#tool === 'text' || this.#tool === 'edit' || this.#editor
      ? this.#textColor
      : this.#color;
  }

  setTextFace(face: TextFace): void {
    this.#textFace = face;
    void this.#face(face).then(() => this.#applyToEditedBox({ face }));
    this.#syncToolbar();
  }

  setTextSize(size: number): void {
    if (!Number.isFinite(size) || size <= 0) return;
    this.#textSize = size;
    this.#applyToEditedBox({ size });
    this.#syncToolbar();
  }

  get tool(): Tool {
    return this.#tool;
  }

  /**
   * The metrics of one face, ready for synchronous use.
   *
   * Alongside the bytes, the same font is registered in the browser, because the
   * box on screen and the box in the file must have the same width.
   */
  async #face(face: TextFace): Promise<FaceMetrics> {
    const ready = this.#metrics.get(face);
    if (ready) return ready;

    void ensureWebFont(face).catch(() => {});
    const metrics = await loadFace(face, loadFontBytes);
    this.#metrics.set(face, metrics);
    return metrics;
  }

  /* ── zoom ──────────────────────────────────────────────────────────── */

  setZoomMode(mode: ZoomMode): void {
    this.#zoomMode = mode;
    void this.#applyZoom();
  }

  zoomBy(direction: number): void {
    const index = ZOOM_STEPS.findIndex((s) => s >= this.#scale - 0.001);
    const nextIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
    this.#zoomMode = 'custom';
    this.#scale = ZOOM_STEPS[nextIndex] ?? 1;
    void this.#applyZoom();
  }

  #onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1 : -1);
  };

  /** The page dimensions with the plan's rotation — 90° swaps width and height. */
  #sizeOf(view: PageView): { width: number; height: number } {
    const swap = (view.rotate / 90) % 2 !== 0;
    return swap
      ? { width: view.baseHeight, height: view.baseWidth }
      : { width: view.baseWidth, height: view.baseHeight };
  }

  #visiblePages(): PageView[] {
    const sources = new Set(this.#plan.map((e) => e.source));
    return this.#pages.filter((v) => sources.has(v.source)).sort((a, b) => a.position - b.position);
  }

  async #applyZoom(): Promise<void> {
    const scroll = this.#scroll;
    const visible = this.#visiblePages();
    const first = visible[0];
    if (!scroll || !first) return;

    const firstSize = this.#sizeOf(first);
    if (this.#zoomMode === 'fit-width') {
      this.#scale = Math.max(0.1, (scroll.clientWidth - MARGIN) / firstSize.width);
    } else if (this.#zoomMode === 'fit-page') {
      this.#scale = Math.max(
        0.1,
        Math.min(
          (scroll.clientWidth - MARGIN) / firstSize.width,
          (scroll.clientHeight - MARGIN) / firstSize.height,
        ),
      );
    }

    const anchor = this.#current;

    for (const view of visible) {
      const size = this.#sizeOf(view);
      view.el.style.width = `${Math.round(size.width * this.#scale)}px`;
      view.el.style.height = `${Math.round(size.height * this.#scale)}px`;
      view.rendered = false;
      view.el.dataset.rendered = 'false';
      view.hitsEl.replaceChildren();
    }

    // After a scale change the pages have different heights, so the same
    // `scrollTop` no longer points at the same page. Without this, every zoom
    // change and every window resize throws the reader off their place.
    const target = visible[anchor - 1];
    if (target) scroll.scrollTop = Math.max(0, target.el.offsetTop - 20);

    this.#syncToolbar();
    await this.#renderVisible();
  }

  async #renderVisible(): Promise<void> {
    const scroll = this.#scroll;
    if (!scroll) return;
    const top = scroll.scrollTop - scroll.clientHeight;
    const bottom = scroll.scrollTop + scroll.clientHeight * 2;

    for (const view of this.#visiblePages()) {
      const y = view.el.offsetTop;
      if (y + view.el.offsetHeight >= top && y <= bottom) await this.#renderPage(view);
    }
  }

  /* ── page rendering ────────────────────────────────────────────────── */

  #viewportFor(view: PageView, scale = this.#scale): PageViewport {
    return view.page.getViewport({ scale, rotation: (view.page.rotate + view.rotate) % 360 });
  }

  async #renderPage(view: PageView): Promise<void> {
    if (view.rendered || view.rendering) return;
    view.rendering = true;

    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = this.#viewportFor(view, this.#scale * dpr);
      const context = view.canvas.getContext('2d', { alpha: false });
      if (!context) return;

      const size = this.#sizeOf(view);
      view.canvas.width = Math.round(viewport.width);
      view.canvas.height = Math.round(viewport.height);
      view.canvas.style.width = `${Math.round(size.width * this.#scale)}px`;
      view.canvas.style.height = `${Math.round(size.height * this.#scale)}px`;

      await view.page.render({ canvasContext: context, viewport }).promise;

      await this.#buildTextLayer(view);
      await this.#importPageAnnotations(view);
      this.#renderAnnotations(view);

      view.rendered = true;
      view.el.dataset.rendered = 'true';
    } catch (err) {
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
        console.error(`[uleditor] rendering page ${view.source} failed`, err);
      }
    } finally {
      view.rendering = false;
    }
  }

  async #buildTextLayer(view: PageView): Promise<void> {
    const viewport = this.#viewportFor(view);
    const content = await view.page.getTextContent();

    const fragment = document.createDocumentFragment();
    const boxes: TextItemBox[] = [];
    let offset = 0;
    let text = '';

    for (const item of content.items) {
      if (!('str' in item)) continue;
      const str = item.str;
      if (!str) continue;

      const tx = Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(tx[2], tx[3]);
      if (height <= 0) continue;

      const left = tx[4];
      const top = tx[5] - height;
      const width = item.width * this.#scale;

      const span = document.createElement('span');
      span.textContent = str;
      span.style.left = `${left}px`;
      span.style.top = `${top}px`;
      span.style.fontSize = `${height}px`;
      span.style.fontFamily = 'sans-serif';
      span.dataset.width = String(width);
      fragment.appendChild(span);

      boxes.push({ str, start: offset, end: offset + str.length, left, top, width, height });
      text += str;
      offset += str.length;

      if (item.hasEOL) {
        text += '\n';
        offset += 1;
      }
    }

    view.textEl.replaceChildren(fragment);

    const spans = view.textEl.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i] as HTMLElement;
      const target = Number(span.dataset.width);
      const actual = span.getBoundingClientRect().width;
      if (target > 0 && actual > 0) span.style.transform = `scaleX(${target / actual})`;
    }

    view.boxes = boxes;
    view.text = text;
  }

  async #importPageAnnotations(view: PageView): Promise<void> {
    if (view.imported) return;
    view.imported = true;

    try {
      const raw = await view.page.getAnnotations();
      const imported = importAnnotations(raw as unknown[], view.source);
      if (imported.length > 0) {
        this.#annotations = [...this.#annotations, ...imported];
        this.#syncToolbar();
      }
    } catch (err) {
      console.warn(`[uleditor] annotations for page ${view.source} failed to load`, err);
    }
  }

  /* ── sloj anotacija ────────────────────────────────────────────────── */

  #renderAnnotations(view: PageView): void {
    const viewport = this.#viewportFor(view);
    const fragment = document.createDocumentFragment();

    /*
     * An area marked for redaction is drawn as an **intent**, not as finished
     * work: the text underneath still shows through. An opaque patch would look
     * as though it had already been deleted, and that is precisely the false
     * impression a black rectangle leaves in other tools.
     */
    for (const redaction of this.#redactions) {
      if (redaction.page !== view.source) continue;
      const box = rectToCss(viewport, redaction.rect);
      const el = document.createElement('button');
      el.className = 'ul-pdf-ann ul-pdf-redaction';
      el.dataset.id = redaction.id;
      el.dataset.applied = String(!!redaction.applied);
      el.dataset.replaced = String(!!redaction.replaced);
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
      el.title = redaction.applied
        ? t('Removed on save — click to bring the text back')
        : t('Marked for removal — click to undo');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#removeRedaction(redaction.id);
      });
      fragment.appendChild(el);
    }

    for (const annotation of this.#annotations) {
      // It binds to the SOURCE page, so reordering does not separate a note from
      // what it refers to.
      if (annotation.page !== view.source) continue;

      if (annotation.kind === 'highlight') {
        for (const quad of annotation.quads) {
          const box = rectToCss(viewport, quad);
          const el = document.createElement('div');
          el.className = 'ul-pdf-ann ul-pdf-ann-highlight';
          el.dataset.id = annotation.id;
          el.style.left = `${box.left}px`;
          el.style.top = `${box.top}px`;
          el.style.width = `${box.width}px`;
          el.style.height = `${box.height}px`;
          el.style.background = cssRgb(annotation.color, 0.38);
          fragment.appendChild(el);
        }
        continue;
      }

      if (annotation.kind === 'text') {
        // While a box is being typed, its static rendering would be drawn twice
        // underneath the `<textarea>`.
        if (this.#editor?.draft.id === annotation.id) continue;

        const el = document.createElement('div');
        el.className = 'ul-pdf-ann ul-pdf-ann-text';
        el.dataset.id = annotation.id;
        el.textContent = annotation.text;
        Object.assign(el.style, this.#textStyle(annotation, this.#metrics.get(annotation.face)));
        this.#placeTextElement(el, view, annotation);
        el.addEventListener('pointerdown', (e) => this.#beginTextDrag(e, view, annotation.id));
        fragment.appendChild(el);
        continue;
      }

      if (annotation.kind === 'note') {
        const box = rectToCss(viewport, annotation.rect);
        const el = document.createElement('button');
        el.className = 'ul-pdf-ann ul-pdf-ann-note';
        el.dataset.id = annotation.id;
        el.style.left = `${box.left}px`;
        el.style.top = `${box.top}px`;
        // A fixed on-screen size, as in every PDF reader: a note is a marker, not
        // page content, so it must not balloon with the zoom.
        el.style.width = `${NOTE_ICON_PX}px`;
        el.style.height = `${NOTE_ICON_PX}px`;
        el.style.background = cssRgb(annotation.color);
        el.title = annotation.text || t('Note');
        el.textContent = '✎';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#openNotePopup(view, annotation.id);
        });
        fragment.appendChild(el);
        continue;
      }

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ul-pdf-ann ul-pdf-ann-ink');
      svg.dataset.id = annotation.id;
      svg.style.left = '0';
      svg.style.top = '0';

      for (const stroke of annotation.strokes) {
        if (stroke.length === 0) continue;
        const points = stroke.map((p) => {
          const [cx, cy] = viewport.convertToViewportPoint(p.x, p.y);
          return `${cx.toFixed(1)},${cy.toFixed(1)}`;
        });
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path.setAttribute('points', points.join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', cssRgb(annotation.color));
        path.setAttribute('stroke-width', String(annotation.width * this.#scale));
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
      }
      fragment.appendChild(svg);
    }

    view.annotEl.replaceChildren(fragment);

    /* The typing field lives in the same layer, so `replaceChildren` would remove
       it on every refresh — for instance when the zoom changes. It is put back
       and recomputed rather than having the edit interrupted. */
    const editor = this.#editor;
    if (editor && editor.view === view) {
      Object.assign(editor.input.style, this.#textStyle(editor.draft, editor.metrics));
      this.#placeTextElement(editor.input, view, editor.draft);
      if (editor.cover) view.annotEl.append(editor.cover);
      view.annotEl.append(editor.input, editor.warning);
      this.#warnAboutGlyphs();
    }
  }

  #renderAllAnnotations(): void {
    for (const view of this.#pages) {
      if (view.rendered) this.#renderAnnotations(view);
    }
    this.#syncToolbar();
  }

  /* ── povijest ──────────────────────────────────────────────────────── */

  #snapshot(): void {
    this.#undoStack.push(this.#capture());
    this.#redoStack = [];
    if (this.#undoStack.length > 30) this.#undoStack.shift();
  }

  #capture(): Snapshot {
    return {
      annotations: this.#annotations.map((a) => ({ ...a })),
      redactions: this.#redactions.map((r) => ({ ...r })),
      plan: this.#plan.map((p) => ({ ...p })),
      source: this.source,
      sourceEdited: this.#sourceEdited,
    };
  }

  #restore(snapshot: Snapshot): void {
    // Undoing a merge restores the document itself, not just the plan.
    if (snapshot.source !== this.source) {
      this.#annotations = snapshot.annotations;
      this.#redactions = snapshot.redactions;
      this.#sourceEdited = snapshot.sourceEdited;
      /* A retype leaves the pages where they are, so the reader stays where it
         was reading; undoing a merge changes the document itself and there is
         no position to keep. */
      void this.#reload(snapshot.source, snapshot.plan, {
        keepPosition: snapshot.plan.length === this.#plan.length,
      });
      return;
    }

    const planChanged =
      snapshot.plan.length !== this.#plan.length ||
      snapshot.plan.some((entry, i) => {
        const current = this.#plan[i];
        return !current || current.source !== entry.source || current.rotate !== entry.rotate;
      });

    this.#annotations = snapshot.annotations;
    this.#redactions = snapshot.redactions;
    this.#sourceEdited = snapshot.sourceEdited;
    this.#plan = snapshot.plan;

    if (planChanged) void this.#applyPlan();
    else {
      this.#markDirty();
      this.#renderAllAnnotations();
      this.#emitStatus();
    }
  }

  #markDirty(): void {
    const dirty =
      this.#sourceEdited ||
      this.#annotations.some((a) => !a.imported) ||
      this.#redactions.some((r) => !r.applied) ||
      !isIdentity(this.#plan, this.pdf.numPages);
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.#dirtyEmitter.fire(dirty);
  }

  #add(annotation: Annotation): void {
    this.#snapshot();
    this.#annotations = [...this.#annotations, annotation];
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  }

  #remove(id: string): void {
    this.#snapshot();
    this.#annotations = this.#annotations.filter((a) => a.id !== id);
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  }

  /* ── stvaranje anotacija ───────────────────────────────────────────── */

  #onMouseUp = (): void => {
    if (this.#tool !== 'highlight') return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (rects.length === 0) return;

    const byPage = new Map<PageView, Rect[]>();
    for (const rect of rects) {
      const view = this.#pageAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!view) continue;

      const bounds = view.el.getBoundingClientRect();
      const viewport = this.#viewportFor(view);
      const [x1, y1] = viewport.convertToPdfPoint(rect.left - bounds.left, rect.top - bounds.top);
      const [x2, y2] = viewport.convertToPdfPoint(rect.right - bounds.left, rect.bottom - bounds.top);

      const quad: Rect = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
      const list = byPage.get(view) ?? [];
      list.push(quad);
      byPage.set(view, list);
    }

    if (byPage.size === 0) return;

    this.#snapshot();
    for (const [view, quads] of byPage) {
      this.#annotations = [
        ...this.#annotations,
        {
          id: newId(),
          kind: 'highlight',
          page: view.source,
          color: this.#color,
          createdAt: Date.now(),
          quads,
        },
      ];
    }
    selection.removeAllRanges();
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  };

  #pageAt(clientX: number, clientY: number): PageView | null {
    for (const view of this.#visiblePages()) {
      const rect = view.el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return view;
      }
    }
    return null;
  }

  #onPointerDown(event: PointerEvent, view: PageView): void {
    // The note popup and the existing annotations live inside the layer that
    // listens for this event. Without this check, clicking "Save" in the popup
    // creates a new note underneath it.
    const target = event.target as HTMLElement | null;
    if (target?.closest('.ul-pdf-note-popup, .ul-pdf-ann')) return;

    if (this.#tool === 'note') {
      event.preventDefault();
      const bounds = view.el.getBoundingClientRect();
      const viewport = this.#viewportFor(view);
      const [x, y] = viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);

      const annotation: Annotation = {
        id: newId(),
        kind: 'note',
        page: view.source,
        color: this.#color,
        createdAt: Date.now(),
        rect: { x, y: y - NOTE_SIZE, width: NOTE_SIZE, height: NOTE_SIZE },
        text: '',
      };
      this.#add(annotation);
      this.#openNotePopup(view, annotation.id);
      return;
    }

    if (this.#tool === 'text' || this.#tool === 'edit') {
      event.preventDefault();
      // A click beside an open box finishes that one first; a second click opens a new one.
      if (this.#editor) {
        this.#finishTextEdit();
        return;
      }
      if (this.#tool === 'edit') void this.#rewriteLine(view, event.clientX, event.clientY);
      else void this.#startTextBox(view, event.clientX, event.clientY);
      return;
    }

    if (this.#tool === 'redact') {
      event.preventDefault();
      this.#beginMarquee(event, view);
      return;
    }

    if (this.#tool === 'ink') {
      event.preventDefault();
      view.annotEl.setPointerCapture(event.pointerId);
      const bounds = view.el.getBoundingClientRect();
      this.#drawing = {
        view,
        points: [{ x: event.clientX - bounds.left, y: event.clientY - bounds.top }],
      };

      const onMove = (move: PointerEvent) => {
        if (!this.#drawing) return;
        this.#drawing.points.push({ x: move.clientX - bounds.left, y: move.clientY - bounds.top });
        this.#previewInk();
      };
      const onUp = () => {
        view.annotEl.removeEventListener('pointermove', onMove);
        view.annotEl.removeEventListener('pointerup', onUp);
        view.annotEl.removeEventListener('pointercancel', onUp);
        this.#commitInk();
      };

      view.annotEl.addEventListener('pointermove', onMove);
      view.annotEl.addEventListener('pointerup', onUp);
      view.annotEl.addEventListener('pointercancel', onUp);
    }
  }

  #previewInk(): void {
    const drawing = this.#drawing;
    if (!drawing) return;

    let preview = drawing.view.annotEl.querySelector<SVGSVGElement>('.ul-pdf-ink-preview');
    if (!preview) {
      preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      preview.setAttribute('class', 'ul-pdf-ann ul-pdf-ink-preview');
      drawing.view.annotEl.appendChild(preview);
    }

    const points = drawing.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    preview.innerHTML = `<polyline points="${points}" fill="none" stroke="${cssRgb(this.#color)}" stroke-width="${
      2 * this.#scale
    }" stroke-linecap="round" stroke-linejoin="round" />`;
  }

  #commitInk(): void {
    const drawing = this.#drawing;
    this.#drawing = null;
    drawing?.view.annotEl.querySelector('.ul-pdf-ink-preview')?.remove();
    if (!drawing) return;

    const length = drawing.points.reduce((sum, point, i) => {
      if (i === 0) return 0;
      const previous = drawing.points[i - 1]!;
      return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0);
    if (length < INK_MIN_LENGTH) return;

    const viewport = this.#viewportFor(drawing.view);
    const stroke = drawing.points.map((p) => {
      const [x, y] = viewport.convertToPdfPoint(p.x, p.y);
      return { x, y };
    });

    this.#add({
      id: newId(),
      kind: 'ink',
      page: drawing.view.source,
      color: this.#color,
      createdAt: Date.now(),
      strokes: [stroke],
      width: 2,
    });
  }

  /* ── deleting text ─────────────────────────────────────────────────── */

  /** The document opened to read its content; once per version of the source. */
  #openContent(): Promise<PDFDocument> {
    if (!this.#contentDoc || this.#contentDoc.source !== this.source) {
      this.#contentDoc = {
        source: this.source,
        doc: PDFDocument.load(this.source, { ignoreEncryption: true }),
      };
    }
    return this.#contentDoc.doc;
  }

  #standardWidths(): Promise<StandardWidths> {
    this.#standard ??= standardWidths(loadFontBytes);
    return this.#standard;
  }

  #beginMarquee(event: PointerEvent, view: PageView): void {
    const bounds = view.el.getBoundingClientRect();
    const origin = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

    const el = document.createElement('div');
    el.className = 'ul-pdf-marquee';
    view.annotEl.appendChild(el);
    view.annotEl.setPointerCapture(event.pointerId);

    this.#marquee = { view, origin, el };

    const place = (moveX: number, moveY: number) => {
      const x = Math.min(origin.x, moveX);
      const y = Math.min(origin.y, moveY);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${Math.abs(moveX - origin.x)}px`;
      el.style.height = `${Math.abs(moveY - origin.y)}px`;
    };
    place(origin.x, origin.y);

    const onMove = (move: PointerEvent) => {
      place(move.clientX - bounds.left, move.clientY - bounds.top);
    };
    const onUp = (up: PointerEvent) => {
      view.annotEl.removeEventListener('pointermove', onMove);
      view.annotEl.removeEventListener('pointerup', onUp);
      view.annotEl.removeEventListener('pointercancel', onUp);
      this.#marquee = null;
      el.remove();

      const endX = up.clientX - bounds.left;
      const endY = up.clientY - bounds.top;
      if (Math.abs(endX - origin.x) < REDACT_MIN_SIZE || Math.abs(endY - origin.y) < REDACT_MIN_SIZE) {
        return;
      }

      const viewport = this.#viewportFor(view);
      const [x1, y1] = viewport.convertToPdfPoint(origin.x, origin.y);
      const [x2, y2] = viewport.convertToPdfPoint(endX, endY);

      void this.#addRedaction(view, {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    };

    view.annotEl.addEventListener('pointermove', onMove);
    view.annotEl.addEventListener('pointerup', onUp);
    view.annotEl.addEventListener('pointercancel', onUp);
  }

  /**
   * Records an area for redaction, but only after checking it can be done.
   *
   * The check happens straight away rather than at save time: if reading the page
   * content fails, or the text is out of reach, the user has to learn that while
   * still looking at the spot — not through a warning at save time, once they
   * have moved on to something else.
   */
  async #addRedaction(view: PageView, rect: Rect): Promise<void> {
    try {
      const doc = await this.#openContent();
      const page = doc.getPages()[view.source - 1];
      if (!page) return;

      const preview = previewRedaction(page, [rect], await this.#standardWidths());

      if (preview.obstacles.length > 0) {
        this.host.notify.show(
          'warning',
          t('This area cannot be cleared safely: {reason}', {
            reason: preview.obstacles.map((o) => o.reason).join('; '),
          }),
        );
        return;
      }

      if (preview.glyphs === 0) {
        this.host.notify.show('info', t('There is no text in that area.'));
        return;
      }

      this.#snapshot();
      this.#redactions = [
        ...this.#redactions,
        { id: newId(), page: view.source, rect },
      ];
      this.#markDirty();
      this.#renderAllAnnotations();
      this.#emitStatus();

      this.host.notify.show(
        'info',
        t('{n} characters will be removed from the document when you save.', { n: preview.glyphs }),
      );
    } catch (err) {
      this.host.notify.show(
        'error',
        t('Could not read the page content: {reason}', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  #removeRedaction(id: string): void {
    this.#snapshot();
    this.#redactions = this.#redactions.filter((r) => r.id !== id);
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  }

  /* ── tekstualni okviri ─────────────────────────────────────────────── */

  /** The cut that best matches the name of the source font. */
  static #faceFor(baseFont: string): TextFace {
    const lower = baseFont.toLowerCase();
    if (lower.includes('bold')) return 'sans-bold';
    if (lower.includes('italic') || lower.includes('oblique')) return 'sans-italic';
    return 'sans';
  }

  /**
   * A click with the text tool: on empty space it opens a new box, on existing
   * text it opens **that text** for rewriting.
   *
   * Two different jobs behind the same gesture, because the urge is the same — "I
   * want different letters here". A separate tool would require the user to know
   * in advance whether what is under their finger is document text or blank
   * paper, and that cannot be seen.
   */
  async #startTextBox(view: PageView, clientX: number, clientY: number): Promise<void> {
    const bounds = view.el.getBoundingClientRect();
    const [x, top] = this.#viewportFor(view).convertToPdfPoint(
      clientX - bounds.left,
      clientY - bounds.top,
    );

    const metrics = await this.#face(this.#textFace);
    if (this.#tool !== 'text' || this.#editor || !this.#pages.includes(view)) return;

    this.#openTextEditor(view, metrics, {
      id: newId(),
      kind: 'text',
      page: view.source,
      color: this.#textColor,
      createdAt: Date.now(),
      rect: layoutTextBox(metrics, '', this.#textSize, { x, top }),
      text: '',
      size: this.#textSize,
      face: this.#textFace,
    });
  }

  /**
   * Rewriting a line that is already in the document.
   *
   * Its own tool since the toolbar grew one. It used to hide inside "Add text":
   * clicking existing text with `T` rewrote it, clicking anywhere else made a
   * new box. That was two jobs under one button, and both of them surprising —
   * nothing said the line would be swallowed, and there was no way to put a new
   * box on top of existing text at all, which is what somebody annotating a
   * contract wants. `T` only adds now, and this only rewrites.
   */
  async #rewriteLine(view: PageView, clientX: number, clientY: number): Promise<void> {
    const bounds = view.el.getBoundingClientRect();
    const [x, top] = this.#viewportFor(view).convertToPdfPoint(
      clientX - bounds.left,
      clientY - bounds.top,
    );

    const existing = await this.#lineAt(view, { x, y: top });
    // While the content was being read, the user may have changed tool or page.
    if (this.#tool !== 'edit' || this.#editor || !this.#pages.includes(view)) return;

    if (existing && 'refusal' in existing) {
      this.host.notify.show('warning', existing.refusal);
      return;
    }

    /*
     * Nothing found, and that has to be said. Silence here reads as a broken
     * tool: the click landed on a picture of text, or on the margin, and the
     * person has no way to tell those apart from a program that ignored them.
     */
    if (!existing) {
      this.host.notify.show(
        'info',
        t('There is no rewritable line there. Text inside a picture is part of the picture.'),
      );
      return;
    }

    const { line } = existing;
    const face = PdfEditor.#faceFor(line.baseFont);
    const metrics = await this.#face(face);
    if (this.#tool !== 'edit' || this.#editor) return;

    /*
     * The replacement is aligned on the **baseline** of the source line, not on
     * its box: the box depends on which letters the line holds, while the
     * baseline is the same regardless.
     */
    const anchor = {
      x: line.origin.x - TEXT_PADDING,
      top: line.origin.y + metrics.ascent(line.size) + TEXT_PADDING,
    };

    this.#openTextEditor(
      view,
      metrics,
      {
        id: newId(),
        kind: 'text',
        page: view.source,
        color: line.color,
        createdAt: Date.now(),
        rect: layoutTextBox(metrics, line.text, line.size, anchor),
        text: line.text,
        size: line.size,
        face,
      },
      { rect: line.bounds, line },
    );
  }

  /** The document line under a given point, if there is one and it can be rewritten. */
  async #lineAt(
    view: PageView,
    point: { x: number; y: number },
  ): Promise<ReturnType<typeof findEditableLine>> {
    try {
      const doc = await this.#openContent();
      const page = doc.getPages()[view.source - 1];
      if (!page) return null;
      return findEditableLine(page, point, await this.#standardWidths());
    } catch {
      // Unreadable content must not prevent writing new text.
      return null;
    }
  }

  /** The CSS that gives the text the same look it will have in the file. */
  #textStyle(box: TextBoxAnnotation, metrics: FaceMetrics | undefined): Partial<CSSStyleDeclaration> {
    const spec = TEXT_FACES.find((f) => f.id === box.face);
    const lineHeight = metrics
      ? metrics.lineHeight(box.size)
      : // Without metrics the line height is derived from the box; this holds for
        // imported boxes the user has not touched, where no font was needed.
        (box.rect.height - TEXT_PADDING * 2) / Math.max(1, linesOf(box.text).length);

    return {
      color: cssRgb(box.color),
      fontFamily: `"${FONT_FAMILY}", Arial, Helvetica, sans-serif`,
      fontWeight: String(spec?.weight ?? 400),
      fontStyle: spec?.style ?? 'normal',
      fontSize: `${box.size * this.#scale}px`,
      lineHeight: `${lineHeight * this.#scale}px`,
      padding: `${TEXT_PADDING * this.#scale}px`,
    };
  }

  /**
   * The page's own colour behind a line, so the field covering it disappears
   * into the paper.
   *
   * Read from the rendered page just outside the line's left edge — beside the
   * text rather than on it. White is the answer for almost every document, but
   * assuming it would turn a dark or coloured page into a white stripe, and the
   * one thing this field must not do is announce itself.
   */
  static #groundBehind(view: PageView, rect: Rect): string {
    try {
      const scaleX = view.canvas.width / view.baseWidth;
      const scaleY = view.canvas.height / view.baseHeight;
      const x = Math.round((rect.x - 2) * scaleX);
      const y = Math.round((view.baseHeight - (rect.y + rect.height / 2)) * scaleY);
      if (x < 0 || y < 0 || x >= view.canvas.width || y >= view.canvas.height) return '#fff';

      const ctx = view.canvas.getContext('2d', { willReadFrequently: true });
      const pixel = ctx?.getImageData(x, y, 1, 1).data;
      if (!pixel) return '#fff';
      return `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
    } catch {
      // A canvas that cannot be read is not a reason to refuse the edit.
      return '#fff';
    }
  }

  #placeTextElement(el: HTMLElement, view: PageView, box: TextBoxAnnotation): void {
    const geometry = rectToCss(this.#viewportFor(view), box.rect);
    el.style.left = `${geometry.left}px`;
    el.style.top = `${geometry.top}px`;
    el.style.width = `${geometry.width}px`;
    el.style.height = `${geometry.height}px`;
  }

  /**
   * Typing a box in place.
   *
   * The `<textarea>` sits exactly over the box and carries the same font, size
   * and line height, so what is seen while typing is already what will be in the
   * file. The static rendering is hidden for the duration.
   */
  #openTextEditor(
    view: PageView,
    metrics: FaceMetrics,
    draft: TextBoxAnnotation,
    /** When rewriting an existing line: what is being replaced. */
    replaces?: { rect: Rect; line: EditableLine },
  ): void {
    this.#finishTextEdit();
    this.#closePopup();

    const input = document.createElement('textarea');
    input.className = 'ul-pdf-text-input';
    input.value = draft.text;
    input.spellcheck = false;
    Object.assign(input.style, this.#textStyle(draft, metrics));

    /*
     * Typing over an existing line, the field has to cover it completely. A pale
     * ground is right for a new box — it shows how far the box reaches without
     * hiding the document — but over the line being replaced it leaves the old
     * letters showing through the new ones, and the result reads as a broken
     * program rather than as a text field.
     */
    let cover: HTMLElement | null = null;
    if (replaces) {
      const ground = PdfEditor.#groundBehind(view, replaces.rect);
      /* Its own element rather than the field's own background: the field is as
         wide as what has been typed, and the line underneath is as wide as it
         was written. Neither covers the other on its own. */
      cover = document.createElement('div');
      cover.className = 'ul-pdf-rewrite-cover';
      cover.style.background = ground;
      const geometry = rectToCss(this.#viewportFor(view), replaces.rect);
      cover.style.left = `${geometry.left}px`;
      cover.style.top = `${geometry.top}px`;
      cover.style.width = `${geometry.width}px`;
      cover.style.height = `${geometry.height}px`;

      input.dataset.rewrite = 'true';
      input.style.background = ground;
      /* The document's own font first: it is often installed, and then what is
         typed matches the page while it is being typed. Ours is the fallback,
         and the file gets the document's font either way. */
      input.style.fontFamily = `"${replaces.line.baseFont}", "${FONT_FAMILY}", Arial, sans-serif`;
    }

    const warning = document.createElement('div');
    warning.className = 'ul-pdf-text-warning';
    warning.hidden = true;

    this.#editor = {
      view,
      metrics,
      input,
      warning,
      cover,
      draft,
      replaces: replaces?.rect ?? null,
      line: replaces?.line ?? null,
      notes: [],
      origin: this.#annotations.find(
        (a): a is TextBoxAnnotation => a.kind === 'text' && a.id === draft.id,
      ) ?? null,
    };

    // The render puts the field into the layer itself and recomputes its position.
    this.#renderAnnotations(view);

    input.addEventListener('input', () => this.#onTextInput());
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.#finishTextEdit();
      }
    });
    input.addEventListener('blur', () => this.#finishTextEdit());

    input.focus();
    this.#onTextInput();
  }

  /** The box follows the text while typing — it grows to the right and downwards. */
  #onTextInput(): void {
    const editor = this.#editor;
    if (!editor) return;

    const { draft, metrics } = editor;
    draft.text = editor.input.value;
    draft.rect = layoutTextBox(metrics, draft.text, draft.size, {
      x: draft.rect.x,
      top: topOf(draft.rect),
    });

    this.#placeTextElement(editor.input, editor.view, draft);
    this.#warnAboutGlyphs();
  }

  /**
   * A character the font does not know is reported **while typing**, not on save:
   * at that point it can still be changed, whereas afterwards the document has
   * already gone.
   */
  #warnAboutGlyphs(): void {
    const editor = this.#editor;
    if (!editor) return;

    const messages = [...editor.notes];
    const text = editor.draft.text;

    /*
     * A line being rewritten normally goes back in the document's own font, and
     * then there is nothing to say — which is the whole point of the exercise.
     * The warning appears only for the characters that font does not have, and
     * only then does our font, and its different letterforms, come into it.
     */
    const unavailable = editor.line ? unwritable(editor.line.font, text) : [];
    if (editor.line && unavailable.length > 0) {
      messages.push(fallbackWarning(editor.line, unavailable));
    }

    const missing = editor.metrics.missing(text);
    if (missing.length > 0 && (!editor.line || unavailable.length > 0)) {
      messages.push(
        t('This font has no {chars} — they will be saved as blanks.', { chars: missing.join(' ') }),
      );
    }

    editor.warning.hidden = messages.length === 0;
    if (messages.length === 0) return;

    editor.warning.replaceChildren(
      ...messages.map((message) => {
        const line = document.createElement('div');
        line.textContent = message;
        return line;
      }),
    );

    const geometry = rectToCss(this.#viewportFor(editor.view), editor.draft.rect);
    editor.warning.style.left = `${geometry.left}px`;
    editor.warning.style.top = `${geometry.top + geometry.height + 4}px`;
  }

  /** Changes the face, size or colour of the box currently being typed. */
  #applyToEditedBox(patch: Partial<Pick<TextBoxAnnotation, 'size' | 'face' | 'color'>>): void {
    const editor = this.#editor;
    if (!editor) return;

    Object.assign(editor.draft, patch);
    if (patch.face) {
      const metrics = this.#metrics.get(patch.face);
      if (metrics) editor.metrics = metrics;
    }

    Object.assign(editor.input.style, this.#textStyle(editor.draft, editor.metrics));
    this.#onTextInput();
  }

  /**
   * Closes the edit, and only then touches the history.
   *
   * An empty box is not saved: clicking and then changing your mind must not
   * leave an invisible annotation in the document.
   */
  #finishTextEdit(): void {
    const editor = this.#editor;
    if (!editor) return;
    this.#editor = null;

    editor.input.remove();
    editor.warning.remove();
    editor.cover?.remove();

    const { draft, origin, replaces, line } = editor;
    const empty = draft.text.trim().length === 0;

    /*
     * Rewriting a line of the document. Two routes, and the good one is the
     * usual one: the operator that draws the line is rewritten in the font
     * already there, so the page comes back looking untouched. See
     * [`retype.ts`](./retype.ts) for why the other one exists.
     */
    if (replaces && line) {
      if (draft.text === line.text) {
        // Opened and closed again. Not an edit, and not a step in the history.
        this.#renderAllAnnotations();
        return;
      }

      const inPlace =
        !empty && !NEWLINE.test(draft.text) && unwritable(line.font, draft.text).length === 0;
      if (inPlace) {
        const done = this.#retypeInPlace(line, draft, replaces);
        this.#committing = done;
        void done.finally(() => {
          if (this.#committing === done) this.#committing = null;
        });
        return;
      }

      this.#replaceWithOurFont(draft, replaces, empty);
      return;
    }

    if (empty) {
      if (origin) this.#remove(origin.id);
      else this.#renderAnnotations(editor.view);
      return;
    }

    if (!origin) {
      this.#add(draft);
      return;
    }

    const unchanged =
      origin.text === draft.text &&
      origin.size === draft.size &&
      origin.face === draft.face &&
      origin.color.every((c, i) => c === draft.color[i]) &&
      origin.rect.x === draft.rect.x &&
      origin.rect.y === draft.rect.y;

    if (unchanged) {
      this.#renderAnnotations(editor.view);
      return;
    }

    this.#snapshot();
    this.#annotations = this.#annotations.map((a) =>
      // An edited imported box becomes ours, otherwise the change would not be written.
      a.id === draft.id ? { ...draft, imported: false } : a,
    );
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  }

  /**
   * Writes the line back in the document's own font.
   *
   * The source itself changes, and that is deliberate: the page is then redrawn
   * from the real bytes, so what is on screen after an edit **is** what the file
   * holds. Nothing is drawn over anything, and there is no preview that could
   * disagree with the result.
   *
   * If the line has moved since it was picked — another edit, or a page that was
   * merged in between — the retype is refused rather than applied to whatever is
   * now in that place, and the other route takes over.
   */
  async #retypeInPlace(
    line: EditableLine,
    draft: TextBoxAnnotation,
    replaces: Rect,
  ): Promise<void> {
    let outcome;
    try {
      outcome = await applyRetype(
        this.source,
        { page: draft.page, rect: line.bounds, before: line.text, after: draft.text },
        await this.#standardWidths(),
      );
    } catch (err) {
      outcome = {
        kind: 'refused' as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.kind === 'done') {
      // Nothing has changed until now, so this captures the state before the edit.
      this.#snapshot();
      this.#sourceEdited = true;
      this.#contentDoc = null;
      await this.#reload(outcome.bytes, this.#plan, { keepPosition: true });
      this.#markDirty();
      this.#emitStatus();
      return;
    }

    if (outcome.kind === 'refused') this.host.notify.show('warning', outcome.reason);
    this.#replaceWithOurFont(draft, replaces, false);
  }

  /**
   * The fallback: the old line leaves the content stream, the new one is written
   * with our own embedded font on the same baseline.
   *
   * Both are one step in the history — undo has to restore the text and its
   * place, not half the job.
   */
  #replaceWithOurFont(draft: TextBoxAnnotation, replaces: Rect, empty: boolean): void {
    this.#snapshot();
    this.#redactions = [
      ...this.#redactions,
      { id: newId(), page: draft.page, rect: replaces, replaced: !empty },
    ];
    if (!empty) this.#annotations = [...this.#annotations, draft];
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  }

  /**
   * Dragging moves the box, a click opens it for typing.
   *
   * The offset is computed in PDF space, through two conversions rather than by
   * dividing by the zoom — that way it works on a rotated page too.
   */
  #beginTextDrag(event: PointerEvent, view: PageView, id: string): void {
    if (this.#tool === 'ink' || this.#tool === 'note') return;

    const box = this.#annotations.find(
      (a): a is TextBoxAnnotation => a.kind === 'text' && a.id === id,
    );
    if (!box) return;

    event.preventDefault();
    event.stopPropagation();

    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(event.pointerId);

    const bounds = view.el.getBoundingClientRect();
    const viewport = this.#viewportFor(view);
    const toPdf = (x: number, y: number) => viewport.convertToPdfPoint(x - bounds.left, y - bounds.top);
    const [startX, startY] = toPdf(event.clientX, event.clientY);

    const origin = { ...box.rect };
    let moved = false;

    const onMove = (move: PointerEvent) => {
      if (
        !moved &&
        Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) < TEXT_DRAG_SLOP
      ) {
        return;
      }
      moved = true;

      const [x, y] = toPdf(move.clientX, move.clientY);
      box.rect = { ...origin, x: origin.x + (x - startX), y: origin.y + (y - startY) };
      this.#placeTextElement(el, view, box);
    };

    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);

      if (!moved) {
        box.rect = origin;
        void this.#face(box.face).then((metrics) =>
          this.#openTextEditor(view, metrics, { ...box, rect: { ...box.rect } }),
        );
        return;
      }

      // The move is stored as one step; `box` has already been changed in place,
      // so the snapshot is taken against the previous position.
      const moveTo = box.rect;
      box.rect = origin;
      this.#snapshot();
      this.#annotations = this.#annotations.map((a) =>
        a.id === id && a.kind === 'text' ? { ...a, rect: moveTo, imported: false } : a,
      );
      this.#markDirty();
      this.#renderAllAnnotations();
      this.#emitStatus();
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  /* ── the note popup ────────────────────────────────────────────────── */

  #closePopup(): void {
    this.#popup?.remove();
    this.#popup = null;
  }

  #openNotePopup(view: PageView, id: string): void {
    this.#closePopup();

    const annotation = this.#annotations.find((a) => a.id === id);
    if (!annotation || annotation.kind !== 'note') return;

    const box = rectToCss(this.#viewportFor(view), annotation.rect);
    const popup = document.createElement('div');
    popup.className = 'ul-pdf-note-popup';
    popup.style.left = `${box.left + NOTE_ICON_PX + 8}px`;
    popup.style.top = `${box.top}px`;

    const textarea = document.createElement('textarea');
    textarea.value = annotation.text;
    textarea.placeholder = t('Note…');
    textarea.rows = 4;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const remove = document.createElement('button');
    remove.textContent = t('Delete');
    remove.addEventListener('click', () => {
      this.#closePopup();
      this.#remove(id);
    });

    const save = document.createElement('button');
    save.textContent = t('Save');
    save.dataset.primary = 'true';
    save.addEventListener('click', () => {
      const text = textarea.value;
      if (text !== annotation.text) {
        this.#snapshot();
        this.#annotations = this.#annotations.map((a) =>
          // An edited imported note becomes ours — otherwise the change would not be written.
          a.id === id && a.kind === 'note' ? { ...a, text, imported: false } : a,
        );
        this.#markDirty();
        this.#renderAllAnnotations();
      }
      this.#closePopup();
    });

    actions.append(remove, save);
    popup.append(textarea, actions);
    view.annotEl.appendChild(popup);
    this.#popup = popup;

    textarea.focus();
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.#closePopup();
      }
    });
  }

  /* ── navigacija ────────────────────────────────────────────────────── */

  goToPage(position: number): void {
    const clamped = Math.min(this.#plan.length, Math.max(1, Math.round(position)));
    const view = this.#visiblePages()[clamped - 1];
    if (!view || !this.#scroll) return;
    this.#scroll.scrollTo({ top: view.el.offsetTop - 20, behavior: 'smooth' });
    this.#current = clamped;
    this.#emitStatus();
  }

  #updateCurrentPage(): void {
    const scroll = this.#scroll;
    if (!scroll) return;
    const middle = scroll.scrollTop + scroll.clientHeight / 2;

    let best = 1;
    for (const view of this.#visiblePages()) {
      if (view.el.offsetTop <= middle) best = view.position;
      else break;
    }
    if (best === this.#current) return;
    this.#current = best;
    this.#emitStatus();

    if (this.#railOpen && this.#rail) {
      for (const item of this.#rail.querySelectorAll('.ul-pdf-thumb')) {
        (item as HTMLElement).dataset.current = String(
          Number((item as HTMLElement).dataset.position) === this.#current,
        );
      }
    }
  }

  #emitStatus(): void {
    if (this.#pageInput) this.#pageInput.value = String(this.#current);
    const parts = [t('Page {n} of {total}', { n: this.#current, total: this.#plan.length })];

    const mine = this.#annotations.filter((a) => !a.imported).length;
    if (mine > 0) parts.push(t('{n} new annotations', { n: mine }));

    const pending = this.#redactions.filter((r) => !r.applied).length;
    if (pending > 0) parts.push(t('{n} areas to erase', { n: pending }));

    parts.push(...describePlan(this.#plan, this.pdf.numPages));

    this.#statusEmitter.fire(parts.join('  ·  '));

    if (this.#reading) {
      const total = this.#plan.length;
      this.#progressEmitter.fire({
        fraction: total > 1 ? (this.#current - 1) / (total - 1) : 0,
        label: t('p. {n}/{total}', { n: this.#current, total }),
      });
    }
  }

  /* ── ugovor ────────────────────────────────────────────────────────── */

  unmount(): void {
    this.#finishTextEdit();
    this.#observer?.disconnect();
    this.#resize?.disconnect();
    this.#scroll?.removeEventListener('wheel', this.#onWheel);
    this.#scroll?.removeEventListener('mouseup', this.#onMouseUp);
    this.#closePopup();
    for (const view of this.#pages) view.page.cleanup();
    void this.pdf.destroy();
    this.#root?.remove();
    this.#root = null;
    this.#scroll = null;
    this.#pages = [];
  }

  isDirty(): boolean {
    return this.#dirty;
  }

  async save(target?: SaveTarget): Promise<SaveResult> {
    const uri = target?.uri ?? this.docHandle.uri;
    // Unfinished typing is saved along with the rest, not lost.
    this.#finishTextEdit();
    // ...including a retype still being written into the source.
    await this.#committing;

    const { bytes, lost } = await saveDocument(
      this.source,
      [...this.#plan],
      this.#annotations,
      this.pdf.numPages,
      loadFontBytes,
      this.#redactions,
    );
    await this.host.fs.writeBytes(uri, bytes);

    // The saved annotations are now part of the file; we mark them as imported so
    // the next save does not add them a second time.
    this.#annotations = this.#annotations.map((a) => ({ ...a, imported: true }));
    /* The marks stay: every save starts from the untouched source, so the
       redaction is repeated with the same outcome — and removing a mark still
       brings the text back, which is the only way changing your mind can be
       offered at all. */
    this.#redactions = this.#redactions.map((r) => ({ ...r, applied: true }));
    // The bytes on screen are now the bytes on disk.
    this.#sourceEdited = false;
    this.#markDirty();
    this.#syncToolbar();
    this.#emitStatus();

    return { uri, lostFidelity: [...lost, ...fidelityGaps(this.#annotations)] };
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

  get annotations(): readonly Annotation[] {
    return this.#annotations;
  }

  async find(query: FindQuery): Promise<FindResult[]> {
    if (!query.query) return [];
    const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
    const results: FindResult[] = [];

    for (const view of this.#visiblePages()) {
      if (view.text === null) await this.#extractText(view);
      const text = view.text ?? '';
      const haystack = query.caseSensitive ? text : text.toLowerCase();

      let from = 0;
      while (results.length < 500) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        const end = index + query.query.length;
        results.push({
          // The user sees the position in the current view, not the source page number.
          label: t('Page {n}', { n: view.position }),
          preview: text
            .slice(Math.max(0, index - 40), index + needle.length + 40)
            .replace(/\s+/g, ' ')
            .trim(),
          reveal: () => this.#revealMatch(view, index, end),
        });
        from = end;
      }
    }
    return results;
  }

  async #extractText(view: PageView): Promise<void> {
    const content = await view.page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    view.text = text;
  }

  #revealMatch(view: PageView, start: number, end: number): void {
    this.goToPage(view.position);

    void this.#renderPage(view).then(() => {
      const boxes = view.boxes;
      if (!boxes) return;
      for (const other of this.#pages) other.hitsEl.replaceChildren();

      for (const box of boxes) {
        if (box.end <= start || box.start >= end) continue;
        const hit = document.createElement('div');
        hit.className = 'ul-pdf-hit';
        hit.dataset.current = 'true';
        hit.style.left = `${box.left}px`;
        hit.style.top = `${box.top}px`;
        hit.style.width = `${box.width}px`;
        hit.style.height = `${box.height}px`;
        view.hitsEl.appendChild(hit);
      }
    });
  }

  /* ── reading mode ──────────────────────────────────────────────────── */

  /**
   * A PDF is a fixed layout, so the reading room behaves differently here than it
   * does for text: the typography cannot be changed (the page is an image), but
   * everything else holds — the frame disappears, the page fits the screen,
   * turning follows real pages, and "night" and "sepia" are applied as a filter
   * over the rendering, as in the readers people already use.
   */
  beginReading(options: ReadingOptions): ReadingSession {
    const previousZoom = this.#zoomMode;
    this.#reading = true;
    if (this.#root) this.#root.dataset.reading = 'true';
    this.#applyReading(options);
    void this.#loadOutline();

    return {
      apply: (next) => this.#applyReading(next),
      page: (delta) => this.goToPage(this.#current + delta),
      seek: (fraction) => this.goToPage(Math.round(fraction * (this.#plan.length - 1)) + 1),
      outline: () => this.#outline,
      goTo: (id) => {
        const source = this.#outlineTargets.get(id);
        if (source === undefined) return;
        const index = pageMapOf(this.#plan).get(source);
        if (index !== undefined) this.goToPage(index + 1);
      },
      onProgress: this.#progressEmitter.event,
      end: () => {
        if (!this.#reading) return;
        this.#reading = false;
        if (this.#root) {
          this.#root.dataset.reading = 'false';
          this.#root.removeAttribute('data-tint');
        }
        this.setZoomMode(previousZoom);
      },
    };
  }

  #applyReading(options: ReadingOptions): void {
    if (this.#root) {
      this.#root.dataset.tint = options.tint;
      this.#root.dataset.flow = options.flow;
    }
    // With a PDF "pages" are not a metaphor — a whole page fits on the screen.
    this.setZoomMode(options.flow === 'paged' ? 'fit-page' : 'fit-width');
  }

  /** The document outline; where there is none, a page list beats an empty table of contents. */
  async #loadOutline(): Promise<void> {
    const targets = new Map<string, number>();
    const items: ReadingOutlineItem[] = [];

    interface RawItem {
      title: string;
      dest: string | unknown[] | null;
      items?: RawItem[];
    }

    const pageOf = async (dest: string | unknown[] | null): Promise<number | null> => {
      try {
        const resolved = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
        const ref = Array.isArray(resolved) ? resolved[0] : null;
        if (!ref || typeof ref !== 'object') return null;
        return (await this.pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1;
      } catch {
        return null;
      }
    };

    const walk = async (nodes: RawItem[], depth: number): Promise<void> => {
      for (const node of nodes) {
        if (items.length >= 500) return;
        const id = `dest-${items.length}`;
        items.push({ id, label: node.title || t('Untitled'), depth: Math.min(depth, 3) });
        targets.set(id, (await pageOf(node.dest)) ?? 1);
        if (node.items?.length) await walk(node.items, depth + 1);
      }
    };

    try {
      const raw = (await this.pdf.getOutline()) as RawItem[] | null;
      if (raw?.length) await walk(raw, 0);
    } catch {
      // A damaged outline tree must not prevent reading.
    }

    if (items.length === 0) {
      const limit = Math.min(this.#plan.length, 500);
      for (let i = 1; i <= limit; i++) {
        const id = `page-${i}`;
        items.push({ id, label: t('Page {n}', { n: i }), depth: 0 });
        targets.set(id, this.#plan[i - 1]?.source ?? i);
      }
    }

    this.#outline = items;
    this.#outlineTargets = targets;
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    const text = window.getSelection()?.toString().trim();
    if (!text) return null;
    return plainPayload(text, { editorId: 'org.uleditor.pdf', uri: this.docHandle.uri });
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#scroll?.focus();
  }
}

export const pdfEditorProvider: EditorProvider = {
  id: 'org.uleditor.pdf',
  displayName: 'PDF viewer',
  matches: {
    extensions: ['pdf'],
    mimeTypes: ['application/pdf'],
    magic: [new Uint8Array([0x25, 0x50, 0x44, 0x46])], // %PDF
  },
  capabilities: ['view', 'edit', 'annotate', 'search', 'read'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    const bytes = await doc.bytes();
    // Two copies: pdf.js takes over and detaches its buffer, while pdf-lib needs
    // an untouched original when saving.
    const forRender = new Uint8Array(bytes);
    const forWrite = new Uint8Array(bytes);
    const pdf = await getDocument({ data: forRender }).promise;
    return new PdfEditor(host, doc, pdf, forWrite);
  },
};

/**
 * The text of a PDF, page by page, without mounting an editor.
 *
 * It exists for project-wide search: there a dozen documents are opened whose
 * rendering nobody looks at, so a full editor would be pure cost. The document is
 * closed properly — otherwise every search would leave a pdf.js worker behind.
 */
export async function extractPdfText(
  bytes: Uint8Array,
): Promise<{ page: number; text: string }[]> {
  const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const out: { page: number; text: string }[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      page.cleanup();
      if (text) out.push({ page: n, text });
    }
  } finally {
    void doc.destroy();
  }

  return out;
}

export default pdfEditorProvider;
export * from './annotations.js';
export * from './document.js';
