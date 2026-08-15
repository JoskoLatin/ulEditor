/**
 * Prijevodi sučelja.
 *
 * Ključ je **engleski izvorni tekst**, ne apstraktna oznaka. Razlog je
 * praktičan: engleski je zadani jezik, pa je katalog za njega prazan i ne
 * može se raspasti, a neprevedeni niz pada natrag na čitljiv engleski umjesto
 * na `shell.tab.close.tooltip`. Isti pristup koristi gettext.
 *
 * Cijena je da promjena engleskog teksta prekida vezu s prijevodom. Zato se
 * engleski niz mijenja samo kad se mijenja značenje — a tada prijevod ionako
 * treba provjeriti.
 *
 * Paket namjerno nema ovisnosti: editori su plugini i moraju ga smjeti
 * uvesti bez povlačenja shella za sobom.
 */

import { hr } from './hr.js';

export type Locale = 'en' | 'hr';

export interface LocaleDescriptor {
  id: Locale;
  /** Ime jezika na engleskom — za popis u postavkama. */
  label: string;
  /** Ime jezika na tom jeziku. */
  native: string;
}

export const LOCALES: LocaleDescriptor[] = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'hr', label: 'Croatian', native: 'Hrvatski' },
];

export type Catalog = Record<string, string>;

const CATALOGS: Record<Locale, Catalog> = { en: {}, hr };

let current: Locale = 'en';

export function getLocale(): Locale {
  return current;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'hr';
}

/**
 * Postavlja jezik. Zove se **jednom, prije prvog rendera** — promjena jezika
 * u živoj sesiji ide preko ponovnog učitavanja prozora (vidi postavke).
 * Imperativni editori grade DOM izravno, pa bi reaktivna zamjena tražila
 * demontažu svakog otvorenog dokumenta; ponovno učitavanje je pošteniji
 * potez, a sesija se ionako vraća.
 */
export function setLocale(locale: Locale): void {
  current = locale;
}

/**
 * Prijevod uz umetanje vrijednosti: `t('Page {n} of {total}', { n, total })`.
 *
 * Ne poziva se u tijelu modula — katalog se bira tek pri pozivu, pa bi niz
 * izračunat pri učitavanju modula zapamtio krivi jezik.
 */
export function t(source: string, params?: Record<string, string | number>): string {
  const translated = CATALOGS[current][source] ?? source;
  if (!params) return translated;

  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/** Prijevod imena jezika — jedini niz koji se prikazuje na svom jeziku. */
export function localeName(locale: Locale): string {
  return LOCALES.find((l) => l.id === locale)?.native ?? locale;
}
