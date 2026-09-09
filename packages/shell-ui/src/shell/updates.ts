/**
 * Looking for a new version, and installing one.
 *
 * **Why this is safe to have at all.** "Download an executable from the internet
 * and run it" is the shape of the worst thing a program can do to somebody. What
 * makes it a feature rather than a hole is the signature: every artefact is
 * signed at build time with a minisign key whose private half never leaves
 * GitHub Secrets, and the public half is compiled into the application. An
 * update that does not verify against it is refused before a single byte of it
 * is executed — a hijacked release page, a proxy rewriting the download, a DNS
 * answer from somewhere else, all of them end the same way.
 *
 * **What it sends.** A GET for one static JSON file, and then, only if the person
 * says yes, a GET for one installer. No identifier, no telemetry, nothing about
 * the documents open. The version being run is not sent either: the comparison
 * happens here, on what came back.
 *
 * **Why it is opt-out rather than automatic.** The check on start is on, because
 * a fix nobody hears about is a fix nobody has — but it is a checkable row in
 * the Help menu, and an editor that quietly phones anywhere on every launch
 * should at least admit it in the menu where it can be switched off.
 */

import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';

/** How often the check on start actually checks. */
const EVERY = 24 * 60 * 60 * 1000;

const CHECK_ON_START = 'updates.checkOnStart';
const LAST_CHECK = 'updates.lastCheck';

/** What the plugin gives back, narrowed to what is used here. */
interface Available {
  version: string;
  currentVersion: string;
  downloadAndInstall(onEvent?: (event: { event: string; data?: unknown }) => void): Promise<void>;
}

/**
 * What is running, if anything.
 *
 * Two flags rather than one, and the difference is the whole reason this
 * comment exists. A single "busy" made the menu item do **nothing at all** when
 * it was pressed while the quiet check on start was still in flight: the
 * request went out, the guard turned the person's own request away, and not one
 * word appeared on the screen. A menu row that answers nothing is
 * indistinguishable from a broken one, and it was found by a check that waited
 * a minute for a sentence that never came.
 *
 * So: a person's request always runs and always answers. Only a second click
 * while their first is still going is turned away, and the quiet one steps
 * aside for anything already in progress.
 */
let asked = false;
let quiet = false;

export function checksOnStart(shell: Shell): boolean {
  return shell.settings.get<boolean>(CHECK_ON_START, true);
}

export function setChecksOnStart(shell: Shell, value: boolean): void {
  shell.settings.set(CHECK_ON_START, value);
}

/** Whether this build can update itself at all. */
export function canUpdate(shell: Shell): boolean {
  return shell.platform === 'desktop';
}

/**
 * The check on start.
 *
 * Silent by design — it speaks only when there is something to say. Once a day
 * is often enough for a program that is not a browser, and the timestamp is
 * remembered so that opening five documents in a morning is still one request.
 */
export async function checkOnStart(shell: Shell): Promise<void> {
  if (!canUpdate(shell) || !checksOnStart(shell)) return;

  const last = shell.settings.get<number>(LAST_CHECK, 0);
  if (Number.isFinite(last) && Date.now() - last < EVERY) return;

  await checkForUpdates(shell, { silent: true });
}

/**
 * The check a person asked for.
 *
 * `silent` is the whole difference between the two callers: the one on start
 * must not report "you are up to date" to somebody who did not ask, and must
 * not report a failure either — a laptop that opened the program on a train has
 * no network and has done nothing wrong.
 */
export async function checkForUpdates(shell: Shell, options: { silent?: boolean } = {}): Promise<void> {
  const silent = options.silent ?? false;
  if (!canUpdate(shell)) {
    if (!silent) {
      shell.notify.show('info', t('This build cannot update itself — it updates where it was installed from.'));
    }
    return;
  }
  if (silent ? asked || quiet : asked) return;
  if (silent) quiet = true;
  else asked = true;

  const checking = silent
    ? null
    : shell.notify.show('info', t('Looking for a new version…'));

  try {
    /* A dynamic import, like every other Tauri API here: the web build must not
       pull the plugin into its bundle, and it would fail at load rather than at
       use if it did. */
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = (await check()) as Available | null;
    shell.settings.set(LAST_CHECK, Date.now());
    checking?.dispose();

    if (!update) {
      if (!silent) {
        shell.notify.show('info', t('ulEditor {version} is the newest version.', { version: __APP_VERSION__ }));
      }
      return;
    }

    offer(shell, update);
  } catch (err) {
    checking?.dispose();
    if (!silent) {
      shell.notify.show(
        'error',
        t('The check for updates failed: {reason}', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  } finally {
    if (silent) quiet = false;
    else asked = false;
  }
}

/**
 * The offer, and the install if it is taken.
 *
 * Sticky, because this is a question rather than a notice, and a question that
 * disappears after four seconds is a question asked of nobody.
 */
function offer(shell: Shell, update: Available): void {
  const notice = shell.notify.show(
    'info',
    t('Version {version} is available. This one is {current}.', {
      version: update.version,
      current: update.currentVersion,
    }),
    [
      {
        label: t('Not now'),
        run: () => notice.dispose(),
      },
      {
        label: t('Install and restart'),
        run: () => {
          notice.dispose();
          void install(shell, update);
        },
      },
    ],
  );
}

async function install(shell: Shell, update: Available): Promise<void> {
  /* One notice for the whole download, replaced rather than added to: a toast
     per percent would bury everything else on the screen. */
  let progress = shell.notify.show('info', t('Downloading {version}…', { version: update.version }));
  let total = 0;
  let taken = 0;

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        const data = event.data as { contentLength?: number } | undefined;
        total = data?.contentLength ?? 0;
        return;
      }
      if (event.event !== 'Progress') return;

      const data = event.data as { chunkLength?: number } | undefined;
      taken += data?.chunkLength ?? 0;
      if (total <= 0) return;

      const percent = Math.min(100, Math.round((taken / total) * 100));
      progress.dispose();
      progress = shell.notify.show(
        'info',
        t('Downloading {version}… {percent}%', { version: update.version, percent }),
      );
    });

    progress.dispose();

    /* Windows hands over to the installer, which closes the program itself; on
       macOS and Linux the new files are already in place and only a restart is
       missing. Asking for one either way is harmless, and being wrong about
       which platform does what would leave somebody looking at a version that
       has already been replaced underneath them. */
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    progress.dispose();
    shell.notify.show(
      'error',
      t('The update could not be installed: {reason}', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
