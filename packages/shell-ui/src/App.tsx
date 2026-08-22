import { useEffect, useState } from 'react';

import { t } from '@uleditor/i18n';

import type { Shell } from './host/index.js';
import { ShellContext } from './shell/context.js';
import { registerCommands } from './shell/commands.js';
import { adoptDropped } from './shell/actions.js';
import { selectActiveTabId, selectSplit, useWorkspace } from './state/workspace.js';

import { exitReading, useReading } from './shell/reading.js';
import { restoreSession, watchSession } from './shell/session.js';
import { watchLaunchPaths } from './shell/launch.js';

import { ActivityBar } from './components/ActivityBar.js';
import { EditorGroup, GroupResizer } from './components/EditorGroup.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Preferences } from './components/Preferences.js';
import { QuickOpen } from './components/QuickOpen.js';
import { ReaderBar } from './components/ReaderBar.js';
import { SplitPane } from './components/SplitPane.js';
import { Sidebar, SidebarResizer, SidebarScrim } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TitleBar } from './components/TitleBar.js';
import { Toasts } from './components/Toasts.js';

export function App({ shell }: { shell: Shell }) {
  const sidebarVisible = useWorkspace((s) => s.sidebarVisible);
  const activeTabId = useWorkspace(selectActiveTabId);
  const split = useWorkspace(selectSplit);
  const splitRatio = useWorkspace((s) => s.splitRatio);
  const reading = useReading((s) => s.active);
  const readingTabId = useReading((s) => s.tabId);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => registerCommands(shell), [shell]);

  // The session restore runs before the watcher, so the act of restoring does not
  // overwrite the record with a half-restored state.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let stopLaunch: (() => void) | undefined;
    void restoreSession(shell).then(() => {
      stop = watchSession(shell);
      /* After the restore, not beside it. Both bring documents in, and whichever
         finishes last decides which tab is in front — the file somebody
         double-clicked should not end up behind three restored ones. */
      stopLaunch = watchLaunchPaths(shell);
    });
    return () => {
      stop?.();
      stopLaunch?.();
    };
  }, [shell]);

  // The reading room belongs to one document. Switching tabs means leaving it,
  // not quietly carrying on reading something else with somebody else's settings.
  useEffect(() => {
    if (reading && readingTabId !== activeTabId) exitReading();
  }, [reading, readingTabId, activeTabId]);

  // Dropping files onto the window — the web route through `File` objects.
  // It works without the File System Access API too, so in Firefox and Safari it
  // is the only way to open a document at all.
  useEffect(() => {
    if (shell.platform !== 'web') return;

    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDropActive(false);
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      setDropActive(false);
      void adoptDropped(shell, { files });
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [shell]);

  // Dropping on desktop. WebView2 does not expose `File` objects for content from
  // outside the browser — Tauri catches the gesture at the window level and hands
  // over paths.
  useEffect(() => {
    if (shell.platform !== 'desktop') return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'over') setDropActive(true);
        else if (payload.type === 'leave') setDropActive(false);
        else if (payload.type === 'drop') {
          setDropActive(false);
          void adoptDropped(shell, { paths: payload.paths });
        }
      });
      // The component could have unmounted while the subscription was in flight.
      if (cancelled) stop();
      else unlisten = stop;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [shell]);

  // The warning on closing with unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (useWorkspace.getState().tabs.some((t) => t.dirty)) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <ShellContext.Provider value={shell}>
      {/* The reading room does not rework the component tree — it only hides the
          frame. A different tree would unmount the editor and lose the reading
          position. */}
      <div className="shell" data-reading={reading ? 'true' : 'false'}>
        <TitleBar />

        <div className="shell-body" data-sidebar={sidebarVisible ? 'visible' : 'hidden'}>
          <ActivityBar />
          {/* Both grid slots always exist — hiding is a matter of column width, so
              the transition does not read as the layout being rearranged. */}
          {sidebarVisible ? <Sidebar /> : <div />}
          {sidebarVisible ? <SidebarResizer /> : <div />}
          {/* The scrim sits outside the flow and shows only on a narrow screen,
              where the panel covers the content and has to be dismissible with a
              tap beside it. */}
          {sidebarVisible ? <SidebarScrim /> : null}
          <main className="main">
            {reading ? <ReaderBar /> : null}
            {/* Two groups side by side, each with its own tabs and its own
                document in front. The second exists only while it holds
                something — see `collapseEmptyGroup` in the store. */}
            <div
              className="groups"
              data-split={split}
              style={{ gridTemplateColumns: split ? `${splitRatio}fr 5px ${1 - splitRatio}fr` : '1fr' }}
            >
              <EditorGroup group="left" />
              {split ? <GroupResizer /> : null}
              {split ? <EditorGroup group="right" /> : null}
            </div>
            {/* The panel below: the program's own output, not a third tab group. */}
            <SplitPane />
          </main>
        </div>

        <StatusBar />
      </div>

      <CommandPalette />
      <QuickOpen />
      <Preferences />
      <Toasts />

      {dropActive && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 40,
            pointerEvents: 'none',
            border: '2px solid var(--accent)',
            background: 'var(--accent-glow)',
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--fs-lg)',
            color: 'var(--accent-ink)',
          }}
        >
          {t('Drop files to open them')}
        </div>
      )}
    </ShellContext.Provider>
  );
}
