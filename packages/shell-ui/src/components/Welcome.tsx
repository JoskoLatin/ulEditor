import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
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

interface FormatLine {
  format: keyof typeof FORMATS;
  /** The kind of thing it is, in a word — what somebody says they are working
   *  on before they think about which program made the file. */
  kind: string;
  /**
   * The extensions, not the name of the program that made them.
   *
   * Somebody looking at this screen has a file in front of them and wants to
   * know whether it opens. What they know about that file is what comes after
   * its dot — and an extension belongs to nobody, while "Word" is somebody
   * else's product being used to describe ours. Code is the one line with no
   * extensions: there are fifty of them, and a wall of dotted names says less
   * than the word does.
   */
  ext?: string;
  /** What can actually be done with it — the sentence that decides whether
   *  somebody opens their document here or somewhere else. */
  note: string;
  tag?: string;
}

/**
 * What the program does, split the way somebody deciding whether to open a
 * file here would split it: can I change this, or only look at it.
 *
 * Grouped by the kind of thing rather than one line per format. Six lines of
 * dotted extensions is an inventory, and nobody reads an inventory to find out
 * whether a program is any use to them — while "documents · tables · drawings"
 * is answered at a glance.
 *
 * Each line says what it can genuinely do, and no line rounds up. A viewer
 * described as an editor is found out on the first save, and the trust does
 * not come back — the same rule the fidelity warning is built on. `.eps` and
 * `.cdr` sit under "later" for exactly that reason: the program opens them,
 * and what it says when it does is that it cannot draw them yet.
 */
const EDITS: FormatLine[] = [
  { format: 'code', kind: 'Code', note: '23 languages highlighted, with find and replace' },
  {
    format: 'pdf',
    kind: 'Documents',
    ext: '.pdf .docx .md',
    note: 'retype the text, annotate, reorder pages — the layout stays',
  },
  {
    format: 'xlsx',
    kind: 'Tables',
    ext: '.xlsx .xls',
    note: 'retype cell values; formulas and styles stay',
  },
];

const VIEWS: FormatLine[] = [
  { format: 'epub', kind: 'Books', ext: '.epub', note: 'reading mode, contents, search' },
  { format: 'image', kind: 'Images', ext: '.png .jpg …', note: 'and the text inside them, read out by OCR' },
  { format: 'vector', kind: 'Drawings', ext: '.svg', note: 'the drawing, and its source one button away' },
  { format: 'model', kind: 'Models', ext: '.stl .obj .glb', note: 'turned and lit in three dimensions' },
];

const PLANNED: FormatLine[] = [
  { format: 'odf', kind: 'OpenDocument', ext: '.odt .ods .odp', note: 'through the LibreOffice conversion', tag: 'phase 2' },
  { format: 'vector', kind: 'PostScript', ext: '.eps .cdr', note: 'they need that same conversion', tag: 'phase 2' },
  { format: 'pptx', kind: 'Presentations', ext: '.pptx', note: '', tag: 'phase 5' },
];

function FormatLines({ lines }: { lines: FormatLine[] }) {
  return (
    <>
      {lines.map(({ format, kind, ext, note, tag }) => (
        <div key={kind} className="fmt-line" data-planned={tag ? 'true' : undefined}>
          <FormatIcon family={FORMATS[format].family} size={15} />
          <span className="fmt-kind">{t(kind)}</span>
          {ext ? <span className="fmt-ext">{ext}</span> : null}
          {/* The tag rides inside the sentence rather than in a column of its
              own: it is short, it belongs to that line, and given a rank of its
              own it drops below and makes every planned line twice as tall. */}
          {note || tag ? (
            <span className="fmt-note">
              {note ? t(note) : null}
              {tag ? <span className="tag">{t(tag)}</span> : null}
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

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
    <div className="surface welcome-surface">
      <div className="welcome">
        <div>
          <div className="welcome-mark">
            ul<b>Editor</b>
          </div>
          <p className="welcome-origin">made in Vodice</p>
          {/*
            A list of formats is not a reason to install anything — it is what
            the two columns below are for. This says the thing somebody
            recognises before they have read a single format name: the five
            programs they currently keep open to get through one afternoon.
          */}
          <p className="welcome-sub">{t('One window instead of five programs.')}</p>
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

        </div>

        {/*
          Its own band under the two columns rather than a third one beside
          them. Each line is an extension and a sentence, and a sentence needs
          a width a narrow column cannot give it — squeezed into one, every
          line wrapped and the list stopped being scannable, which is the only
          thing a list like this is for.
        */}
        <div className="welcome-formats">
          <div className="fmt-group">
            <h3>{t('Edits')}</h3>
            <FormatLines lines={EDITS} />
          </div>
          <div className="fmt-group">
            <h3>{t('Views')}</h3>
            <FormatLines lines={VIEWS} />
          </div>
          <div className="fmt-group">
            <h3>{t('Later')}</h3>
            <FormatLines lines={PLANNED} />
          </div>
        </div>

        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--ink-ghost)', lineHeight: 1.6 }}>
          {t('You can also drag files straight into the window.')}
        </p>
      </div>
    </div>
  );
}
