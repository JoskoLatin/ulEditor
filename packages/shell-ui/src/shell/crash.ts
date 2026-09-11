/**
 * What is written down when the program breaks, and what is deliberately not.
 *
 * **Nothing here reaches the network.** There is no endpoint, no key, no queue
 * and no consent dialog to get wrong, because there is nothing to consent to: a
 * crash report is a text file on the person's own disk, in a program whose whole
 * job is opening text files. If they want somebody to see it, they send it, the
 * way they would send any other file. That is the same answer the updater
 * reached — *"it needed no certificate and no backend: the release page is the
 * backend"* — arrived at from the other direction.
 *
 * **It is quiet.** No toast, and that is a measured decision rather than a
 * modest one. Of the failures that actually happen here, the ones a person
 * notices are already handled — a damaged `.docx` says so in the editor area
 * with its own panel — and the ones that are not handled are either invisible
 * and harmless (a click that did nothing) or fatal, and a fatal one takes the
 * toast with it: the notification list is a child of the same React root that
 * unmounts, and a Rust panic ends the process outright because this program is
 * built with `panic = "abort"`. A toast is therefore either noise or a message
 * to a window that no longer exists. What replaces it is the boundary panel,
 * which is the only thing still rendering, and a line at the next start.
 *
 * **What it must never do is make things worse.** A handler that reports its own
 * failure to report is a loop: measured in this engine, an `unhandledrejection`
 * that re-enters its own listener runs twenty thousand times a second. So the
 * write is fire-and-forget with the rejection swallowed, and there is a hard
 * ceiling per session — after it, the console and nothing else.
 */

import { invoke } from '@tauri-apps/api/core';

import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { adoptDropped } from './actions.js';

/**
 * How many reports one session may write.
 *
 * Not a tidiness rule. The tenth report of the same fault says nothing the first
 * did not, and the thousandth is a program spending its life writing about
 * itself.
 */
const MOST = 5;
let written = 0;

/**
 * Everything a report is built from — chosen fields, not whatever was to hand.
 *
 * `format` is the tab's own `FormatId`, a closed vocabulary the registry
 * defines. It is deliberately **not** the file's extension: the repository's own
 * `extensionOf` is "everything after the last dot", which for a document called
 * `Ponuda za Kliniku dr. Novak` returns ` novak` — a surname, in the field whose
 * entire purpose was to avoid one.
 */
export interface CrashContext {
  where: string;
  /* Both accept `null` because that is how the tab holds them, and a report
     that made the caller normalise first would be a report nobody wrote. */
  format?: string | null;
  providerId?: string | null;
  componentStack?: string | null;
}

/**
 * A path, a share, or a `file://` URL, replaced by its last part.
 *
 * This is a **net, not a guarantee**, and the difference is worth stating
 * plainly rather than promising the absolutist version. Some things it cannot
 * catch: a bare file name is not path-shaped, and this program has messages that
 * carry one — *"{name} could not be read: {reason}"* is real code. The report is
 * a file the person can read before they send it, and that, not the regex, is
 * what makes it safe.
 *
 * The awkward part is the space, and it is not a corner case: real folders are
 * called `Moji dokumenti` and `Program Files`. A rule that stops at the first
 * space leaves the folder behind — measured, `C:\Users\joško\Moji
 * dokumenti\ugovor.docx` came back as `…/Moji dokumenti\ugovor.docx`, which is
 * most of what was supposed to go. A rule that simply allows spaces swallows the
 * sentence instead: *"copy C:\a\b.txt to D:\c\d.txt failed"* becomes one match
 * and the message is gone with it.
 *
 * So a space is taken **only when what follows it is still a path** — when there
 * is another separator ahead before the next gap. `Program Files` stays
 * together; `to` and `failed` are left alone.
 */
/*
 * The lookbehind is not decoration. Without it the `e:` in `file:` is a drive
 * letter, and every stack frame came back as `fil…/EditorSurface.tsx` — safe,
 * and two characters short of readable.
 */
const PATH =
  /(?:(?<![A-Za-z])[A-Za-z]:|\\\\[^\s\\/]+)[\\/](?:[^\s"'<>|?*\n]| (?=[^\s"'<>|?*\n]*[\\/]))*/g;

/** A home directory on anything but Windows — the browser build, and any port. */
const POSIX_HOME = /\/(?:home|Users)\/(?:[^\s"'<>|?*\n]| (?=[^\s"'<>|?*\n]*\/))*/g;

export function scrub(text: string): string {
  return text.replace(PATH, (hit) => `…${tail(hit)}`).replace(POSIX_HOME, (hit) => `…${tail(hit)}`);
}

/** The last segment of a path — enough to recognise, not enough to locate. */
function tail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? `/${parts[parts.length - 1]}` : '';
}

function describe(error: unknown, context: CrashContext): string {
  const when = new Date().toISOString();
  const lines = [
    `ulEditor — something went wrong`,
    `when:     ${when}`,
    `where:    ${context.where}`,
  ];
  if (context.format) lines.push(`format:   ${context.format}`);
  if (context.providerId) lines.push(`editor:   ${context.providerId}`);

  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  lines.push('', `${name}: ${scrub(message)}`);

  if (error instanceof Error && error.stack) lines.push('', scrub(error.stack));
  if (context.componentStack) lines.push('', 'components:', scrub(context.componentStack));

  return `${lines.join('\n')}\n`;
}

/**
 * Writes one report, and never throws — including when the writing fails.
 *
 * The `catch` is not defensive habit. Without it a failed write rejects, that
 * rejection is itself unhandled, and it arrives back at the very listener that
 * called this — which is how a full disk turns into a locked window rather than
 * a missing file.
 */
export function record(error: unknown, context: CrashContext): void {
  /* An aborted operation is not a crash. A Save As the person cancelled rejects
     with an `AbortError`, and it reaches the same listener a real fault does. */
  if (error instanceof DOMException && error.name === 'AbortError') return;

  const text = describe(error, context);
  // The house form, so it reads like the rest of the program's output.
  console.error(`[uleditor] ${context.where}:`, error);

  if (written >= MOST) return;
  written++;

  try {
    void invoke('record_crash', { text }).catch(() => {
      /* Nowhere to write and nothing to say about it. The console line above
         already happened, and it is the only report a browser build ever had. */
    });
  } catch {
    // No Tauri here — the browser build. The console line stands on its own.
  }
}

/**
 * Listens for what nothing else caught.
 *
 * These two events are the only channel for a whole class of failure that is
 * invisible today: a command that throws from a button with no `.catch`, a
 * `mount()` that rejects, a listener that throws. Measured, every one of those
 * leaves the shell alive, shows nothing, and writes nothing anywhere.
 */
export function watchForCrashes(): void {
  window.addEventListener('error', (event) => {
    /*
     * Nothing was thrown, so nothing crashed.
     *
     * A browser reports more than exceptions on this channel, and the one that
     * matters here is `ResizeObserver loop completed with undelivered
     * notifications` — a layout that settled over two frames instead of one,
     * which the reading view's paging does as a matter of course. Measured, it
     * arrives with `error: null` and line 0, once per round, and a real throw
     * arrives with the thrown object. The first version of this listener fell
     * back to the message, and so turned a paging layout into a crash: a
     * console error the reading check failed on, and — worse — a report on
     * disk and, at the next start, a tab announcing that ulEditor had stopped
     * unexpectedly five times, when it had stopped no times at all. The other
     * thing that arrives without an object is a script from another origin,
     * muted to "Script error." with no place and no message, which is nothing
     * a fix could be made from either.
     */
    if (event.error === null || event.error === undefined) return;
    record(event.error, { where: 'window' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    record(event.reason, { where: 'a promise nobody was waiting on' });
  });
}

/**
 * Tells the person, once, that the last run ended badly — and shows them the file.
 *
 * This is the delivery, and it is deliberately not a toast. The three failures
 * that are actually crashes all take the toast with them: a React render or
 * effect that throws unmounts the root the notification list lives in, and a
 * Rust panic ends the process outright. A message can only be given to a window
 * that still exists, which means the next one.
 *
 * The report opens **as a tab**, through the same path a double-clicked file
 * takes. This program is a text editor; handing somebody a folder so they can
 * find a `.txt` and open it somewhere else would be walking them out of the
 * program to read something the program wrote. And the notice sits beside
 * *Help ▸ Report a problem*, which is what they were going to do next.
 */
export function watchForPastCrashes(shell: Shell): void {
  if (shell.platform !== 'desktop') return;

  void (async () => {
    try {
      const reports = await invoke<string[]>('take_crash_reports');
      if (!Array.isArray(reports) || reports.length === 0) return;

      await adoptDropped(shell, { paths: reports });
      shell.notify.show(
        'warning',
        reports.length === 1
          ? t('ulEditor stopped unexpectedly last time. The report is open in a tab.')
          : t('ulEditor stopped unexpectedly {n} times. The reports are open in tabs.', {
              n: reports.length,
            }),
      );
    } catch {
      /* An older core with no such command, or a folder that cannot be read.
         Announcing a failure to announce a failure helps nobody. */
    }
  })();
}
