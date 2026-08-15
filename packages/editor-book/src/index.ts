/**
 * Čitač e-knjiga (EPUB).
 *
 * Ovo je prvi editor u projektu koji postoji zbog čitanja, ne zbog uređivanja,
 * pa je i napisan oko toga: dvije vrste toka (stranice i svitak), pamćenje
 * mjesta na kojem si stao, procjena preostalog vremena i sadržaj po
 * poglavljima. Sve što shell treba za čitaonicu ide kroz `beginReading`,
 * pa isti UI radi i nad PDF-om i nad Markdownom.
 *
 * Stranice se ne crtaju ručno — dobiju se CSS stupcima nad jednim poglavljem.
 * Preglednik već zna prelomiti tekst i ne razdvojiti sliku od natpisa; ručno
 * paginiranje bi to izgubilo.
 */

import {
  DEFAULT_READING,
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
} from '@uleditor/plugin-sdk';

import { showHit, textNodesOf } from '@uleditor/reader-core';
import { t } from '@uleditor/i18n';

import { openEpub, WORDS_PER_MINUTE, type Book, type BookChapter } from './epub.js';

export type { Book, BookChapter } from './epub.js';
export { openEpub } from './epub.js';

/** Razmak između stupaca u načinu stranica. Ujedno korak listanja. */
const COLUMN_GAP = 56;
/** Ispod ove širine dvostupčani prijelom postaje uži od udobne mjere. */
const TWO_COLUMN_MIN = 1180;

/* ── pomoćno ─────────────────────────────────────────────────────────── */

function minutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

interface StoredPosition {
  chapter: number;
  /** Udio unutar poglavlja, 0..1 — preživi promjenu veličine slova i prozora. */
  within: number;
}

/* ── editor ──────────────────────────────────────────────────────────── */

class BookEditor implements EditorInstance {
  #root: HTMLElement | null = null;
  #view: HTMLElement | null = null;
  #flow: HTMLElement | null = null;
  #tocList: HTMLElement | null = null;

  #options: ReadingOptions;
  #reading = false;

  #chapter = 0;
  #page = 0;
  #pages = 1;

  /** Težine poglavlja po broju riječi — napredak mora biti po tekstu, ne po broju poglavlja. */
  #words: number[];
  #totalWords: number;

  #resize: ResizeObserver | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  #dirtyEmitter = new Emitter<boolean>();
  #statusEmitter = new Emitter<string>();
  #progressEmitter = new Emitter<ReadingProgress>();
  readonly onDirtyChange = this.#dirtyEmitter.event;
  readonly onStatusChange = this.#statusEmitter.event;

  constructor(
    private readonly host: EditorHost,
    private readonly doc: DocumentHandle,
    private readonly book: Book,
  ) {
    this.#words = book.chapters.map((c) => (c.text ? c.text.split(' ').length : 0));
    this.#totalWords = this.#words.reduce((a, b) => a + b, 0) || 1;

    this.#options = {
      ...DEFAULT_READING,
      ...host.settings.get<Partial<ReadingOptions>>('reading.options', {}),
    };

    const stored = host.settings.get<StoredPosition | null>(this.#positionKey, null);
    if (stored && stored.chapter >= 0 && stored.chapter < book.chapters.length) {
      this.#chapter = stored.chapter;
      this.#pendingWithin = stored.within;
    }
  }

  /** Mjesto na koje treba skočiti čim se zna koliko poglavlje ima stranica. */
  #pendingWithin = 0;
  #pendingAnchor: string | null = null;

  get #positionKey(): string {
    return `book.position.${this.doc.uri}`;
  }

  /* ── montaža ───────────────────────────────────────────────────────── */

  mount(container: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'ul-book';
    root.tabIndex = 0;
    this.#applyOptionsTo(root);

    const toc = document.createElement('aside');
    toc.className = 'ul-book-toc';

    const head = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = this.book.title;
    head.appendChild(title);
    if (this.book.author) {
      const author = document.createElement('p');
      author.textContent = this.book.author;
      head.appendChild(author);
    }
    if (this.book.cover) {
      const cover = document.createElement('img');
      cover.className = 'ul-book-cover';
      cover.src = this.book.cover;
      cover.alt = t('Cover: {title}', { title: this.book.title });
      head.appendChild(cover);
    }
    toc.appendChild(head);

    const list = document.createElement('nav');
    list.className = 'ul-book-toc-list';
    for (const entry of this.book.outline) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = entry.id;
      button.dataset.depth = String(entry.depth);
      button.textContent = entry.label;
      button.addEventListener('click', () => this.#goToOutline(entry.id));
      list.appendChild(button);
    }
    toc.appendChild(list);
    this.#tocList = list;

    const main = document.createElement('div');
    main.className = 'ul-book-main';

    if (this.book.notes.length > 0) {
      main.appendChild(this.#buildNotes());
    }

    const view = document.createElement('div');
    view.className = 'ul-book-view';

    const flow = document.createElement('article');
    flow.className = 'ul-book-flow';
    view.appendChild(flow);

    // Klik uz rub lista stranicu — jedina gesta koju svaki čitač ima.
    for (const side of ['prev', 'next'] as const) {
      const edge = document.createElement('button');
      edge.type = 'button';
      edge.className = `ul-book-edge ${side}`;
      edge.setAttribute('aria-label', side === 'prev' ? t('Previous page') : t('Next page'));
      edge.addEventListener('click', () => this.#turn(side === 'prev' ? -1 : 1));
      view.appendChild(edge);
    }

    main.appendChild(view);
    root.append(toc, main);
    container.appendChild(root);

    this.#root = root;
    this.#view = view;
    this.#flow = flow;

    view.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    root.addEventListener('keydown', (event) => this.#onKey(event));
    root.addEventListener('click', (event) => this.#onLinkClick(event));

    this.#resize = new ResizeObserver(() => this.#relayout());
    this.#resize.observe(view);

    this.#renderFlow();
  }

  #buildNotes(): HTMLElement {
    const notes = document.createElement('div');
    notes.className = 'ul-book-notes';
    const label = document.createElement('span');
    label.textContent = t('The preview does not reproduce everything from the book:');
    notes.appendChild(label);
    const list = document.createElement('ul');
    for (const note of this.book.notes) {
      const li = document.createElement('li');
      li.textContent = t(note);
      list.appendChild(li);
    }
    notes.appendChild(list);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ul-book-notes-close';
    close.textContent = t('OK');
    close.addEventListener('click', () => notes.remove());
    notes.appendChild(close);
    return notes;
  }

  unmount(): void {
    this.#persistPosition();
    this.#resize?.disconnect();
    this.#resize = null;
    showHit(null);
    this.#root?.remove();
    this.#root = null;
    this.#view = null;
    this.#flow = null;
    this.#tocList = null;
    this.book.release();
  }

  /* ── prikaz ────────────────────────────────────────────────────────── */

  #applyOptionsTo(root: HTMLElement): void {
    const o = this.#options;
    root.dataset.flow = o.flow;
    root.dataset.tint = o.tint;
    root.dataset.reading = String(this.#reading);
    root.style.setProperty('--book-font', o.typeface === 'serif' ? 'var(--serif)' : 'var(--sans)');
    root.style.setProperty('--book-size', `${o.fontSize}px`);
    root.style.setProperty('--book-leading', String(o.lineHeight));
    root.style.setProperty('--book-measure', `${o.measure}ch`);
  }

  /** Puni tok sadržajem: sva poglavlja u svitku, jedno u stranicama. */
  #renderFlow(): void {
    const flow = this.#flow;
    if (!flow) return;

    if (this.#options.flow === 'scroll') {
      flow.replaceChildren(...this.book.chapters.map((c) => c.body));
    } else {
      const chapter = this.book.chapters[this.#chapter];
      flow.replaceChildren(...(chapter ? [chapter.body] : []));
    }

    this.#relayout();
  }

  /**
   * Prijelom u stupce. Stupac je točno širok koliko i prozor (ili pola, na
   * širokom ekranu), pa je listanje pomak za `širina + razmak` — bez toga se
   * na svakoj stranici vidi rub sljedeće.
   */
  #relayout(): void {
    const view = this.#view;
    const flow = this.#flow;
    if (!view || !flow) return;

    if (this.#options.flow === 'scroll') {
      flow.style.removeProperty('column-count');
      flow.style.removeProperty('column-gap');
      flow.style.removeProperty('height');
      view.style.removeProperty('max-width');
      this.#pages = 1;
      if (this.#pendingWithin > 0 || this.#pendingAnchor) this.#applyPending();
      this.#emitProgress();
      return;
    }

    // Broj stupaca se odlučuje po raspoloživom prostoru, a ne po širini samog
    // prozora čitanja — inače bi max-width koji ovdje postavljamo utjecao na
    // odluku koja ga je proizvela.
    const available = view.parentElement?.clientWidth ?? view.clientWidth;
    const columns = available >= TWO_COLUMN_MIN ? 2 : 1;
    view.style.maxWidth =
      columns === 2
        ? `calc(var(--book-measure) * 2 + ${COLUMN_GAP}px)`
        : 'var(--book-measure)';

    const width = view.clientWidth;
    const height = view.clientHeight;
    if (width === 0 || height === 0) return;

    flow.style.columnCount = String(columns);
    flow.style.columnGap = `${COLUMN_GAP}px`;
    flow.style.height = `${height}px`;
    // Stranice se listaju vodoravno; okomiti pomak zaostao iz svitka bi
    // odsjekao vrh stupca.
    view.scrollTop = 0;

    const step = width + COLUMN_GAP;
    this.#pages = Math.max(1, Math.round((view.scrollWidth + COLUMN_GAP) / step));

    if (this.#pendingWithin > 0 || this.#pendingAnchor) this.#applyPending();
    else this.#scrollToPage(Math.min(this.#page, this.#pages - 1));
  }

  #applyPending(): void {
    const anchor = this.#pendingAnchor;
    const within = this.#pendingWithin;
    this.#pendingAnchor = null;
    this.#pendingWithin = 0;

    if (anchor) {
      const target = this.book.chapters[this.#chapter]?.body.querySelector(
        `#${CSS.escape(anchor)}, [name="${CSS.escape(anchor)}"]`,
      );
      if (target instanceof HTMLElement) {
        this.#scrollToElement(target);
        return;
      }
    }

    if (this.#options.flow === 'scroll') this.#scrollWithinChapter(within);
    else this.#scrollToPage(Math.round(within * (this.#pages - 1)));
  }

  #step(): number {
    return (this.#view?.clientWidth ?? 0) + COLUMN_GAP;
  }

  #scrollToPage(page: number): void {
    const view = this.#view;
    if (!view) return;
    this.#page = Math.max(0, Math.min(page, this.#pages - 1));
    view.scrollLeft = this.#page * this.#step();
    this.#emitProgress();
  }

  /** Skok na relativno mjesto unutar trenutnog poglavlja, u svitku. */
  #scrollWithinChapter(within: number): void {
    const view = this.#view;
    const body = this.book.chapters[this.#chapter]?.body;
    if (!view || !body) return;
    view.scrollTop = body.offsetTop + within * body.offsetHeight;
    this.#emitProgress();
  }

  #scrollToElement(element: HTMLElement): void {
    const view = this.#view;
    if (!view) return;

    if (this.#options.flow === 'scroll') {
      view.scrollTop = element.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 24;
      this.#emitProgress();
      return;
    }

    const x =
      element.getBoundingClientRect().left - view.getBoundingClientRect().left + view.scrollLeft;
    this.#scrollToPage(Math.floor(x / this.#step()));
  }

  /* ── kretanje ──────────────────────────────────────────────────────── */

  #turn(delta: number): void {
    if (this.#options.flow === 'scroll') {
      const view = this.#view;
      if (!view) return;
      view.scrollBy({ top: delta * (view.clientHeight - 64), behavior: 'smooth' });
      return;
    }

    const next = this.#page + delta;
    if (next < 0) {
      // S prve stranice unatrag → kraj prethodnog poglavlja.
      if (this.#chapter > 0) this.#openChapter(this.#chapter - 1, 'end');
      return;
    }
    if (next >= this.#pages) {
      if (this.#chapter < this.book.chapters.length - 1) this.#openChapter(this.#chapter + 1, 'start');
      return;
    }
    this.#scrollToPage(next);
    this.#schedulePersist();
  }

  #openChapter(index: number, at: 'start' | 'end' | number): void {
    this.#chapter = Math.max(0, Math.min(index, this.book.chapters.length - 1));

    if (this.#options.flow === 'scroll') {
      this.#page = 0;
      const body = this.book.chapters[this.#chapter]?.body;
      if (body) this.#scrollToElement(body);
      this.#schedulePersist();
      this.#markActiveChapter();
      return;
    }

    this.#page = 0;
    this.#renderFlow();
    if (at === 'end') this.#scrollToPage(this.#pages - 1);
    else if (typeof at === 'number') this.#scrollToPage(at);
    this.#schedulePersist();
    this.#markActiveChapter();
  }

  #goToOutline(id: string): void {
    const entry = this.book.outline.find((e) => e.id === id);
    if (!entry) return;
    this.#pendingAnchor = entry.anchor;
    this.#openChapter(entry.chapter, 'start');
    if (this.#pendingAnchor) this.#applyPending();
  }

  #markActiveChapter(): void {
    const list = this.#tocList;
    if (!list) return;
    const active = [...this.book.outline]
      .filter((e) => e.chapter <= this.#chapter)
      .pop();
    for (const button of [...list.querySelectorAll('button')]) {
      button.dataset.active = String(button.dataset.id === active?.id);
    }
  }

  #onScroll(): void {
    if (this.#options.flow === 'scroll') {
      const view = this.#view;
      if (!view) return;
      // Poglavlje je ono koje pokriva sredinu vidljivog dijela.
      const middle = view.scrollTop + view.clientHeight / 2;
      let index = 0;
      this.book.chapters.forEach((chapter, i) => {
        if (chapter.body.offsetTop <= middle) index = i;
      });
      if (index !== this.#chapter) {
        this.#chapter = index;
        this.#markActiveChapter();
      }
    } else {
      const page = Math.round((this.#view?.scrollLeft ?? 0) / this.#step());
      if (page === this.#page) return;
      this.#page = page;
    }
    this.#emitProgress();
    this.#schedulePersist();
  }

  #onKey(event: KeyboardEvent): void {
    // Razmak lista naprijed, Shift+razmak natrag — navika iz svih čitača.
    if (event.key === ' ') {
      event.preventDefault();
      this.#turn(event.shiftKey ? -1 : 1);
      return;
    }

    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
        event.preventDefault();
        this.#turn(1);
        break;
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault();
        this.#turn(-1);
        break;
      case 'ArrowDown':
        if (this.#options.flow === 'paged') {
          event.preventDefault();
          this.#turn(1);
        }
        break;
      case 'ArrowUp':
        if (this.#options.flow === 'paged') {
          event.preventDefault();
          this.#turn(-1);
        }
        break;
      case 'Home':
        event.preventDefault();
        this.#openChapter(0, 'start');
        break;
      case 'End':
        event.preventDefault();
        this.#openChapter(this.book.chapters.length - 1, 'end');
        break;
      default:
        break;
    }
  }

  #onLinkClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const link = target?.closest('[data-link]');
    if (!(link instanceof HTMLElement)) return;
    event.preventDefault();

    const destination = link.dataset.link ?? '';
    const path = destination.split('#')[0] ?? '';
    const anchor = destination.includes('#') ? destination.slice(destination.indexOf('#') + 1) : null;
    const index = this.book.chapters.findIndex((c) => c.href === path);
    if (index === -1) return;

    this.#pendingAnchor = anchor;
    this.#openChapter(index, 'start');
    if (this.#pendingAnchor) this.#applyPending();
  }

  /* ── napredak ──────────────────────────────────────────────────────── */

  #fraction(): number {
    const before = this.#words.slice(0, this.#chapter).reduce((a, b) => a + b, 0);
    const current = this.#words[this.#chapter] ?? 0;

    let within = 0;
    if (this.#options.flow === 'scroll') {
      const view = this.#view;
      const body = this.book.chapters[this.#chapter]?.body;
      if (view && body && body.offsetHeight > 0) {
        within = (view.scrollTop - body.offsetTop) / body.offsetHeight;
      }
    } else if (this.#pages > 1) {
      within = this.#page / (this.#pages - 1);
    }

    within = Math.max(0, Math.min(1, within));
    return Math.max(0, Math.min(1, (before + current * within) / this.#totalWords));
  }

  #emitProgress(): void {
    const fraction = this.#fraction();
    const left = minutes(Math.max(0, this.#totalWords * (1 - fraction)));
    const chapter = this.book.chapters[this.#chapter];

    const place =
      this.#options.flow === 'paged'
        ? t('p. {n}/{total}', { n: this.#page + 1, total: this.#pages })
        : `${Math.round(fraction * 100)} %`;
    const label = `${chapter?.title ?? t('Chapter')} · ${place}`;

    this.#progressEmitter.fire({ fraction, label, minutesLeft: left });
    this.#statusEmitter.fire(
      `${this.#chapter + 1}/${this.book.chapters.length} · ${place} · ${t('~{n} min left', { n: left })}`,
    );
  }

  #schedulePersist(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#persistPosition(), 600);
  }

  #persistPosition(): void {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }

    let within = 0;
    if (this.#options.flow === 'scroll') {
      const view = this.#view;
      const body = this.book.chapters[this.#chapter]?.body;
      if (view && body && body.offsetHeight > 0) {
        within = (view.scrollTop - body.offsetTop) / body.offsetHeight;
      }
    } else if (this.#pages > 1) {
      within = this.#page / (this.#pages - 1);
    }

    this.host.settings.set<StoredPosition>(this.#positionKey, {
      chapter: this.#chapter,
      within: Math.max(0, Math.min(1, within)),
    });
  }

  /* ── način čitanja ─────────────────────────────────────────────────── */

  beginReading(options: ReadingOptions): ReadingSession {
    this.#reading = true;
    this.#setOptions(options);

    const session: ReadingSession = {
      apply: (next) => this.#setOptions(next),
      page: (delta) => this.#turn(delta),
      seek: (fraction) => this.#seek(fraction),
      outline: () =>
        this.book.outline.map<ReadingOutlineItem>((entry) => ({
          id: entry.id,
          label: entry.label,
          depth: entry.depth,
        })),
      goTo: (id) => this.#goToOutline(id),
      onProgress: this.#progressEmitter.event,
      end: () => {
        if (!this.#reading) return;
        this.#reading = false;
        if (this.#root) this.#root.dataset.reading = 'false';
        this.#persistPosition();
      },
    };

    // Prvi napredak mora stići nakon što se čitaonica pretplati.
    queueMicrotask(() => this.#emitProgress());
    return session;
  }

  /** Nove postavke bez gubitka mjesta: zapamti udio, primijeni, vrati se na njega. */
  #setOptions(next: ReadingOptions): void {
    const previous = this.#options;
    const fraction = this.#fraction();

    this.#options = next;
    this.host.settings.set('reading.options', next);
    if (this.#root) this.#applyOptionsTo(this.#root);

    if (previous.flow !== next.flow) this.#renderFlow();
    else this.#relayout();

    this.#seek(fraction);
  }

  #seek(fraction: number): void {
    const target = Math.max(0, Math.min(1, fraction)) * this.#totalWords;

    let index = 0;
    let before = 0;
    for (let i = 0; i < this.#words.length; i++) {
      const words = this.#words[i] ?? 0;
      if (before + words >= target || i === this.#words.length - 1) {
        index = i;
        break;
      }
      before += words;
    }

    const within = (this.#words[index] ?? 0) > 0 ? (target - before) / (this.#words[index] ?? 1) : 0;
    this.#pendingWithin = Math.max(0, Math.min(1, within));

    if (index !== this.#chapter || this.#options.flow === 'paged') {
      this.#chapter = index;
      if (this.#options.flow === 'paged') this.#renderFlow();
      else this.#applyPending();
    } else {
      this.#applyPending();
    }
    this.#markActiveChapter();
  }

  /* ── ugovor ────────────────────────────────────────────────────────── */

  isDirty(): boolean {
    return false;
  }

  async save(): Promise<SaveResult> {
    throw new Error(t('E-books are read-only for now — editing EPUB is not supported.'));
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
   * Pretraga preko cijele knjige. Radi nad živim DOM čvorovima, pa `reveal`
   * može istaknuti točan raspon umjesto da samo skoči na odlomak.
   */
  async find(query: FindQuery): Promise<FindResult[]> {
    if (!query.query) return [];

    const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
    const results: FindResult[] = [];

    for (let index = 0; index < this.book.chapters.length; index++) {
      const chapter = this.book.chapters[index]!;
      if (results.length >= 500) break;

      for (const node of textNodesOf(chapter.body)) {
        const value = node.nodeValue ?? '';
        const haystack = query.caseSensitive ? value : value.toLowerCase();

        let from = 0;
        while (results.length < 500) {
          const at = haystack.indexOf(needle, from);
          if (at === -1) break;
          const to = at + needle.length;
          results.push(this.#hitAt(chapter, index, node, at, to, value));
          from = to;
        }
      }
    }

    return results;
  }

  #hitAt(
    chapter: BookChapter,
    index: number,
    node: Text,
    at: number,
    to: number,
    value: string,
  ): FindResult {
    return {
      label: chapter.title,
      preview: value.slice(Math.max(0, at - 40), to + 40).replace(/\s+/g, ' ').trim(),
      reveal: () => {
        if (this.#chapter !== index) {
          this.#chapter = index;
          if (this.#options.flow === 'paged') this.#renderFlow();
          this.#markActiveChapter();
        }

        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, Math.min(to, value.length));
        showHit(range);

        const holder = node.parentElement;
        if (holder) this.#scrollToElement(holder);
        this.#root?.focus();
      },
    };
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text.trim()) return null;
    return plainPayload(text, { editorId: 'org.uleditor.book', uri: this.doc.uri });
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#root?.focus();
  }
}

export const bookEditorProvider: EditorProvider = {
  id: 'org.uleditor.book',
  displayName: 'E-book reader',
  matches: {
    extensions: ['epub'],
    mimeTypes: ['application/epub+zip'],
  },
  capabilities: ['view', 'search', 'read'],
  priority: 30,

  async createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new BookEditor(host, doc, openEpub(await doc.bytes()));
  },
};

export default bookEditorProvider;
export { BookEditor };
