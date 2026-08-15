import { useEffect, useState } from 'react';

import { t } from '@uleditor/i18n';

import type { Shell } from './host/index.js';
import { ShellContext } from './shell/context.js';
import { registerCommands } from './shell/commands.js';
import { adoptDropped } from './shell/actions.js';
import { useWorkspace } from './state/workspace.js';

import { exitReading, useReading } from './shell/reading.js';
import { restoreSession, watchSession } from './shell/session.js';

import { ActivityBar } from './components/ActivityBar.js';
import { CommandPalette } from './components/CommandPalette.js';
import { EditorSurface } from './components/EditorSurface.js';
import { FindPanel } from './components/FindPanel.js';
import { Preferences } from './components/Preferences.js';
import { QuickOpen } from './components/QuickOpen.js';
import { ReaderBar } from './components/ReaderBar.js';
import { SplitPane } from './components/SplitPane.js';
import { Sidebar, SidebarResizer } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TabBar } from './components/TabBar.js';
import { TitleBar } from './components/TitleBar.js';
import { Toasts } from './components/Toasts.js';

export function App({ shell }: { shell: Shell }) {
  const sidebarVisible = useWorkspace((s) => s.sidebarVisible);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const reading = useReading((s) => s.active);
  const readingTabId = useReading((s) => s.tabId);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => registerCommands(shell), [shell]);

  // Obnova sesije ide prije praćenja, da sam čin obnove ne prepiše zapis
  // djelomično obnovljenim stanjem.
  useEffect(() => {
    let stop: (() => void) | undefined;
    void restoreSession(shell).then(() => {
      stop = watchSession(shell);
    });
    return () => stop?.();
  }, [shell]);

  // Čitaonica pripada jednom dokumentu. Prebacivanje kartice je izlazak, a ne
  // tiho nastavljanje čitanja nečeg drugog s tuđim postavkama.
  useEffect(() => {
    if (reading && readingTabId !== activeTabId) exitReading();
  }, [reading, readingTabId, activeTabId]);

  // Ispuštanje datoteka u prozor — web put preko `File` objekata.
  // Radi i bez File System Access API-ja, pa je u Firefoxu i Safariju
  // jedini način da se dokument uopće otvori.
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

  // Ispuštanje na desktopu. WebView2 ne izlaže `File` objekte za sadržaj
  // izvan preglednika — Tauri hvata gestu na razini prozora i daje putanje.
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
      // Komponenta se mogla demontirati dok je pretplata bila u tijeku.
      if (cancelled) stop();
      else unlisten = stop;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [shell]);

  // Upozorenje pri zatvaranju s nespremljenim promjenama.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (useWorkspace.getState().tabs.some((t) => t.dirty)) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <ShellContext.Provider value={shell}>
      {/* Čitaonica ne prerađuje stablo komponenti — samo skriva okvir. Drukčije
          stablo bi demontiralo editor i izgubilo mjesto na kojem se čita. */}
      <div className="shell" data-reading={reading ? 'true' : 'false'}>
        <TitleBar />

        <div className="shell-body" data-sidebar={sidebarVisible ? 'visible' : 'hidden'}>
          <ActivityBar />
          {/* Oba mjesta u gridu postoje uvijek — skrivanje je stvar širine
              stupca, pa se prijelaz ne vidi kao preslagivanje layouta. */}
          {sidebarVisible ? <Sidebar /> : <div />}
          {sidebarVisible ? <SidebarResizer /> : <div />}
          <main className="main">
            {reading ? <ReaderBar /> : null}
            <TabBar />
            <FindPanel />
            <EditorSurface />
            {/* Ploča ispod: vlastiti izlaz programa, ne druga grupa kartica. */}
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
