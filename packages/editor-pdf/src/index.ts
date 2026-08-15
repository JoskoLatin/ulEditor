/**
 * PDF preglednik, anotator i organizator stranica.
 *
 * pdf.js prikazuje, pdf-lib zapisuje. Na desktopu pdf.js u fazi 1 zamjenjuje
 * pdfium preko Rusta; ugovor `EditorInstance` ostaje isti, pa shell razliku
 * ne vidi.
 *
 * Operacije nad stranicama ne mijenjaju dokument dok se ne spremi — postoji
 * samo plan (vidi `document.ts`). Anotacije se vežu uz IZVORNU stranicu, pa
 * preslagivanje ne razdvaja bilješku od onoga na što se odnosi.
 */

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
} from './annotations.js';
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
/** Ispod ovoliko piksela poteza smatramo da je korisnik samo kliknuo. */
const INK_MIN_LENGTH = 4;
/** Veličina ikone bilješke na ekranu — ne ovisi o zoomu. */
const NOTE_ICON_PX = 20;
const THUMB_WIDTH = 108;

type ZoomMode = 'fit-width' | 'fit-page' | 'custom';
type Tool = 'select' | 'highlight' | 'note' | 'ink';

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
  /** Broj stranice u izvornom dokumentu — nepromjenjiv. */
  source: number;
  /** Mjesto u trenutnom prikazu, 1-bazirano. Mijenja se preslagivanjem. */
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
  plan: PagePlan[];
  /**
   * Bajtovi izvornika u trenutku snimke. Isti su za sve korake osim spajanja,
   * koje jedino ne može biti opisano planom nad starim izvornikom — pa se
   * referenca nosi da bi i spajanje imalo poništavanje.
   */
  source: Uint8Array;
}

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

  /** Poredano po prikazu; `source` čuva izvorni broj stranice. */
  #pages: PageView[] = [];
  #observer: IntersectionObserver | null = null;
  #resize: ResizeObserver | null = null;

  #scale = 1;
  #zoomMode: ZoomMode = 'fit-width';
  #current = 1;

  #plan: PagePlan[];
  #annotations: Annotation[] = [];
  #undoStack: Snapshot[] = [];
  #redoStack: Snapshot[] = [];
  #dirty = false;
  #railOpen = false;

  #reading = false;
  #outline: ReadingOutlineItem[] = [];
  /** Sadržaj cilja IZVORNE stranice; plan ih može premjestiti. */
  #outlineTargets = new Map<string, number>();

  #tool: Tool = 'select';
  #color: Rgb = PALETTE[0]!.color;

  #drawing: { view: PageView; points: Point[] } | null = null;

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  #progressEmitter = new Emitter<ReadingProgress>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly docHandle: DocumentHandle,
    /** Nije `readonly`: spajanje zamjenjuje i dokument i njegove bajtove. */
    private pdf: PDFDocumentProxy,
    private source: Uint8Array,
  ) {
    this.#plan = identityPlan(pdf.numPages);
  }

  /* ── montaža ───────────────────────────────────────────────────────── */

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
    ];
    const toolButtons = new Map<Tool, HTMLButtonElement>();
    const toolGroup = document.createElement('span');
    toolGroup.style.display = 'inline-flex';
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

    const count = document.createElement('span');
    count.className = 'ul-pdf-count';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    bar.append(
      railToggle, sep(),
      prev, input, total, next, sep(),
      zoomOut, zoomLabel, zoomIn, sep(),
      fitWidth, fitPage, sep(),
      toolGroup, swatches,
      spacer, count,
    );

    this.#syncToolbar = () => {
      railToggle.dataset.active = String(this.#railOpen);
      fitWidth.dataset.active = String(this.#zoomMode === 'fit-width');
      fitPage.dataset.active = String(this.#zoomMode === 'fit-page');
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
      total.textContent = `/ ${this.#plan.length}`;

      for (const [tool, b] of toolButtons) b.dataset.active = String(this.#tool === tool);
      for (const { el, color } of swatchButtons) {
        el.dataset.active = String(color.every((c, i) => Math.abs(c - this.#color[i]!) < 0.001));
      }

      const parts: string[] = [];
      if (this.#annotations.length) parts.push(`${this.#annotations.length} anot.`);
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

  /* ── plan stranica ─────────────────────────────────────────────────── */

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

  /* ── spajanje i izdvajanje ─────────────────────────────────────────── */

  /**
   * Ponovno učitavanje dokumenta iz novih bajtova.
   *
   * Traži ga samo spajanje: nakon njega postoje stranice koje u učitanom
   * pdf.js dokumentu ne postoje, pa se plan nad njim više ne može razriješiti.
   * Rotacija, brisanje i preslagivanje i dalje rade nad istim dokumentom.
   */
  async #reload(bytes: Uint8Array, plan: PagePlan[]): Promise<void> {
    const scroll = this.#scroll;
    if (!scroll) return;

    this.#observer?.disconnect();
    for (const view of this.#pages) {
      view.page.cleanup();
      view.el.remove();
    }
    this.#pages = [];

    const previous = this.pdf;
    this.source = bytes;
    // pdf.js preuzima i detachira svoj buffer, pa dobiva vlastitu kopiju.
    this.pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
    void previous.destroy();

    this.#plan = plan;
    await this.#buildPages();
    for (const view of this.#pages) this.#observer?.observe(view.el);
    await this.#applyPlan();
  }

  /** Umeće stranice drugog PDF-a iza trenutne. */
  async mergeFrom(incoming: Uint8Array, at = this.#current): Promise<number> {
    const result = await mergeInto(this.source, this.#plan, incoming, at);
    this.#snapshot();
    await this.#reload(result.bytes, result.plan);
    return result.added;
  }

  /** Otvara odabir datoteke i umeće je — radnja iz trake sa stranicama. */
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
   * Izdvaja raspon stranica u novu datoteku. Izvornik ostaje netaknut — nitko
   * ne želi da mu se dokument raspolovi na disku zato što je htio izvući tri
   * stranice.
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

  /** Usklađuje DOM i stanje pogleda s trenutnim planom. */
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

    // Stranice izvan plana su obrisane — sklanjaju se iz prikaza, ali se
    // pogled zadržava jer ih undo može vratiti.
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

  /* ── traka s minijaturama ──────────────────────────────────────────── */

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

      // Minijatura se crta nakon umetanja da canvas ima izmjerenu širinu.
      void this.#renderThumb(view, canvas, entry.rotate);
    }

    rail.replaceChildren(fragment);
  }

  /** Radnje nad cijelim dokumentom, iznad minijatura. */
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
        console.warn(`[uleditor] minijatura stranice ${view.source} nije nacrtana`, err);
      }
    }
  }

  /* ── alati ─────────────────────────────────────────────────────────── */

  setTool(tool: Tool): void {
    this.#tool = tool;
    if (this.#root) this.#root.dataset.tool = tool;
    this.#closePopup();
    this.#syncToolbar();
  }

  setColor(color: Rgb): void {
    this.#color = color;
    this.#syncToolbar();
  }

  get tool(): Tool {
    return this.#tool;
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

  /** Dimenzije stranice uz rotaciju iz plana — 90° zamjenjuje širinu i visinu. */
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

    // Nakon promjene mjerila stranice imaju druge visine, pa isti `scrollTop`
    // više ne pokazuje na istu stranicu. Bez ovoga svaka promjena zooma i svaka
    // promjena veličine prozora izbaci čitatelja s mjesta na kojem je stao.
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

  /* ── render stranice ───────────────────────────────────────────────── */

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
        console.error(`[uleditor] render stranice ${view.source} nije uspio`, err);
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
      console.warn(`[uleditor] anotacije stranice ${view.source} se nisu učitale`, err);
    }
  }

  /* ── sloj anotacija ────────────────────────────────────────────────── */

  #renderAnnotations(view: PageView): void {
    const viewport = this.#viewportFor(view);
    const fragment = document.createDocumentFragment();

    for (const annotation of this.#annotations) {
      // Vezuje se uz IZVORNU stranicu, pa preslagivanje ne razdvaja bilješku
      // od onoga na što se odnosi.
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

      if (annotation.kind === 'note') {
        const box = rectToCss(viewport, annotation.rect);
        const el = document.createElement('button');
        el.className = 'ul-pdf-ann ul-pdf-ann-note';
        el.dataset.id = annotation.id;
        el.style.left = `${box.left}px`;
        el.style.top = `${box.top}px`;
        // Fiksna veličina na ekranu, kao u svakom PDF čitaču: bilješka je
        // oznaka, ne sadržaj stranice, pa se ne smije napuhati sa zoomom.
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
      plan: this.#plan.map((p) => ({ ...p })),
      source: this.source,
    };
  }

  #restore(snapshot: Snapshot): void {
    // Poništavanje spajanja vraća i sam dokument, ne samo plan.
    if (snapshot.source !== this.source) {
      this.#annotations = snapshot.annotations;
      void this.#reload(snapshot.source, snapshot.plan);
      return;
    }

    const planChanged =
      snapshot.plan.length !== this.#plan.length ||
      snapshot.plan.some((entry, i) => {
        const current = this.#plan[i];
        return !current || current.source !== entry.source || current.rotate !== entry.rotate;
      });

    this.#annotations = snapshot.annotations;
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
      this.#annotations.some((a) => !a.imported) || !isIdentity(this.#plan, this.pdf.numPages);
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
    // Prozorčić bilješke i postojeće anotacije žive unutar sloja koji sluša
    // ovaj event. Bez ove provjere klik na „Spremi" u prozorčiću stvara novu
    // bilješku ispod njega.
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

  /* ── prozorčić bilješke ────────────────────────────────────────────── */

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
          // Uređena uvezena bilješka postaje naša — inače se izmjena ne bi zapisala.
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
    parts.push(...describePlan(this.#plan, this.pdf.numPages));

    this.#statusEmitter.fire(parts.join('  ·  '));

    if (this.#reading) {
      const total = this.#plan.length;
      this.#progressEmitter.fire({
        fraction: total > 1 ? (this.#current - 1) / (total - 1) : 0,
        label: `str. ${this.#current}/${total}`,
      });
    }
  }

  /* ── ugovor ────────────────────────────────────────────────────────── */

  unmount(): void {
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
    const { bytes, lost } = await saveDocument(
      this.source,
      [...this.#plan],
      this.#annotations,
      this.pdf.numPages,
    );
    await this.host.fs.writeBytes(uri, bytes);

    // Spremljene anotacije su sada dio datoteke; označavamo ih kao uvezene
    // da ih sljedeće spremanje ne doda drugi put.
    this.#annotations = this.#annotations.map((a) => ({ ...a, imported: true }));
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
          // Korisnik vidi mjesto u trenutnom prikazu, ne izvorni broj stranice.
          label: `Stranica ${view.position}`,
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

  /* ── način čitanja ─────────────────────────────────────────────────── */

  /**
   * PDF je fiksni prijelom, pa se čitaonica ovdje ponaša drukčije nego kod
   * teksta: tipografija se ne može mijenjati (stranica je slika), ali sve
   * ostalo vrijedi — okvir nestaje, stranica se uklapa u ekran, listanje ide
   * po stvarnim stranicama, a "noć" i "sepija" se primjenjuju kao filtar nad
   * prikazom, kao u čitačima koje ljudi već koriste.
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
    // "Stranice" kod PDF-a nisu metafora — cijela stranica stane u ekran.
    this.setZoomMode(options.flow === 'paged' ? 'fit-page' : 'fit-width');
  }

  /** Oznake iz dokumenta; kad ih nema, popis stranica je bolji od praznog sadržaja. */
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
      // Oštećeno stablo oznaka ne smije spriječiti čitanje.
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
    // Dvije kopije: pdf.js preuzima i detachira svoj buffer, a pdf-lib treba
    // netaknut izvornik pri spremanju.
    const forRender = new Uint8Array(bytes);
    const forWrite = new Uint8Array(bytes);
    const pdf = await getDocument({ data: forRender }).promise;
    return new PdfEditor(host, doc, pdf, forWrite);
  },
};

export default pdfEditorProvider;
export * from './annotations.js';
export * from './document.js';
