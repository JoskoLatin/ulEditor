/**
 * Settings.
 *
 * One modal, not a tree of two hundred switches. Only what a user genuinely
 * changes and has nowhere else to change lives here: the language, the theme and
 * the default reading typography.
 *
 * Changing the language reloads the window. Imperative editors (PDF, book,
 * Office) build DOM directly, so swapping strings on the fly would require
 * unmounting every open document — and the session is restored on start anyway.
 */

import { useState } from 'react';

import { LOCALES, t, type Locale } from '@uleditor/i18n';
import { DEFAULT_READING, type ReadingOptions } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { useWorkspace } from '../state/workspace.js';
import { saveSession } from '../shell/session.js';
import { canZoom, isDefaultZoom, resetZoom, stepZoom, zoomFactor } from '../shell/zoom.js';
import type { ThemePreference } from '../host/index.js';
import { IconClose } from './Icons.js';

const THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export function Preferences() {
  const shell = useShell();
  const open = useWorkspace((s) => s.preferencesOpen);
  const setOpen = useWorkspace((s) => s.setPreferencesOpen);

  /*
   * The theme and the size live outside React — one in a CSS attribute, the
   * other in the webview — so nothing here re-renders when they change. Without
   * a copy of them in state the highlight stays on the option that was chosen
   * before, and the panel shows the wrong answer to the question it just asked.
   */
  const [theme, setTheme] = useState(shell.theme.preference);
  const [zoom, setZoom] = useState(() => zoomFactor(shell));

  if (!open) return null;

  const locale = shell.locale;
  const reading = { ...DEFAULT_READING, ...shell.settings.get<Partial<ReadingOptions>>('reading.options', {}) };

  const chooseLocale = (next: Locale) => {
    if (next === locale) return;
    shell.settings.set('locale', next);
    // The session is saved before the reload so the tabs come back exactly as they were.
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
                data-active={theme === kind}
                onClick={() => {
                  shell.theme.setPreference(kind);
                  shell.settings.set('theme', kind);
                  setTheme(kind);
                }}
              >
                {kind === 'light' ? t('Light') : kind === 'dark' ? t('Dark') : t('Follow system')}
              </button>
            ))}
          </div>
        </section>

        {/*
          Desktop only. In a browser tab Ctrl and the wheel is already the
          browser's own zoom, which survives a reload and needs nothing from us —
          a second control beside it would be one that does nothing.
        */}
        {canZoom(shell) ? (
          <section>
            <h3>{t('Interface size')}</h3>
            <p className="prefs-note">{t('Ctrl and the wheel, or Ctrl+plus and Ctrl+minus.')}</p>
            <div className="prefs-seg">
              <button aria-label={t('Zoom out')} onClick={() => void stepZoom(shell, -1).then(setZoom)}>
                −
              </button>
              <button
                data-active={isDefaultZoom(shell)}
                title={t('Reset the interface size')}
                onClick={() => void resetZoom(shell).then(setZoom)}
              >
                {t('{percent} %', { percent: Math.round(zoom * 100) })}
              </button>
              <button aria-label={t('Zoom in')} onClick={() => void stepZoom(shell, 1).then(setZoom)}>
                +
              </button>
            </div>
          </section>
        ) : null}

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
