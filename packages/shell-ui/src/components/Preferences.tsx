/**
 * Postavke.
 *
 * Jedan modal, ne stablo s dvjesto prekidača. Ovdje je samo ono što korisnik
 * stvarno mijenja, a nema mu drugog mjesta: jezik, tema i zadana tipografija
 * čitanja.
 *
 * Promjena jezika ponovno učita prozor. Imperativni editori (PDF, knjiga,
 * Office) grade DOM izravno, pa bi zamjena nizova u letu tražila demontažu
 * svakog otvorenog dokumenta — a sesija se ionako vraća pri pokretanju.
 */

import { LOCALES, t, type Locale } from '@uleditor/i18n';
import { DEFAULT_READING, type ReadingOptions } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { useWorkspace } from '../state/workspace.js';
import { saveSession } from '../shell/session.js';
import type { ThemePreference } from '../host/index.js';
import { IconClose } from './Icons.js';

const THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export function Preferences() {
  const shell = useShell();
  const open = useWorkspace((s) => s.preferencesOpen);
  const setOpen = useWorkspace((s) => s.setPreferencesOpen);

  if (!open) return null;

  const locale = shell.locale;
  const reading = { ...DEFAULT_READING, ...shell.settings.get<Partial<ReadingOptions>>('reading.options', {}) };

  const chooseLocale = (next: Locale) => {
    if (next === locale) return;
    shell.settings.set('locale', next);
    // Sesija se sprema prije osvježavanja da se kartice vrate takve kakve jesu.
    saveSession(shell);
    window.location.reload();
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="prefs"
        role="dialog"
        aria-label={t('Preferences')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <header>
          <h2>{t('Preferences')}</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t('Close')}>
            <IconClose size={13} />
          </button>
        </header>

        <section>
          <h3>{t('Language')}</h3>
          <p className="prefs-note">{t('Changing the language reloads the window.')}</p>
          <div className="prefs-seg">
            {LOCALES.map((entry) => (
              <button
                key={entry.id}
                data-active={locale === entry.id}
                onClick={() => chooseLocale(entry.id)}
              >
                {entry.native}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>{t('Theme')}</h3>
          <div className="prefs-seg">
            {THEMES.map((kind) => (
              <button
                key={kind}
                data-active={shell.theme.preference === kind}
                onClick={() => {
                  shell.theme.setPreference(kind);
                  shell.settings.set('theme', kind);
                  // Tema mijenja samo CSS varijable, pa je dovoljan render.
                  setOpen(true);
                }}
              >
                {kind === 'light' ? t('Light') : kind === 'dark' ? t('Dark') : t('Follow system')}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>{t('Reading defaults')}</h3>
          <p className="prefs-note">
            {t('Typeface {face}, {size} px, background {tint}. Change these in the reader itself.', {
              face: reading.typeface === 'serif' ? t('Serif') : t('Sans'),
              size: reading.fontSize,
              tint: reading.tint === 'day' ? t('Day') : reading.tint === 'sepia' ? t('Sepia') : t('Night'),
            })}
          </p>
          <button
            className="ghost-btn"
            onClick={() => {
              shell.settings.set('reading.options', DEFAULT_READING);
              setOpen(true);
            }}
          >
            {t('Reset reading settings')}
          </button>
        </section>
      </div>
    </div>
  );
}
