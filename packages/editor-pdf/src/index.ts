/**
 * PDF preglednik — pdf.js.
 *
 * Na webu pdf.js ostaje trajno rješenje. Na desktopu ga u fazi 1 zamjenjuje
 * pdfium preko Rusta (brži render, niža potrošnja memorije na velikim
 * dokumentima); ugovor `EditorInstance` ostaje isti, pa shell razliku ne vidi.
 *
 * Uređivanje (anotacije, operacije nad stranicama) dolazi u fazi 1 preko
 * `lopdf` i qpdf — zato ovaj provider još ne deklarira sposobnost 'edit'.
 */

import { GlobalWorkerOptions, Util, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
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
} from '@uleditor/plugin-sdk';

GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const MARGIN = 48;

type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

interface TextItemBox {
  str: string;
  /** Pozicija u znakovima unutar spojenog teksta stranice. */
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
  page: PDFPageProxy;
  /** Dimenzije pri scale = 1, za preračun zooma bez ponovnog dohvata. */
  baseWidth: number;
  baseHeight: number;
  rendered: boolean;
  rendering: boolean;
  boxes: TextItemBox[] | null;
  text: string | null;
}

class PdfEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #scroll: HTMLElement | null = null;
  #pageInput: HTMLInputElement | null = null;
  #zoomLabel: HTMLElement | null = null;

  #pages: PageView[] = [];
  #observer: IntersectionObserver | null = null;
  #resize: ResizeObserver | null = null;

  #scale = 1;
  #zoomMode: ZoomMode = 'fit-width';
  #current = 1;

  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly docHandle: DocumentHandle,
    private readonly pdf: PDFDocumentProxy,
  ) {}

  /* ── montaža ───────────────────────────────────────────────────────── */

  async mount(container: HTMLElement): Promise<void> {
    const root = document.createElement('div');
    root.className = 'ul-pdf';

    const toolbar = this.#buildToolbar();
    const scroll = document.createElement('div');
    scroll.className = 'ul-pdf-scroll';

    root.append(toolbar, scroll);
    container.appendChild(root);

    this.#root = root;
    this.#scroll = scroll;

    await this.#buildPages();

    // Render tek kad stranica uđe u vidno polje, plus jedan ekran unaprijed.
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.pageNumber);
          const view = this.#pages[number - 1];
          if (!view) continue;
          if (entry.isIntersecting) void this.#renderPage(view);
        }
        this.#updateCurrentPage();
      },
      { root: scroll, rootMargin: '100% 0px' },
    );
    for (const view of this.#pages) this.#observer.observe(view.el);

    scroll.addEventListener('scroll', () => this.#updateCurrentPage(), { passive: true });
    scroll.addEventListener('wheel', this.#onWheel, { passive: false });

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

    const prev = button('‹', 'Prethodna stranica (PageUp)', () => this.goToPage(this.#current - 1));
    const next = button('›', 'Sljedeća stranica (PageDown)', () => this.goToPage(this.#current + 1));

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

    const zoomOut = button('−', 'Smanji (Ctrl -)', () => this.zoomBy(-1));
    const zoomIn = button('+', 'Povećaj (Ctrl +)', () => this.zoomBy(1));

    const zoomLabel = document.createElement('span');
    zoomLabel.style.minWidth = '44px';
    zoomLabel.style.textAlign = 'center';
    this.#zoomLabel = zoomLabel;

    const fitWidth = button('Širina', 'Prilagodi širini', () => this.setZoomMode('fit-width'));
    const fitPage = button('Stranica', 'Prilagodi stranici', () => this.setZoomMode('fit-page'));
    fitWidth.dataset.active = 'true';

    const sep = () => {
      const s = document.createElement('span');
      s.className = 'sep';
      return s;
    };
    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    bar.append(prev, input, total, next, sep(), zoomOut, zoomLabel, zoomIn, sep(), fitWidth, fitPage, spacer);

    // Aktivno stanje gumba za način prikaza.
    this.#syncZoomButtons = () => {
      fitWidth.dataset.active = String(this.#zoomMode === 'fit-width');
      fitPage.dataset.active = String(this.#zoomMode === 'fit-page');
      if (this.#zoomLabel) this.#zoomLabel.textContent = `${Math.round(this.#scale * 100)}%`;
    };

    return bar;
  }

  #syncZoomButtons: () => void = () => {};

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
      hitsEl.style.position = 'absolute';
      hitsEl.style.inset = '0';
      hitsEl.style.pointerEvents = 'none';

      el.append(canvas, textEl, hitsEl);
      this.#scroll?.appendChild(el);

      this.#pages.push({
        number: n,
        el,
        canvas,
        textEl,
        hitsEl,
        page,
        baseWidth: viewport.width,
        baseHeight: viewport.height,
        rendered: false,
        rendering: false,
        boxes: null,
        text: null,
      });
    }
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

    // Prvo dimenzije okvira — scrollbar tako ne poskakuje dok se renderira.
    for (const view of this.#pages) {
      view.el.style.width = `${Math.round(view.baseWidth * this.#scale)}px`;
      view.el.style.height = `${Math.round(view.baseHeight * this.#scale)}px`;
      view.rendered = false;
      view.el.dataset.rendered = 'false';
      view.hitsEl.replaceChildren();
    }

    this.#syncZoomButtons();
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
      view.rendered = true;
      view.el.dataset.rendered = 'true';
    } catch (err) {
      // Prekinuti render pri brzom scrollanju je normalan tijek, ne greška.
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
    const viewport = view.page.getViewport({ scale: this.#scale });
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
      // Vodoravno rastezanje da se nevidljivi tekst poklopi s otisnutim.
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

    // Mjerenje tek nakon umetanja — prije toga scrollWidth je nula.
    const spans = view.textEl.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i] as HTMLElement;
      const target = Number(span.dataset.width);
      const actual = span.getBoundingClientRect().width;
      if (target > 0 && actual > 0) {
        span.style.transform = `scaleX(${target / actual})`;
      }
    }

    view.boxes = boxes;
    view.text = text;
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
    this.#statusEmitter.fire(`Stranica ${this.#current} od ${this.pdf.numPages}`);
  }

  /* ── ugovor ────────────────────────────────────────────────────────── */

  unmount(): void {
    this.#observer?.disconnect();
    this.#resize?.disconnect();
    this.#scroll?.removeEventListener('wheel', this.#onWheel);
    for (const view of this.#pages) view.page.cleanup();
    void this.pdf.destroy();
    this.#root?.remove();
    this.#root = null;
    this.#scroll = null;
    this.#pages = [];
  }

  isDirty(): boolean {
    return false;
  }

  async save(): Promise<SaveResult> {
    throw new Error(
      'Uređivanje PDF-a (anotacije, operacije nad stranicama) stiže u fazi 1 preko lopdf i qpdf.',
    );
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
    if (!query.query) return [];
    const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
    const results: FindResult[] = [];

    for (const view of this.#pages) {
      // Tekst se dohvaća i za stranice koje još nisu renderirane.
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
          preview: text.slice(Math.max(0, index - 40), index + needle.length + 40).replace(/\s+/g, ' ').trim(),
          reveal: () => this.#revealMatch(view, index, end),
        });
        from = end;
      }
    }
    return results;
  }

  /** Tekst bez rendera — potreban za pretragu po cijelom dokumentu. */
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

      // Pogodak može prelaziti preko više tekstualnih fragmenata.
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
    const selection = window.getSelection();
    const text = selection?.toString().trim();
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
  capabilities: ['view', 'search'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    const bytes = await doc.bytes();
    // Kopija: pdf.js preuzima buffer i detachira ga, a DocumentHandle ga cachira.
    const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
    return new PdfEditor(host, doc, pdf);
  },
};

export default pdfEditorProvider;
