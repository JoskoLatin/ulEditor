import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { formatLabel } from '../shell/formats.js';
import { openFiles, openFolder, openRecentFolder, openUri } from '../shell/actions.js';
import { hasRecent, recentFiles, recentFolders } from '../shell/recent.js';
import { useWorkspace } from '../state/workspace.js';
import { FormatIcon, IconFolderOpen } from './Icons.js';
import { detectByName } from '../host/detect.js';

/** The icon beside a remembered file: from the name, since the file is not open
 *  and reading it to decide which picture to draw would be absurd. */
function formatOfName(name: string) {
  return detectByName(name).format;
}

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
  /*
   * Read once, when the empty screen is drawn. The list only changes by opening
   * something, and opening something replaces this screen — so there is nothing
   * to keep in sync.
   */
  const folders = recentFolders(shell);
  const files = recentFiles(shell);

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

          {/*
            Where you were. The session brings back the tabs of the last run on
            its own; this is for the document from last week, whose folder
            nobody remembers. Absent on the web, where a stored path reopens
            nothing — see shell/recent.ts.
          */}
          {hasRecent(shell) ? (
            <div className="welcome-col">
              <h3>{t('Recent')}</h3>
              <div className="welcome-list">
                {folders.map((entry) => (
                  <button
                    key={entry.uri}
                    className="welcome-action welcome-recent"
                    title={entry.uri}
                    onClick={() => void openRecentFolder(shell, { uri: entry.uri, name: entry.name })}
                  >
                    <IconFolderOpen size={13} />
                    <span className="name">{entry.name}</span>
                  </button>
                ))}
                {files.map((entry) => (
                  <button
                    key={entry.uri}
                    className="welcome-action welcome-recent"
                    title={entry.uri}
                    onClick={() => void openUri(shell, entry.uri)}
                  >
                    <FormatIcon family={FORMATS[formatOfName(entry.name)].family} size={13} />
                    <span className="name">{entry.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
