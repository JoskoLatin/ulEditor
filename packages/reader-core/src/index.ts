/**
 * Listanje jednog dugog dokumenta.
 *
 * Word pregled, Markdown i svaki budući editor koji prikazuje jedan neprekinut
 * tekst dijele isti posao: prelomiti ga u stranice, listati, javljati napredak
 * i pamtiti mjesto. Napisati to triput znači tri različita ponašanja tipke
 * razmaknice, pa stoji ovdje.
 *
 * Knjiga (`editor-book`) namjerno ima vlastiti motor — EPUB se lomi po
 * poglavljima, montira jedno po jedno, i to je bitno drukčiji problem od
 * jednog dokumenta u jednom komadu.
 *
 * Stranice se dobivaju CSS stupcima, ne ručnim mjerenjem. Preglednik već zna
 * ne razdvojiti naslov od odlomka koji slijedi.
 */

import type { ReadingOptions, ReadingProgress } from '@uleditor/plugin-sdk';

/** Razmak između stupaca; ujedno dio koraka listanja. */
export const COLUMN_GAP = 56;
/** Ispod ove širine dvostupčani prijelom postaje uži od udobne mjere. */
const TWO_COLUMN_MIN = 1180;

const WORDS_PER_MINUTE = 220;

export interface PagedFlowHost {
  /** Element s prijelomom; mora imati fiksnu visinu i skrivati prelijevanje. */
  view: HTMLElement;
  /** Sadržaj koji se lomi. Dijete `view`-a. */
  flow: HTMLElement;
  /** Broj riječi — za procjenu preostalog vremena. */
  words: number;
  onProgress(progress: ReadingProgress): void;
}

export class PagedFlow {
  #host: PagedFlowHost;
  #options: ReadingOptions | null = null;
  #page = 0;
  #pages = 1;
  #resize: ResizeObserver;
  /** Mjesto na koje treba skočiti čim prijelom bude poznat. */
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
   * Nove postavke bez gubitka mjesta: zapamti udio, primijeni, vrati se na
   * njega. Bez ovoga svaka promjena veličine slova baca čitatelja na početak.
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

    // Broj stupaca ovisi o raspoloživom prostoru, ne o širini samog prozora
    // čitanja — inače bi `max-width` koji ovdje postavljamo utjecao na odluku
    // koja ga je proizvela.
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
    // Stranice se listaju vodoravno; okomiti pomak zaostao iz svitka bi
    // odsjekao vrh stupca.
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

  /** Skok na element unutar sadržaja — sadržaj, pogodak pretrage, sidro. */
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

/* ── isticanje pogotka ───────────────────────────────────────────────── */

/**
 * CSS Custom Highlight API. Umetanje `<mark>` elementa razbilo bi tekstualne
 * čvorove na koje pretraga već drži reference, pa bi sljedeći pogodak u istom
 * odlomku pokazivao na krivo mjesto. Ovako se DOM ne dira uopće.
 *
 * Gdje API ne postoji, ostaje skok na mjesto bez isticanja — to je gubitak
 * ukrasa, ne funkcije.
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

/** Tekstualni čvorovi s vidljivim sadržajem — osnova pretrage nad prikazom. */
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

/** Broj riječi u tekstu — ista mjera svugdje, da procjene budu usporedive. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Naslovi u prikazanom sadržaju → sadržaj za čitaonicu. */
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
