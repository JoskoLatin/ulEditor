import { FORMATS } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openFiles, openFolder, saveActive } from '../shell/actions.js';
import { formatLabel } from '../shell/formats.js';
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
        <button
          className="chrome-btn"
          onClick={() => void openFolder(shell)}
          title={t('Open folder (Ctrl+K)')}
        >
          <IconFolderOpen size={14} />
          {t('Folder')}
        </button>
        <button
          className="chrome-btn"
          onClick={() => void openFiles(shell)}
          title={t('Open files (Ctrl+O)')}
        >
          {t('Files')}
        </button>
        <button
          className="chrome-btn"
          onClick={() => void saveActive(shell)}
          disabled={!active || active.readonly}
          title={t('Save (Ctrl+S)')}
        >
          <IconSave size={14} />
          {t('Save')}
        </button>
      </div>

      <div className="titlebar-title">
        {active ? (
          <>
            <b>{active.name}</b>
            {format ? ` — ${formatLabel(format.id)}` : null}
            {active.dirty ? ' •' : ''}
          </>
        ) : (
          t('No documents open')
        )}
      </div>

      <div className="titlebar-right">
        <button
          className="chrome-btn"
          onClick={() => setPaletteOpen(true)}
          title={t('Command palette (Ctrl+Shift+P)')}
        >
          <IconCommand size={13} />
          <kbd>Ctrl ⇧ P</kbd>
        </button>
      </div>
    </header>
  );
}
