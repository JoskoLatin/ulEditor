import { FORMATS } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { openFiles, openFolder, saveActive } from '../shell/actions.js';
import { useWorkspace } from '../state/workspace.js';
import { IconCommand, IconFolderOpen, IconSave } from './Icons.js';

export function TitleBar() {
  const shell = useShell();
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setPaletteOpen = useWorkspace((s) => s.setPaletteOpen);

  const active = tabs.find((t) => t.id === activeTabId);
  const format = active ? FORMATS[active.format] : null;

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="brand" title="ulEditor 0.1.0">
          <span>ul</span>
          <b>Editor</b>
        </div>
        <button className="chrome-btn" onClick={() => void openFolder(shell)} title="Otvori mapu (Ctrl+K)">
          <IconFolderOpen size={14} />
          Mapa
        </button>
        <button className="chrome-btn" onClick={() => void openFiles(shell)} title="Otvori datoteke (Ctrl+O)">
          Datoteke
        </button>
        <button
          className="chrome-btn"
          onClick={() => void saveActive(shell)}
          disabled={!active || active.readonly}
          title="Spremi (Ctrl+S)"
        >
          <IconSave size={14} />
          Spremi
        </button>
      </div>

      <div className="titlebar-title">
        {active ? (
          <>
            <b>{active.name}</b>
            {format ? ` — ${format.label}` : null}
            {active.dirty ? ' •' : ''}
          </>
        ) : (
          'Nema otvorenih dokumenata'
        )}
      </div>

      <div className="titlebar-right">
        <button
          className="chrome-btn"
          onClick={() => setPaletteOpen(true)}
          title="Paleta naredbi (Ctrl+Shift+P)"
        >
          <IconCommand size={13} />
          <kbd>Ctrl ⇧ P</kbd>
        </button>
      </div>
    </header>
  );
}
