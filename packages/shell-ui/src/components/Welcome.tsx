import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { formatLabel } from '../shell/formats.js';
import { openFiles, openFolder } from '../shell/actions.js';
import { useWorkspace } from '../state/workspace.js';
import { FormatIcon } from './Icons.js';

const LIVE = ['code', 'markdown', 'pdf', 'epub', 'image'] as const;
/** Formats that open, but read-only — the difference matters before opening. */
const READ_ONLY: { format: keyof typeof FORMATS; note: string }[] = [
  { format: 'docx', note: 'preview' },
  { format: 'xlsx', note: 'preview' },
];
const PLANNED: { format: keyof typeof FORMATS; phase: string }[] = [
  { format: 'odf', phase: 'phase 2' },
  { format: 'pptx', phase: 'phase 5' },
];

export function Welcome() {
  const shell = useShell();
  const setPaletteOpen = useWorkspace((s) => s.setPaletteOpen);

  return (
    <div className="surface">
      <div className="welcome">
        <div>
          <div className="welcome-mark">
            ul<b>Editor</b>
          </div>
          <p className="welcome-origin">made in Vodice</p>
          <p className="welcome-sub">
            {t('Code, Markdown, PDF, e-books, Word and Excel in one place.')}
          </p>
        </div>

        <div className="welcome-cols">
          <div className="welcome-col">
            <h3>{t('Start')}</h3>
            <div className="welcome-list">
              <button className="welcome-action" onClick={() => void openFolder(shell)}>
                {t('Open folder')} <span className="k">Ctrl K</span>
              </button>
              <button className="welcome-action" onClick={() => void openFiles(shell)}>
                {t('Open files')} <span className="k">Ctrl O</span>
              </button>
              <button className="welcome-action" onClick={() => setPaletteOpen(true)}>
                {t('Command palette')} <span className="k">Ctrl ⇧ P</span>
              </button>
              <div className="welcome-action" data-static="true">
                {t('Reading mode')} <span className="k">Ctrl ⇧ R</span>
              </div>
            </div>
          </div>

          <div className="welcome-col">
            <h3>{t('Working now')}</h3>
            {LIVE.map((id) => (
              <div key={id} className="fmt-line">
                <FormatIcon family={FORMATS[id].family} size={15} />
                <span>{formatLabel(id)}</span>
              </div>
            ))}
            {READ_ONLY.map(({ format, note }) => (

              <div key={format} className="fmt-line">
                <FormatIcon family={FORMATS[format].family} size={15} />
                <span>{formatLabel(format)}</span>
                <span className="tag">{t(note)}</span>
              </div>
            ))}
            {PLANNED.map(({ format, phase }) => (
              <div key={format} className="fmt-line" data-planned="true">
                <FormatIcon family={FORMATS[format].family} size={15} />
                <span>{formatLabel(format)}</span>
                <span className="tag">{t(phase)}</span>
              </div>
            ))}
          </div>
        </div>

        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--ink-ghost)', lineHeight: 1.6 }}>
          {t('You can also drag files straight into the window.')}
        </p>
      </div>
    </div>
  );
}
