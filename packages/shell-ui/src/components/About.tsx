import { useEffect, useRef } from 'react';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { useWorkspace } from '../state/workspace.js';
import { IconClose } from './Icons.js';

/**
 * What this is, and which build of it.
 *
 * Short on purpose. The one thing an About box exists for is the answer to
 * "which version are you running" at the start of every bug report — the rest
 * is a licence, a way to reach the source, and the name of the place it was
 * written in.
 */
export function About() {
  const shell = useShell();
  const open = useWorkspace((s) => s.aboutOpen);
  const setOpen = useWorkspace((s) => s.setAboutOpen);
  const boxRef = useRef<HTMLDivElement>(null);

  /* The focus follows the dialog, or Escape lands on whatever was behind it and
     the box that has just appeared cannot be dismissed by the key everything
     else is dismissed by. */
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="prefs about"
        role="dialog"
        tabIndex={-1}
        ref={boxRef}
        aria-label={t('About ulEditor')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <header>
          <h2>{t('About ulEditor')}</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t('Close')}>
            <IconClose size={13} />
          </button>
        </header>

        <section>
          {/* The name alone. The number is four lines below, in the list this
              box exists to be read from — twice in one dialog is once too many. */}
          <div className="about-mark">
            ul<b>Editor</b>
          </div>
          <p className="prefs-note">{t('One window instead of a dozen programs.')}</p>
        </section>

        <section>
          <dl className="about-facts">
            <dt>{t('Version')}</dt>
            <dd>{__APP_VERSION__}</dd>
            <dt>{t('Licence')}</dt>
            <dd>Apache-2.0</dd>
            <dt>{t('Made in')}</dt>
            {/* Through t() although it is a place name: Croatian puts the place
                in the locative after this label, so the answer to "napravljeno
                u" is "Vodicama" and not "Vodice". */}
            <dd>{t('Vodice')}</dd>
          </dl>
        </section>

        {/*
          Both open in the system browser rather than inside this window — see
          `openExternal`. A host with no browser around it (a check harness) does
          not offer one, and then neither do we.
        */}
        {shell.openExternal ? (
          <section className="about-links">
            <button className="ghost-btn" onClick={() => void shell.commands.execute('help.source')}>
              {t('Source code')}
            </button>
            <button className="ghost-btn" onClick={() => void shell.commands.execute('help.report')}>
              {t('Report a problem')}
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
