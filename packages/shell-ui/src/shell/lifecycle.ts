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
import { native } from '../host/native.js';

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
 * question is asked here, and every route goes through it: the button in the
 * corner of the title bar and Exit in the File menu call this directly, and
 * the native ones — Alt+F4, the taskbar's Close, the window menu, on macOS the
 * traffic light — arrive through `guardWindowClose` below.
 *
 * **Still not every route.** Cmd+Q on macOS quits the application rather than
 * closing a window, and a shutdown or log-off ends the session; neither is a
 * close request, so neither asks. The page's `beforeunload` cannot veto a
 * native destroy either.
 */
let asking = false;

/**
 * The native close, turned into the question.
 *
 * Rust holds a close request while the page has said it will ask
 * (`guard_close`), and sends it here as `ul://close-requested`. The decision
 * is there and not in a Tauri `onCloseRequested` listener on purpose: Tauri
 * holds every close while a page listens for one, and a reload — a change of
 * language, F5 — left the old page's listener registered with nobody behind
 * it, so Alt+F4 did nothing at all. Every page load now takes the guard back
 * until the new page sets it again, and a request the page does not
 * acknowledge in three seconds goes through, so a frozen page cannot keep the
 * window open either.
 */
export function guardWindowClose(shell: Shell): () => void {
  if (shell.platform !== 'desktop') return () => {};

  let cancelled = false;
  let stop: (() => void) | undefined;

  void (async () => {
    const [{ listen }, { invoke }] = await Promise.all([native.event(), native.core()]);
    const unlisten = await listen('ul://close-requested', () => {
      void invoke('close_acknowledged');
      void requestExit(shell);
    });
    // The component could have unmounted while the subscription was in flight.
    if (cancelled) {
      unlisten();
      return;
    }
    stop = unlisten;
    await invoke('guard_close', { on: true });
  })();

  return () => {
    cancelled = true;
    stop?.();
  };
}

/**
 * A link to the web opens in the browser, never in place of the application.
 *
 * A link in a Markdown preview was followed by the window itself. On the
 * desktop the whole interface gave way to the page — no address bar to say
 * where it was, unsaved work behind it — and in the browser the tab left the
 * application the same way. The desktop shell now refuses such a navigation
 * outright (`stays_in_app` in Rust), so the click is sent where it belongs
 * instead of doing nothing: `https` to the browser, anything else nowhere.
 * A link an editor handles itself is left to it.
 */
export function routeExternalLinks(shell: Shell): () => void {
  const follow = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button > 1) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    let url: URL;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    if (url.origin === window.location.origin) return;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    event.preventDefault();
    if (url.protocol === 'https:') shell.openExternal?.(url.href);
  };
  document.addEventListener('click', follow);
  document.addEventListener('auxclick', follow);
  return () => {
    document.removeEventListener('click', follow);
    document.removeEventListener('auxclick', follow);
  };
}

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
    /* The question has been answered, so the guard comes down first —
       otherwise `close()` would be held and come back here to ask again. */
    const { invoke } = await native.core();
    await invoke('guard_close', { on: false });
    const { getCurrentWindow } = await native.window();
    await getCurrentWindow().close();
    return;
  }

  /* A browser tab closes only the ones a script opened itself, so this does
     nothing in most cases — which is why Exit is not offered on the web. It is
     here for the tab that was opened by a script and can close. */
  window.close();
}
