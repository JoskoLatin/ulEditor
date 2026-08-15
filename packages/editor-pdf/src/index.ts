/**
 * PDF preglednik i anotator — pdf.js za prikaz, pdf-lib za zapis.
 *
 * Na webu pdf.js ostaje trajno rješenje. Na desktopu ga u fazi 1 zamjenjuje
 * pdfium preko Rusta (brži render, niža potrošnja memorije na velikim
 * dokumentima); ugovor `EditorInstance` ostaje isti, pa shell razliku ne vidi.
 *
 * Anotacije se čitaju iz datoteke pri otvaranju i zapisuju kao pravi PDF
 * objekti — vidi `annotations.ts`.
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
  type SaveResult,
  type SaveTarget,
} from '@uleditor/plugin-sdk';

import {
  PALETTE,
  NOTE_SIZE,
  boundsOf,
  fidelityGaps,
  importAnnotations,
  newId,
  writeAnnotations,
  type Annotation,
  type Point,
  type Rect,
  type Rgb,
} from './annotations.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const MARGIN = 48;
/** Ispod ovoliko piksela poteza smatramo da je korisnik samo kliknuo. */
const INK_MIN_LENGTH = 4;
/** Veličina ikone bilješke na ekranu — ne ovisi o zoomu. */
const NOTE_ICON_PX = 20;

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
  number: number;
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
  /** Anotacije iz same datoteke su pročitane. */
  imported: boolean;
}

function cssRgb(color: Rgb, alpha = 1): string {
  const [r, g, b] = color;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** PDF pravokutnik → CSS pozicija unutar elementa stranice. */
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
  #pageInput: HTMLInputElement | null = null;
  #zoomLabel: HTMLElement | null = null;
  #popup: HTMLElement | null = null;

  #pages: PageView[] = [];
  #observer: IntersectionObserver | null = null;
  #resize: ResizeObserver | null = null;

  #scale = 1;
  #zoomMode: ZoomMode = 'fit-width';
  #current = 1;

  #annotations: Annotation[] = [];
  #undoStack: Annotation[][] = [];
  #redoStack: Annotation[][] = [];
  #dirty = false;

  #tool: Tool = 'select';
  #color: Rgb = PALETTE[0]!.color;

  /** Potez u tijeku, u CSS koordinatama stranice. */
  #drawing: { view: PageView; points: Point[] } | null = null;

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly docHandle: DocumentHandle,
    private readonly pdf: PDFDocumentProxy,
    private readonly source: Uint8Array,
  ) {}

  /* ── montaža ───────────────────────────────────────────────────────── */

  async mount(container: HTMLElement): Promise<void> {
    const root = document.createElement('div');
    root.className = 'ul-pdf';

    const scroll = document.createElement('div');
    scroll.className = 'ul-pdf-scroll';

    root.append(this.#buildToolbar(), scroll);
    container.appendChild(root);

    this.#root = root;
    this.#scroll = scroll;

    await this.#buildPages();

    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.pageNumber);
          const view = this.#pages[number - 1];
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

    const prev = button('‹', 'Prethodna stranica', () => this.goToPage(this.#current - 1));
    const next = button('›', 'Sljedeća stranica', () => this.goToPage(this.#current + 1));

    const input = document.createElement('input');
    input.className = 'ul-pdf-page-input';
    input.value = '1';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', 'Broj stranice');
    input.addEventListener('change', () => this.goToPage(Number(input.value)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.goToPage(Number(input.value));
    });
    this.#pageInput = input;

    const total = document.createElement('span');
    total.textContent = `/ ${this.pdf.numPages}`;
    total.style.padding = '0 4px';

    const zoomOut = button('−', 'Smanji (Ctrl + kotačić)', () => this.zoomBy(-1));
    const zoomIn = button('+', 'Povećaj (Ctrl + kotačić)', () => this.zoomBy(1));
    const zoomLabel = document.createElement('span');
    zoomLabel.style.minWidth = '44px';
    zoomLabel.style.textAlign = 'center';
    this.#zoomLabel = zoomLabel;

    const fitWidth = button('Širina', 'Prilagodi širini', () => this.setZoomMode('fit-width'));
    const fitPage = button('Stranica', 'Prilagodi stranici', () => this.setZoomMode('fit-page'));

    /* — alati za anotiranje — */
    const tools: { tool: Tool; label: string; title: string }[] = [
      { tool: 'select', label: '⌖', title: 'Odabir i selekcija teksta' },
      { tool: 'highlight', label: '▬', title: 'Istakni označeni tekst' },
      { tool: 'note', label: '✎', title: 'Bilješka — klikni na stranicu' },
      { tool: 'ink', label: '〰', title: 'Crtanje slobodnom rukom' },
    ];
    const toolButtons = new Map<Tool, HTMLButtonElement>();
    for (const { tool, label, title } of tools) {
      const b = button(label, title, () => this.setTool(tool));
      b.classList.add('ul-pdf-tool');
      toolButtons.set(tool, b);
      bar.appendChild(b);
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

    // Redoslijed u traci: navigacija, zoom, pa alati koje smo već ubacili.
    bar.prepend(prev, input, total, next, sep(), zoomOut, zoomLabel, zoomIn, sep(), fitWidth, fitPage, sep());
    bar.append(swatches, spacer, count);

    this.#syncToolbar = () => {
      fitWidth.dataset.active = String(this.#zoomMode === 'fit-width');
      fitPage.dataset.active = String(this.#zoomMode === 'fit-page');
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;

      for (const [tool, b] of toolButtons) b.dataset.active = String(this.#tool === tool);
      for (const { el, color } of swatchButtons) {
        el.dataset.active = String(color.every((c, i) => Math.abs(c - this.#color[i]!) < 0.001));
      }

      const mine = this.#annotations.filter((a) => !a.imported).length;
      const imported = this.#annotations.length - mine;
      count.textContent = this.#annotations.length
        ? `${this.#annotations.length} anot.${imported ? ` (${imported} iz datoteke)` : ''}`
        : '';
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
      el.dataset.pageNumber = String(n);
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
        number: n,
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

  async #applyZoom(): Promise<void> {
    const scroll = this.#scroll;
    const first = this.#pages[0];
    if (!scroll || !first) return;

    if (this.#zoomMode === 'fit-width') {
      this.#scale = Math.max(0.1, (scroll.clientWidth - MARGIN) / first.baseWidth);
    } else if (this.#zoomMode === 'fit-page') {
      this.#scale = Math.max(
        0.1,
        Math.min(
          (scroll.clientWidth - MARGIN) / first.baseWidth,
          (scroll.clientHeight - MARGIN) / first.baseHeight,
        ),
      );
    }

    for (const view of this.#pages) {
      view.el.style.width = `${Math.round(view.baseWidth * this.#scale)}px`;
      view.el.style.height = `${Math.round(view.baseHeight * this.#scale)}px`;
      view.rendered = false;
      view.el.dataset.rendered = 'false';
      view.hitsEl.replaceChildren();
    }

    this.#syncToolbar();
    await this.#renderVisible();
  }

  async #renderVisible(): Promise<void> {
    const scroll = this.#scroll;
    if (!scroll) return;
    const top = scroll.scrollTop - scroll.clientHeight;
    const bottom = scroll.scrollTop + scroll.clientHeight * 2;

    for (const view of this.#pages) {
      const y = view.el.offsetTop;
      if (y + view.el.offsetHeight >= top && y <= bottom) await this.#renderPage(view);
    }
  }

  /* ── render stranice ───────────────────────────────────────────────── */

  #viewportFor(view: PageView): PageViewport {
    return view.page.getViewport({ scale: this.#scale });
  }

  async #renderPage(view: PageView): Promise<void> {
    if (view.rendered || view.rendering) return;
    view.rendering = true;

    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = view.page.getViewport({ scale: this.#scale * dpr });
      const context = view.canvas.getContext('2d', { alpha: false });
      if (!context) return;

      view.canvas.width = Math.round(viewport.width);
      view.canvas.height = Math.round(viewport.height);
      view.canvas.style.width = `${Math.round(view.baseWidth * this.#scale)}px`;
      view.canvas.style.height = `${Math.round(view.baseHeight * this.#scale)}px`;

      await view.page.render({ canvasContext: context, viewport }).promise;

      await this.#buildTextLayer(view);
      await this.#importPageAnnotations(view);
      this.#renderAnnotations(view);

      view.rendered = true;
      view.el.dataset.rendered = 'true';
    } catch (err) {
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
        console.error(`[uleditor] render stranice ${view.number} nije uspio`, err);
      }
    } finally {
      view.rendering = false;
    }
  }

  /**
   * Vlastiti tekstualni sloj umjesto pdf.js TextLayer klase — API se između
   * verzija mijenjao, a ovo je tridesetak linija koje kontroliramo sami.
   */
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

  /** Anotacije koje su već u datoteci — čitaju se jednom po stranici. */
  async #importPageAnnotations(view: PageView): Promise<void> {
    if (view.imported) return;
    view.imported = true;

    try {
      const raw = await view.page.getAnnotations();
      const imported = importAnnotations(raw as unknown[], view.number);
      if (imported.length > 0) {
        this.#annotations = [...this.#annotations, ...imported];
        this.#syncToolbar();
      }
    } catch (err) {
      console.warn(`[uleditor] anotacije stranice ${view.number} se nisu učitale`, err);
    }
  }

  /* ── sloj anotacija ────────────────────────────────────────────────── */

  #renderAnnotations(view: PageView): void {
    const viewport = this.#viewportFor(view);
    const fragment = document.createDocumentFragment();

    for (const annotation of this.#annotations) {
      if (annotation.page !== view.number) continue;

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
        // U samoj datoteci ostaje zapisana u PDF točkama (vidi NOTE_SIZE).
        el.style.width = `${NOTE_ICON_PX}px`;
        el.style.height = `${NOTE_ICON_PX}px`;
        el.style.background = cssRgb(annotation.color);
        el.title = annotation.text || 'Bilješka';
        el.textContent = '✎';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#openNotePopup(view, annotation.id);
        });
        fragment.appendChild(el);
        continue;
      }

      // Ink: jedan SVG po anotaciji, u koordinatama stranice.
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ul-pdf-ann ul-pdf-ann-ink');
      svg.dataset.id = annotation.id;
      svg.setAttribute('width', view.el.style.width || '0');
      svg.setAttribute('height', view.el.style.height || '0');
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

  /* ── stvaranje anotacija ───────────────────────────────────────────── */

  #snapshot(): void {
    this.#undoStack.push(this.#annotations.map((a) => ({ ...a })));
    this.#redoStack = [];
    // Povijest se ne pamti unedogled; dvadeset koraka pokriva stvarnu upotrebu.
    if (this.#undoStack.length > 20) this.#undoStack.shift();
  }

  #markDirty(): void {
    const dirty = this.#annotations.some((a) => !a.imported);
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.#dirtyEmitter.fire(dirty);
  }

  #add(annotation: Annotation): void {
    this.#snapshot();
    this.#annotations = [...this.#annotations, annotation];
    this.#markDirty();
    this.#renderAllAnnotations();
  }

  #remove(id: string): void {
    this.#snapshot();
    this.#annotations = this.#annotations.filter((a) => a.id !== id);
    this.#markDirty();
    this.#renderAllAnnotations();
  }

  /** Označen tekst → istaknuće. Jedan pravokutnik po retku selekcije. */
  #onMouseUp = (): void => {
    if (this.#tool !== 'highlight') return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (rects.length === 0) return;

    // Selekcija može prelaziti preko stranica — grupiramo po stranici.
    const byPage = new Map<PageView, Rect[]>();
    for (const rect of rects) {
      const view = this.#pageAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!view) continue;

      const bounds = view.el.getBoundingClientRect();
      const viewport = this.#viewportFor(view);
      const [x1, y1] = viewport.convertToPdfPoint(rect.left - bounds.left, rect.top - bounds.top);
      const [x2, y2] = viewport.convertToPdfPoint(
        rect.right - bounds.left,
        rect.bottom - bounds.top,
      );

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
          page: view.number,
          color: this.#color,
          createdAt: Date.now(),
          quads,
        },
      ];
    }
    selection.removeAllRanges();
    this.#markDirty();
    this.#renderAllAnnotations();
  };

  #pageAt(clientX: number, clientY: number): PageView | null {
    for (const view of this.#pages) {
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
        page: view.number,
        color: this.#color,
        createdAt: Date.now(),
        // Ikona se crta od kliknute točke prema gore-desno.
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

  /** Potez u tijeku crtamo izravno, bez diranja modela. */
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
      page: drawing.view.number,
      color: this.#color,
      createdAt: Date.now(),
      strokes: [stroke],
      width: 2,
    });
  }

  /* ── skočni prozorčić bilješke ─────────────────────────────────────── */

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
    popup.style.left = `${box.left + box.width + 8}px`;
    popup.style.top = `${box.top}px`;

    const textarea = document.createElement('textarea');
    textarea.value = annotation.text;
    textarea.placeholder = 'Bilješka…';
    textarea.rows = 4;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const remove = document.createElement('button');
    remove.textContent = 'Obriši';
    remove.addEventListener('click', () => {
      this.#closePopup();
      this.#remove(id);
    });

    const save = document.createElement('button');
    save.textContent = 'Spremi';
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

  goToPage(number: number): void {
    const clamped = Math.min(this.pdf.numPages, Math.max(1, Math.round(number)));
    const view = this.#pages[clamped - 1];
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
    for (const view of this.#pages) {
      if (view.el.offsetTop <= middle) best = view.number;
      else break;
    }
    if (best === this.#current) return;
    this.#current = best;
    this.#emitStatus();
  }

  #emitStatus(): void {
    if (this.#pageInput) this.#pageInput.value = String(this.#current);
    const mine = this.#annotations.filter((a) => !a.imported).length;
    const suffix = mine > 0 ? `  ·  ${mine} novih anotacija` : '';
    this.#statusEmitter.fire(`Stranica ${this.#current} od ${this.pdf.numPages}${suffix}`);
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
    const { bytes } = await writeAnnotations(this.source, this.#annotations);
    await this.host.fs.writeBytes(uri, bytes);

    // Spremljene anotacije su sada dio datoteke; označavamo ih kao uvezene
    // da ih sljedeće spremanje ne doda drugi put.
    this.#annotations = this.#annotations.map((a) => ({ ...a, imported: true }));
    this.#markDirty();
    this.#syncToolbar();
    this.#emitStatus();

    return { uri, lostFidelity: fidelityGaps(this.#annotations) };
  }

  undo(): void {
    const previous = this.#undoStack.pop();
    if (!previous) return;
    this.#redoStack.push(this.#annotations.map((a) => ({ ...a })));
    this.#annotations = previous;
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
  }

  redo(): void {
    const next = this.#redoStack.pop();
    if (!next) return;
    this.#undoStack.push(this.#annotations.map((a) => ({ ...a })));
    this.#annotations = next;
    this.#markDirty();
    this.#renderAllAnnotations();
    this.#emitStatus();
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

    for (const view of this.#pages) {
      if (view.text === null) await this.#extractText(view);
      const text = view.text ?? '';
      const haystack = query.caseSensitive ? text : text.toLowerCase();

      let from = 0;
      while (results.length < 500) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        const end = index + query.query.length;
        results.push({
          label: `Stranica ${view.number}`,
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
    this.goToPage(view.number);

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
  displayName: 'PDF preglednik',
  matches: {
    extensions: ['pdf'],
    mimeTypes: ['application/pdf'],
    magic: [new Uint8Array([0x25, 0x50, 0x44, 0x46])], // %PDF
  },
  capabilities: ['view', 'edit', 'annotate', 'search'],
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
