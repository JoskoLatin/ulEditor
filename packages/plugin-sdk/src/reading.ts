/**
 * Način čitanja.
 *
 * Čitanje knjige nije "editor bez alatnih traka". Traži drukčiju tipografiju,
 * drukčiji tok sadržaja (stranice umjesto svitka), sadržaj po poglavljima i
 * pamćenje mjesta na kojem si stao. Zato je to dio ugovora, a ne trik u
 * shellu: shell nudi jednu čitaonicu, a svaki editor sam zna što je kod njega
 * "stranica" i "poglavlje".
 *
 * Editor koji ovo ne implementira jednostavno nema `beginReading` — shell tada
 * naredbu ne nudi. Neobavezan član je minor izmjena ugovora.
 */

import type { Event } from './events.js';

/** Podloga čitaonice. Namjerno tri, ne paleta — više izbora nitko ne koristi. */
export type ReadingTint = 'day' | 'sepia' | 'night';

/** Stranice (stupci koji se listaju) ili neprekinuti svitak. */
export type ReadingFlow = 'paged' | 'scroll';

export interface ReadingOptions {
  /** Serifni za prozu, bezserifni za tehnički tekst. */
  typeface: 'serif' | 'sans';
  /** Osnovna veličina teksta u pikselima. */
  fontSize: number;
  lineHeight: number;
  /** Širina stupca u znakovima. Preko ~90 oko gubi početak sljedećeg retka. */
  measure: number;
  tint: ReadingTint;
  flow: ReadingFlow;
}

export const DEFAULT_READING: ReadingOptions = {
  typeface: 'serif',
  fontSize: 19,
  lineHeight: 1.65,
  measure: 68,
  tint: 'day',
  flow: 'paged',
};

/** Stavka sadržaja — poglavlje u knjizi, naslov u Markdownu, stranica u PDF-u. */
export interface ReadingOutlineItem {
  id: string;
  label: string;
  /** 0 = korijenska razina. */
  depth: number;
}

export interface ReadingProgress {
  /** Udio pročitanog, 0..1. */
  fraction: number;
  /** Kratka oznaka mjesta, npr. "Poglavlje 3 · str. 2/14". */
  label: string;
  /** Procjena preostalog vremena u minutama, kad je editor može dati. */
  minutesLeft?: number;
}

/**
 * Živa sesija čitanja. Traje dok korisnik ne izađe iz čitaonice; `end()` vraća
 * editor u uobičajeno stanje i mora biti idempotentan.
 */
export interface ReadingSession {
  /** Nove tipografske postavke bez gubitka mjesta na kojem se čita. */
  apply(options: ReadingOptions): void;

  /** Pomak za ±1 stranicu (ili ekran, u svitku). */
  page(delta: number): void;

  /** Skok na relativnu poziciju 0..1 — vuče se traka napretka. */
  seek(fraction: number): void;

  outline(): ReadingOutlineItem[];
  goTo(id: string): void;

  readonly onProgress: Event<ReadingProgress>;

  end(): void;
}
