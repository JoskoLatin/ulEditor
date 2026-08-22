/**
 * What was open before.
 *
 * The session already brings back the tabs of the last run, which covers
 * "carry on where I left off". It does not cover "that contract I had open on
 * Tuesday" — once a tab is closed, the only way back is the file dialog and
 * remembering where the thing lives. That is the gap this fills.
 *
 * **Desktop only**, and for the same reason the session restore is: on the web a
 * `Uri` is a key to a `FileSystemHandle` that is valid inside one visit. A list
 * of them written to storage would look like history and reopen nothing, which
 * is worse than not offering it.
 *
 * Nothing here is a cache of content — only a path, a name and when it was last
 * opened. Kept in settings beside everything else, so it travels with the rest
 * of the preferences and is removed with them.
 */

import type { Uri } from '@uleditor/plugin-sdk';

import type { Shell } from '../host/index.js';

export interface RecentEntry {
  uri: Uri;
  name: string;
  /** Unix ms, last opened. */
  at: number;
}

/**
 * Enough to be useful, short enough to read at a glance. A list that scrolls is
 * a list nobody scans — past about a dozen the file dialog is faster, and the
 * point of this is to be faster than the file dialog.
 */
const LIMITS = { 'recent.files': 12, 'recent.folders': 8 } as const;
type Key = keyof typeof LIMITS;

function read(shell: Shell, key: Key): RecentEntry[] {
  const stored = shell.settings.get<RecentEntry[]>(key, []);
  if (!Array.isArray(stored)) return [];
  /* Settings survive an upgrade and are editable by hand, so what comes back is
     not necessarily what was written. */
  return stored.filter(
    (entry): entry is RecentEntry =>
      !!entry && typeof entry.uri === 'string' && typeof entry.name === 'string',
  );
}

function remember(shell: Shell, key: Key, entry: { uri: Uri; name: string }): void {
  if (shell.platform !== 'desktop') return;
  const now = Date.now();
  /* The same file opened again moves to the front rather than appearing twice —
     matched on the uri, because the name is not unique and two `notes.md` in
     different folders are two different files. */
  const rest = read(shell, key).filter((e) => e.uri !== entry.uri);
  shell.settings.set(key, [{ ...entry, at: now }, ...rest].slice(0, LIMITS[key]));
}

export function rememberFile(shell: Shell, entry: { uri: Uri; name: string }): void {
  remember(shell, 'recent.files', entry);
}

export function rememberFolder(shell: Shell, entry: { uri: Uri; name: string }): void {
  remember(shell, 'recent.folders', entry);
}

export function recentFiles(shell: Shell): RecentEntry[] {
  return shell.platform === 'desktop' ? read(shell, 'recent.files') : [];
}

export function recentFolders(shell: Shell): RecentEntry[] {
  return shell.platform === 'desktop' ? read(shell, 'recent.folders') : [];
}

/**
 * Drops one entry, for when opening it failed.
 *
 * A list of things that no longer exist is worse than a short list: every click
 * on a moved file is an error message, and after two of those nobody trusts the
 * list again. So a failure to open removes the entry rather than reporting and
 * leaving it there.
 */
export function forget(shell: Shell, uri: Uri): void {
  for (const key of Object.keys(LIMITS) as Key[]) {
    const kept = read(shell, key).filter((entry) => entry.uri !== uri);
    shell.settings.set(key, kept);
  }
}

export function clearRecent(shell: Shell): void {
  for (const key of Object.keys(LIMITS) as Key[]) shell.settings.set(key, []);
}

/** Whether there is anything to show at all — the section is hidden otherwise. */
export function hasRecent(shell: Shell): boolean {
  return recentFiles(shell).length > 0 || recentFolders(shell).length > 0;
}
