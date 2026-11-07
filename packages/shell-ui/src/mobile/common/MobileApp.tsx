import { Suspense, lazy, useEffect, useLayoutEffect, type ComponentType } from 'react';
import { chosenInterface, type InterfaceId } from '@uleditor/mobile-core';

import type { Shell } from '../../host/index.js';
import { adoptDropped } from '../../shell/actions.js';
import { registerCommands } from '../../shell/commands.js';
import { ShellContext } from '../../shell/context.js';
import { watchForPastCrashes } from '../../shell/crash.js';
import { routeExternalLinks } from '../../shell/lifecycle.js';
import { restoreSession, watchSession } from '../../shell/session.js';
import { watchBack } from './history.js';
import { watchQuestions } from './questions.js';
import { settingsStore } from './settings.js';
import { watchKeyboard } from './viewport.js';

/** What every interface is given. */
export interface InterfaceProps {
  shell: Shell;
  ui: InterfaceId;
}

/**
 * The interfaces this build has: none yet. Each comes in with its own step,
 * Arak in K6, Palac in K7, Četiri boje in K8 (ADR 0009), each as a lazy chunk
 * of its own, so that only the chosen one is loaded on the phone. Until then
 * all three are the development view, which is not one of them.
 */
const BUILT: readonly InterfaceId[] = [];

const DevView = lazy(() => import('./DevView.js'));
const INTERFACES: Record<InterfaceId, ComponentType<InterfaceProps>> = {
  arak: DevView,
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
