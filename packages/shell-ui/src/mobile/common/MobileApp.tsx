import { Suspense, lazy, useEffect, useLayoutEffect, type ComponentType } from 'react';
import { chosenInterface, type InterfaceId } from '@uleditor/mobile-core';

import type { Shell } from '../../host/index.js';
import { adoptDropped } from '../../shell/actions.js';
import { registerCommands } from '../../shell/commands.js';
import { ShellContext } from '../../shell/context.js';
import { watchForPastCrashes } from '../../shell/crash.js';
import { routeExternalLinks } from '../../shell/lifecycle.js';
import { useLibrary } from '../../shell/library.js';
import { restoreSession, watchSession } from '../../shell/session.js';
import { watchBack } from './history.js';
import { watchOpenDocuments } from './open-documents.js';
import { watchQuestions } from './questions.js';
import { settingsStore } from './settings.js';
import { watchKeyboard } from './viewport.js';

/** What every interface is given. */
export interface InterfaceProps {
  shell: Shell;
  ui: InterfaceId;
}

/**
 * The interfaces this build has. Each comes in with its own step, Arak in K6
 * (reading first, K6a), Palac in K7, Četiri boje in K8 (ADR 0009), each as a
 * lazy chunk of its own, so that only the chosen one is loaded on the phone.
 * Until Palac and Četiri boje are built, their names start the development
 * view, which is not one of them, so the shared layer can still be driven
 * apart from any interface (`?ui=palac` in a development build).
 */
const BUILT: readonly InterfaceId[] = ['arak'];

const DevView = lazy(() => import('./DevView.js'));
const INTERFACES: Record<InterfaceId, ComponentType<InterfaceProps>> = {
  arak: lazy(() => import('../ui/arak/Arak.js')),
  palac: DevView,
  boje: DevView,
};

/**
 * The phone's own shell (ADR 0009): what every interface stands on, and the
 * interface itself, chosen once per start and loaded lazily.
 *
 * What is shared with the desktop is called, not copied: the commands, the
 * session (which on a handheld comes back on its own), the reports of a past
 * crash, links kept out of the window. What is the phone's own is started here
 * once for the whole shell: Back through `history`, the keyboard's inset, and
 * every question of `shell.notify` as a layer. None of the desktop's
 * components is imported.
 *
 * `requested`: the interface named in the address (`?ui=`), in a development
 * build only; otherwise the one in the settings, if this build has it.
 */
export function MobileApp({ shell, requested }: { shell: Shell; requested: InterfaceId | null }) {
  const ui = requested ?? chosenInterface(settingsStore(shell), BUILT);
  const Interface = INTERFACES[ui];

  /* Before the first paint: an interface's tokens are keyed on it. */
  useLayoutEffect(() => {
    document.documentElement.dataset.ui = ui;
    return () => {
      delete document.documentElement.dataset.ui;
    };
  }, [ui]);

  useEffect(() => registerCommands(shell), [shell]);

  /* In the order the desktop's `App` keeps, and for its reasons: the restore
     before the watcher, so restoring does not write a half-restored session
     down; a past crash's report last, so it is the document in front. */
  useEffect(() => {
    let stop: (() => void) | undefined;
    void restoreSession(shell).then(() => {
      stop = watchSession(shell);
      watchForPastCrashes(shell);
    });
    return () => stop?.();
  }, [shell]);

  useEffect(() => routeExternalLinks(shell), [shell]);
  useEffect(() => watchBack(), []);
  useEffect(() => watchKeyboard(), []);
  useEffect(() => watchQuestions(shell), [shell]);
  useEffect(() => watchOpenDocuments(), []);

  /* `import.meta.env.DEV` is a constant a build writes in: in a debug or a
     release build this is `false`, `libraryForChecks` is never named, and none
     of it is in the files (`tools/verify-mobile-common.mjs` looks). */
  useEffect(() => (import.meta.env.DEV && shell.platform === 'web' ? libraryForChecks(shell) : undefined), [shell]);

  /* Files dropped onto the window, on the web host only: that is how a check
     in a browser hands the shell a document, as it does the desktop's
     (`tools/verify-ui.mjs`). A phone has nothing to drop. */
  useEffect(() => {
    if (shell.platform !== 'web') return;
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      void adoptDropped(shell, { files });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [shell]);

  return (
    <ShellContext.Provider value={shell}>
      <Suspense fallback={null}>
        <Interface shell={shell} ui={ui} />
      </Suspense>
    </ShellContext.Provider>
  );
}

/** One file a check puts into the library, with the folder Rust would have found it in. */
interface CheckedFile {
  file: File;
  folder: string;
}

/**
 * The library, stood in for by a browser check: development builds over the
 * web host only (ADR 0009, level C).
 *
 * The web host cannot look at a device (`scanLibrary` says so and lists
 * nothing), and Android hiding the documents cannot happen in a browser at all.
 * So a check sends `ul-check-library` with the files: they are registered with
 * the host as dropped files are, **not opened**, and become the library with
 * the dates they carry (`File.lastModified`), as `scan_library` hands it over;
 * `blocked` stands in for Android hiding them. What an interface does with the
 * library from there is the same code the phone runs.
 */
function libraryForChecks(shell: Shell): () => void {
  const onCheck = (event: Event) => {
    const detail = (event as CustomEvent<{ files?: CheckedFile[]; blocked?: boolean }>).detail;
    const files = Array.isArray(detail?.files) ? detail.files : [];
    if (!shell.fs.adoptFiles) return;
    void shell.fs.adoptFiles(files.map((entry) => entry.file)).then((docs) =>
      useLibrary.setState({
        phase: 'done',
        error: null,
        blocked: detail?.blocked === true,
        truncated: false,
        items: docs.map((doc, index) => ({
          uri: doc.uri,
          name: doc.name,
          format: doc.detection.format,
          size: doc.stat.size,
          modified: doc.stat.modified ?? undefined,
          folder: files[index]?.folder ?? '',
        })),
      }),
    );
  };
  window.addEventListener('ul-check-library', onCheck);
  return () => window.removeEventListener('ul-check-library', onCheck);
}
