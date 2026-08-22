/**
 * Opening the file the program was double-clicked with.
 *
 * The installer registers ulEditor for a list of extensions, which puts it in
 * the "Open with" menu. That registration is worth nothing on its own: the
 * system starts the program with a path and, without this, the program opens
 * an empty window and the person concludes it cannot read their file.
 *
 * Two ways in, and they are not alike:
 *
 * - **A cold start.** The path is on the command line. The core holds it until
 *   asked, because the window exists before the interface inside it does, and a
 *   file opened before the shell is listening is opened into nothing.
 * - **A second double-click while it is running.** Windows and Linux would start
 *   a second copy; the single-instance plugin in the core stops that and sends
 *   the paths to the window already open. macOS never starts a second copy — it
 *   hands the file to the running application, which arrives on the same event.
 *
 * The session restore has to finish first. Both bring documents in, and a race
 * between them decides which tab ends up in front — so the file the person
 * actually asked for could end up behind three restored ones.
 */

import type { Shell } from '../host/index.js';
import { adoptDropped } from './actions.js';

/** Named like a URL so it cannot collide with an event from a plugin. */
const OPEN_PATHS = 'uleditor://open-paths';

async function open(shell: Shell, paths: unknown): Promise<void> {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  if (list.length) await adoptDropped(shell, { paths: list });
}

/**
 * Takes whatever the program was started with, and keeps listening.
 *
 * Returns a function that stops listening. Failure is quiet on purpose: an
 * older core without the command, or a build where the event never comes, must
 * not turn startup into an error message about a file the person did not ask
 * about.
 */
export function watchLaunchPaths(shell: Shell): () => void {
  if (shell.platform !== 'desktop') return () => {};

  let unlisten: (() => void) | undefined;
  let cancelled = false;

  void (async () => {
    try {
      const [{ invoke }, { listen }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/event'),
      ]);

      const stop = await listen<string[]>(OPEN_PATHS, (event) => void open(shell, event.payload));
      if (cancelled) stop();
      else unlisten = stop;

      /* Drained rather than read: the window reloads when the language changes,
         and a list that survived would reopen the same files every time. */
      await open(shell, await invoke<string[]>('take_launch_paths'));
    } catch {
      // Nothing to report — see above.
    }
  })();

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
