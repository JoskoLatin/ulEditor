/**
 * Paginating one long document.
 *
 * The Word view, Markdown and every future editor that displays one unbroken
 * text share the same job: break it into pages, turn them, report progress and
 * remember the place. Writing that three times means three different behaviours
 * for the space bar, so it lives here.
 *
 * The book (`editor-book`) deliberately has an engine of its own — an EPUB is
 * paginated per chapter and mounted one at a time, which is a substantially
 * different problem from one document in one piece.
 *
 * Pages come from CSS columns, not from manual measurement. The browser already
 * knows not to separate a heading from the paragraph that follows it.
 */

import type { ReadingOptions, ReadingProgress } from '@uleditor/plugin-sdk';

/** The gap between columns; also part of the page-turn step. */
export const COLUMN_GAP = 56;
/** Below this width a two-column layout becomes narrower than a comfortable measure. */
const TWO_COLUMN_MIN = 1180;

const WORDS_PER_MINUTE = 220;

export interface PagedFlowHost {
  /** The paginated element; it must have a fixed height and hide overflow. */
  view: HTMLElement;
  /** The content being paginated. A child of `view`. */
  flow: HTMLElement;
  /** The word count — for estimating the time left. */
  words: number;
  onProgress(progress: ReadingProgress): void;
}

export class PagedFlow {
  #host: PagedFlowHost;
  #options: ReadingOptions | null = null;
  #page = 0;
  #pages = 1;
  #resize: ResizeObserver;
  /** The place to jump to as soon as the pagination is known. */
  #pending: number | null = null;

  constructor(host: PagedFlowHost) {
    this.#host = host;
    this.#resize = new ResizeObserver(() => this.relayout());
    this.#resize.observe(host.view);
    host.view.addEventListener('scroll', () => this.#onScroll(), { passive: true });
  }

  get options(): ReadingOptions | null {
    return this.#options;
  }

  get pages(): number {
    return this.#pages;
  }

  /**
   * New settings without losing the place: remember the fraction, apply, return
   * to it. Without this every change of font size throws the reader back to the
   * start.
   */
  apply(options: ReadingOptions, root: HTMLElement): void {
    const at = this.#options ? this.fraction() : 0;

    this.#options = options;
    root.dataset.flow = options.flow;
    root.dataset.tint = options.tint;
    root.style.setProperty('--book-font', options.typeface === 'serif' ? 'var(--serif)' : 'var(--sans)');
    root.style.setProperty('--book-size', `${options.fontSize}px`);
    root.style.setProperty('--book-leading', String(options.lineHeight));
    root.style.setProperty('--book-measure', `${options.measure}ch`);

    this.#pending = at;
    this.relayout();
  }

  relayout(): void {
    const { view, flow } = this.#host;
    const options = this.#options;
    if (!options) return;

    if (options.flow === 'scroll') {
      flow.style.removeProperty('column-count');
      flow.style.removeProperty('column-gap');
      flow.style.removeProperty('height');
      view.style.removeProperty('max-width');
      this.#pages = 1;
      this.#settle();
      return;
    }

    // The column count depends on the available space, not on the width of the
    // reading window itself — otherwise the `max-width` we set here would feed
    // back into the decision that produced it.
    const available = view.parentElement?.clientWidth ?? view.clientWidth;
    const columns = available >= TWO_COLUMN_MIN ? 2 : 1;
    view.style.maxWidth =
      columns === 2 ? `calc(var(--book-measure) * 2 + ${COLUMN_GAP}px)` : 'var(--book-measure)';

    const width = view.clientWidth;
    const height = view.clientHeight;
    if (width === 0 || height === 0) return;

    flow.style.columnCount = String(columns);
    flow.style.columnGap = `${COLUMN_GAP}px`;
    flow.style.height = `${height}px`;
    // Pages turn horizontally; a vertical offset left over from scroll flow
    // would cut off the top of a column.
    view.scrollTop = 0;

    this.#pages = Math.max(1, Math.round((view.scrollWidth + COLUMN_GAP) / this.step()));
    this.#settle();
  }

  #settle(): void {
    if (this.#pending !== null) {
      const target = this.#pending;
      this.#pending = null;
      this.seek(target);
      return;
    }
    if (this.#options?.flow === 'paged') this.#goToPage(Math.min(this.#page, this.#pages - 1));
    else this.emit();
  }

  step(): number {
    return this.#host.view.clientWidth + COLUMN_GAP;
  }

  page(delta: number): void {
    const { view } = this.#host;
    if (this.#options?.flow === 'scroll') {
      view.scrollBy({ top: delta * (view.clientHeight - 64), behavior: 'smooth' });
      return;
    }
    this.#goToPage(this.#page + delta);
  }

  #goToPage(page: number): void {
    const next = Math.max(0, Math.min(page, this.#pages - 1));
    this.#page = next;
    this.#host.view.scrollLeft = next * this.step();
    this.emit();
  }

  seek(fraction: number): void {
    const value = Math.max(0, Math.min(1, fraction));
    const { view } = this.#host;

    if (this.#options?.flow === 'scroll') {
      view.scrollTop = value * Math.max(0, view.scrollHeight - view.clientHeight);
      this.emit();
      return;
    }
    this.#goToPage(Math.round(value * (this.#pages - 1)));
  }

  /** A jump to an element inside the content — a TOC entry, a search hit, an anchor. */
  scrollTo(element: HTMLElement): void {
    const { view } = this.#host;

    if (this.#options?.flow === 'scroll' || !this.#options) {
      const top = element.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop += top - 24;
      this.emit();
      return;
    }

    const x = element.getBoundingClientRect().left - view.getBoundingClientRect().left + view.scrollLeft;
    this.#goToPage(Math.floor(x / this.step()));
  }

  fraction(): number {
    const { view } = this.#host;
    if (this.#options?.flow === 'paged') {
      return this.#pages > 1 ? this.#page / (this.#pages - 1) : 0;
    }
    const range = view.scrollHeight - view.clientHeight;
    return range > 0 ? Math.max(0, Math.min(1, view.scrollTop / range)) : 0;
  }

  #onScroll(): void {
    if (this.#options?.flow === 'paged') {
      const page = Math.round(this.#host.view.scrollLeft / this.step());
      if (page === this.#page) return;
      this.#page = page;
    }
    this.emit();
  }

  emit(): void {
    const fraction = this.fraction();
    const label =
      this.#options?.flow === 'paged'
        ? `str. ${this.#page + 1}/${this.#pages}`
        : `${Math.round(fraction * 100)} %`;

    this.#host.onProgress({
      fraction,
      label,
      minutesLeft: Math.max(1, Math.round((this.#host.words * (1 - fraction)) / WORDS_PER_MINUTE)),
    });
  }

  destroy(): void {
    this.#resize.disconnect();
  }
}

/* ── highlighting a hit ──────────────────────────────────────────────── */

/**
 * The CSS Custom Highlight API. Inserting a `<mark>` element would split the text
 * nodes search already holds references to, so the next hit in the same
 * paragraph would point at the wrong place. This way the DOM is not touched at
 * all.
 *
 * Where the API is absent, the jump to the location remains without the
 * highlight — that is a loss of decoration, not of function.
 */
interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}

const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => object })
  .Highlight;

export const HIT_HIGHLIGHT = 'ul-read-hit';

export function showHit(range: Range | null): void {
  if (!registry || !HighlightCtor) return;
  if (!range) registry.delete(HIT_HIGHLIGHT);
  else registry.set(HIT_HIGHLIGHT, new HighlightCtor(range));
}

/** Text nodes with visible content — the basis of searching the rendered view. */
export function textNodesOf(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue && node.nodeValue.trim()) nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

/** The word count of a text — the same measure everywhere, so estimates compare. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Headings in the rendered content → a table of contents for the reading room. */
export function headingOutline(root: HTMLElement): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  for (const heading of [...root.querySelectorAll('h1, h2, h3, h4')]) {
    if (!(heading instanceof HTMLElement)) continue;
    if (!heading.id) heading.id = `naslov-${out.length}`;
    const label = (heading.textContent ?? '').trim();
    if (!label) continue;
    out.push({
      id: heading.id,
      label: label.slice(0, 120),
      depth: Math.min(Number(heading.tagName.slice(1)) - 1, 3),
    });
  }
  return out;
}
