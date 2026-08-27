/**
 * Leaving, and coming back.
 *
 * Two actions that end the run: closing the window, and changing the language —
 * which is a reload, because imperative editors (PDF, book, Office) build DOM
 * directly and swapping the strings under them would mean unmounting every open
 * document. Both write the session down first, so what comes back is what was
 * on screen.
 *
 * Its own module rather than a corner of `actions.ts`: the session already
 * imports the actions, and an action that imports the session back closes a
 * circle the bundler would have to guess its way out of.
 */

import { isLocale, t, type Locale } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { useWorkspace } from '../state/workspace.js';
import { useScratch } from './scratch.js';
import { saveSession } from './session.js';

/**
 * The language, chosen once and restored on the next start.
 *
 * The window reloads, so the session is written down first — otherwise the
 * tabs open at the moment of the change would be the ones lost to it.
 */
export function chooseLocale(shell: Shell, next: Locale): void {
  if (!isLocale(next) || next === shell.locale) return;
  shell.settings.set('locale', next);
  saveSession(shell);
  window.location.reload();
}

/**
 * Asked, not announced.
 *
 * A window with unsaved work in it is closed by the same gesture as an empty
 * one, and the program is the only thing that knows the difference. So the
 * question is asked here, and both routes this program owns — the button in the
 * corner of the title bar and Exit in the File menu — go through it.
 *
 * **It is not every route.** Alt+F4, the taskbar's Close, a shutdown, and on
 * macOS the traffic light and Cmd+Q all destroy the window natively; nothing
 * registers `onCloseRequested`, and the page's `beforeunload` cannot veto a
 * native destroy. That is not a loss against what came before — until this
 * function existed no route asked at all — but it is a gap, and a comment
 * claiming otherwise would be worse than the gap. Closing it means registering
 * the listener once and calling `destroy()` ourselves, because Tauri prevents
 * every close as soon as one exists.
 */
let asking = false;

export async function requestExit(shell: Shell): Promise<void> {
  /* One question at a time. Two presses of the button in the corner used to
     stack two identical warnings, and answering one of them left the other
     standing — with a "Close anyway" that still worked, so cancelling did not
     mean the window stayed. */
  if (asking) return;

  const dirty = useWorkspace.getState().tabs.filter((tab) => tab.dirty);
  /* The panel below the document holds work too — text a plugin produced, an
     OCR pass over a scan — and it is not a tab, so counting tabs missed it. */
  const scratchDirty = useScratch.getState().dirty;

  if (dirty.length > 0 || scratchDirty) {
    asking = true;
    const stay = await new Promise<boolean>((resolve) => {
      const handle = shell.notify.show(
        'warning',
        dirty.length === 1 && !scratchDirty
          ? t('{name} has unsaved changes.', { name: dirty[0]?.name ?? '' })
          : t('Some documents have unsaved changes.'),
        [
          { label: t('Cancel'), run: () => (handle.dispose(), resolve(true)) },
          { label: t('Close anyway'), run: () => (handle.dispose(), resolve(false)) },
        ],
      );
    });
    asking = false;
    if (stay) return;
  }

  saveSession(shell);

  if (shell.platform === 'desktop') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
    return;
  }

  /* A browser tab closes only the ones a script opened itself, so this does
     nothing in most cases — which is why Exit is not offered on the web. It is
     here for the tab that was opened by a script and can close. */
  window.close();
}
