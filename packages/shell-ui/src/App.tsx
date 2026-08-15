import { useEffect, useState } from 'react';

import type { Shell } from './host/index.js';
import { ShellContext } from './shell/context.js';
import { registerCommands } from './shell/commands.js';
import { openDocument } from './shell/actions.js';
import { useWorkspace } from './state/workspace.js';

import { ActivityBar } from './components/ActivityBar.js';
import { CommandPalette } from './components/CommandPalette.js';
import { EditorSurface } from './components/EditorSurface.js';
import { FindPanel } from './components/FindPanel.js';
import { Sidebar, SidebarResizer } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TabBar } from './components/TabBar.js';
import { TitleBar } from './components/TitleBar.js';
import { Toasts } from './components/Toasts.js';

export function App({ shell }: { shell: Shell }) {
  const sidebarVisible = useWorkspace((s) => s.sidebarVisible);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => registerCommands(shell), [shell]);

  // Ispuštanje datoteka u prozor. Radi i bez File System Access API-ja,
  // pa je u Firefoxu i Safariju jedini put do dokumenta.
  useEffect(() => {
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
      // Na desktopu Tauri sam hvata ispuštanje i daje putanje, pa web put
      // preko `File` objekata ondje ne postoji.
      if (!files?.length || !shell.fs.adoptFiles) return;
      event.preventDefault();
      setDropActive(false);
      void shell.fs.adoptFiles(files).then(async (docs) => {
        for (const doc of docs) await openDocument(shell, doc);
      });
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
      <div className="shell">
        <TitleBar />

        <div className="shell-body" data-sidebar={sidebarVisible ? 'visible' : 'hidden'}>
          <ActivityBar />
          {/* Oba mjesta u gridu postoje uvijek — skrivanje je stvar širine
              stupca, pa se prijelaz ne vidi kao preslagivanje layouta. */}
          {sidebarVisible ? <Sidebar /> : <div />}
          {sidebarVisible ? <SidebarResizer /> : <div />}
          <main className="main">
            <TabBar />
            <FindPanel />
            <EditorSurface />
          </main>
        </div>

        <StatusBar />
      </div>

      <CommandPalette />
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
          Ispusti datoteke za otvaranje
        </div>
      )}
    </ShellContext.Provider>
  );
}
