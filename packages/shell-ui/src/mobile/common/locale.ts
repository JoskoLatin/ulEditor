/**
 * The language of the phone's shell.
 *
 * The one chosen in the settings, when one was. When none was, the phone's
 * own, if ulEditor speaks it, and otherwise the shell's default. On the
 * desktop a language that was never chosen is English; on a phone there is
 * no settings screen yet to choose another in (ADR 0009, K7), and the phone
 * already says which language its owner reads: measured on 2026-11-08, the
 * WebView of a Pixel set to Croatian reports `navigator.languages` as
 * `["hr-HR"]`, and Arak came up in English all the same.
 *
 * Pure apart from what it is handed: the stored setting and the languages.
 */

import { isLocale, type Locale } from '@uleditor/i18n';

import type { Shell } from '../../host/index.js';

export function localeForPhone(shell: Shell, languages: readonly string[] = navigator.languages ?? []): Locale {
  const stored = shell.settings.get<unknown>('locale', null);
  if (isLocale(stored)) return stored;
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return shell.locale;
}
