import { FORMATS } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { openFiles, openFolder } from '../shell/actions.js';
import { useWorkspace } from '../state/workspace.js';
import { FormatIcon } from './Icons.js';

const LIVE = ['code', 'markdown', 'pdf', 'epub', 'image'] as const;
/** Formati koji se otvore, ali samo za čitanje — razlika je bitna prije otvaranja. */
const READ_ONLY: { format: keyof typeof FORMATS; note: string }[] = [
  { format: 'docx', note: 'pregled' },
  { format: 'xlsx', note: 'pregled' },
];
const PLANNED: { format: keyof typeof FORMATS; phase: string }[] = [
  { format: 'odf', phase: 'faza 2' },
  { format: 'pptx', phase: 'faza 5' },
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
            Kod, Markdown, PDF, e-knjige, Word i Excel na jednom mjestu.
          </p>
        </div>

        <div className="welcome-cols">
          <div className="welcome-col">
            <h3>Počni</h3>
            <div className="welcome-list">
              <button className="welcome-action" onClick={() => void openFolder(shell)}>
                Otvori mapu <span className="k">Ctrl K</span>
              </button>
              <button className="welcome-action" onClick={() => void openFiles(shell)}>
                Otvori datoteke <span className="k">Ctrl O</span>
              </button>
              <button className="welcome-action" onClick={() => setPaletteOpen(true)}>
                Paleta naredbi <span className="k">Ctrl ⇧ P</span>
              </button>
              <div className="welcome-action" data-static="true">
                Način čitanja <span className="k">Ctrl ⇧ R</span>
              </div>
            </div>
          </div>

          <div className="welcome-col">
            <h3>Radi sada</h3>
            {LIVE.map((id) => (
              <div key={id} className="fmt-line">
                <FormatIcon family={FORMATS[id].family} size={15} />
                <span>{FORMATS[id].label}</span>
              </div>
            ))}
            {READ_ONLY.map(({ format, note }) => (
              <div key={format} className="fmt-line">
                <FormatIcon family={FORMATS[format].family} size={15} />
                <span>{FORMATS[format].label}</span>
                <span className="tag">{note}</span>
              </div>
            ))}
            {PLANNED.map(({ format, phase }) => (
              <div key={format} className="fmt-line" data-planned="true">
                <FormatIcon family={FORMATS[format].family} size={15} />
                <span>{FORMATS[format].label}</span>
                <span className="tag">{phase}</span>
              </div>
            ))}
          </div>
        </div>

        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--ink-ghost)', lineHeight: 1.6 }}>
          Datoteke možeš i povući izravno u prozor.
        </p>
      </div>
    </div>
  );
}
