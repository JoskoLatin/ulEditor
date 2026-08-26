import { useEffect, useState } from 'react';

import { FORMATS } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { saveActive } from '../shell/actions.js';
import { requestExit } from '../shell/lifecycle.js';
import { MenuBar } from './MenuBar.js';
import { formatLabel } from '../shell/formats.js';
import { visibleViews } from '../shell/views.js';
import { activeInstance, selectActiveTabId, useWorkspace } from '../state/workspace.js';
import {
  IconCommand,
  IconRedo,
  IconMaximise,
  IconMinimise,
  IconRestore,
  IconSave,
  IconUndo,
  IconWindowClose,
} from './Icons.js';

/**
 * macOS keeps its own title bar, and its window buttons with it.
 *
 * The window is undecorated everywhere else, so this bar is the whole frame and
 * has to carry minimise, maximise and close itself. On macOS the traffic lights
 * are muscle memory, are placed by the system and behave in ways nothing drawn
 * in HTML reproduces — full screen on the green one, the pair of them dimming
 * when the window loses focus. `tauri.macos.conf.json` leaves the decorations in
 * place there for that reason, and drawing a second set of buttons under the
 * first would be the visible half of the mistake.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * The window buttons.
 *
 * Windows 11 loses one thing here that no HTML button can offer: hovering the
 * maximise button normally opens the snap layouts, which the system draws only
 * for a button it owns. Dragging to the edge of the screen still snaps.
 */
function WindowControls() {
  const shell = useShell();
  const [maximised, setMaximised] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const read = () => void win.isMaximized().then((v) => !cancelled && setMaximised(v));
      read();
      // The window is also maximised by dragging it to the top edge and by a
      // double-click on the bar, so the icon cannot be flipped from the click.
      const unlisten = await win.onResized(read);
      if (cancelled) unlisten();
      else stop = unlisten;
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const act = (name: 'minimize' | 'toggleMaximize') => {
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow()[name]();
    })();
  };

  return (
    <div className="window-controls">
      <button
        className="window-btn"
        onClick={() => act('minimize')}
        title={t('Minimise')}
        aria-label={t('Minimise')}
      >
        <IconMinimise size={16} />
      </button>
      <button
        className="window-btn"
        onClick={() => act('toggleMaximize')}
        title={maximised ? t('Restore') : t('Maximise')}
        aria-label={maximised ? t('Restore') : t('Maximise')}
      >
        {maximised ? <IconRestore size={16} /> : <IconMaximise size={16} />}
      </button>
      {/*
        Not `window.close()`. The button in the corner and Exit in the File menu
        are the same act, and the question about unsaved work belongs to the act
        rather than to the route taken to it — see `requestExit`.
      */}
      <button
        className="window-btn"
        data-close="true"
        onClick={() => void requestExit(shell)}
        title={t('Close window')}
        aria-label={t('Close window')}
      >
        <IconWindowClose size={16} />
      </button>
    </div>
  );
}

/**
 * The view switch in the title bar.
 *
 * It exists only on a narrow screen, where there is no vertical bar along the
 * edge — the CSS hides it on desktop. The panel opens **downwards, below the
 * bar**, because on a phone the top is the only place a thumb reaches without
 * regripping.
 */
function ViewSwitch() {
  const view = useWorkspace((s) => s.sidebarView);
  const visible = useWorkspace((s) => s.sidebarVisible);
  const setView = useWorkspace((s) => s.setSidebarView);
  const setVisible = useWorkspace((s) => s.setSidebarVisible);

  return (
    <div className="view-switch">
      {visibleViews().map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className="view-btn"
          data-active={visible && view === id}
          title={label}
          aria-label={label}
          aria-expanded={visible && view === id}
          onClick={() => (visible && view === id ? setVisible(false) : setView(id))}
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  );
}

export function TitleBar() {
  const shell = useShell();
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace(selectActiveTabId);
  const setPaletteOpen = useWorkspace((s) => s.setPaletteOpen);

  const active = tabs.find((t) => t.id === activeTabId);
  const format = active ? FORMATS[active.format] : null;
  /*
   * Read while rendering rather than kept in the store: the history belongs to
   * the editor, and mirroring it here would mean two places that can disagree.
   * The bar redraws whenever the tab does — which is on the first change, since
   * that is what turns the document dirty — so the buttons come alive with it.
   */
  const instance = activeTabId ? activeInstance() : null;

  /*
   * `data-tauri-drag-region` is what makes an undecorated window movable, and it
   * works on the element the click actually lands on — so it goes on the bar and
   * on the title, and never on anything a person is meant to press. A
   * double-click on it maximises, which the system used to do for us.
   */
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <div className="brand" title={`ulEditor ${__APP_VERSION__}`}>
          <span>ul</span>
          <b>Editor</b>
          <small>{__APP_VERSION__}</small>
        </div>

        <ViewSwitch />

        {/*
          The menu carries what used to be two buttons here — Folder and Files —
          along with everything else the program can do. Two of its rows drawn a
          second time beside it would be a second answer to the same question,
          and the bar has only so much room before the document's name in the
          middle stops fitting. On a phone there is no Alt and no room at all;
          the CSS hides it there, where the library covers the same ground.
        */}
        <MenuBar />

        <button
          className="chrome-btn"
          onClick={() => void saveActive(shell)}
          disabled={!active || active.readonly}
          title={t('Save (Ctrl+S)')}
        >
          <IconSave size={14} />
          {t('Save')}
        </button>

        {/*
          Undo and redo where they can be seen. The keys have always done this,
          which is enough for somebody who knows them and nothing at all for
          somebody who does not — and an editor whose only way back is a
          shortcut is an editor people are afraid to try things in.
        */}
        <button
          className="chrome-btn icon-only"
          onClick={() => instance?.undo()}
          disabled={!instance?.canUndo()}
          title={t('Undo (Ctrl+Z)')}
          aria-label={t('Undo (Ctrl+Z)')}
        >
          <IconUndo size={14} />
        </button>
        <button
          className="chrome-btn icon-only"
          onClick={() => instance?.redo()}
          disabled={!instance?.canRedo()}
          title={t('Redo (Ctrl+Shift+Z)')}
          aria-label={t('Redo (Ctrl+Shift+Z)')}
        >
          <IconRedo size={14} />
        </button>
      </div>

      <div className="titlebar-title" data-tauri-drag-region>
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

        {shell.platform === 'desktop' && !IS_MAC ? <WindowControls /> : null}
      </div>
    </header>
  );
}
