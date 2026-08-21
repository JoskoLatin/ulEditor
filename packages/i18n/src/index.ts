/**
 * Interface translations.
 *
 * The key is **the English source text**, not an abstract identifier. The reason
 * is practical: English is the default language, so its catalogue is empty and
 * cannot fall apart, and an untranslated string falls back to readable English
 * instead of to `shell.tab.close.tooltip`. gettext takes the same approach.
 *
 * The cost is that changing the English text severs the link to the translation.
 * So the English string changes only when the meaning changes — and then the
 * translation needs checking anyway.
 *
 * The package deliberately has no dependencies: editors are plugins and must be
 * able to import it without dragging the shell along.
 */

import { hr } from './hr.js';

export type Locale = 'en' | 'hr';

export interface LocaleDescriptor {
  id: Locale;
  /** The language name in English — for the list in settings. */
  label: string;
  /** The language name in that language. */
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
 * Sets the language. Called **once, before the first render** — changing the
 * language in a live session goes through a window reload (see settings).
 * Imperative editors build DOM directly, so a reactive swap would require
 * unmounting every open document; a reload is the more honest move, and the
 * session is restored anyway.
 */
export function setLocale(locale: Locale): void {
  current = locale;
}

/**
 * Translation with value interpolation: `t('Page {n} of {total}', { n, total })`.
 *
 * Not to be called in a module body — the catalogue is chosen at call time, so a
 * string computed while the module loads would remember the wrong language.
 */
export function t(source: string, params?: Record<string, string | number>): string {
  const translated = CATALOGS[current][source] ?? source;
  if (!params) return translated;

  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/** Translating a language name — the one string displayed in its own language. */
export function localeName(locale: Locale): string {
  return LOCALES.find((l) => l.id === locale)?.native ?? locale;
}
