/**
 * Session restore.
 *
 * A program that opens empty after you closed a window with twelve tabs is a demo,
 * not a tool. The tree roots, the open tabs and which one was active are
 * remembered.
 *
 * **Desktop only.** On the web a `Uri` is a key to a `FileSystemHandle` valid
 * within one session; reviving it requires IndexedDB and a fresh permission
 * prompt on every start. We would rather restore nothing than have the program
 * open with permission dialogs.
 */

import type { Uri } from '@uleditor/plugin-sdk';

import type { Shell } from '../host/index.js';
import { useWorkspace } from '../state/workspace.js';
import { addRoot, openUri } from './actions.js';

const KEY = 'session.workspace';
/** Above this, restoring takes longer than anyone wants to wait for startup. */
const MAX_TABS = 24;

interface StoredSession {
  roots: Uri[];
  tabs: Uri[];
  active: Uri | null;
}

export function saveSession(shell: Shell): void {
  if (shell.platform !== 'desktop') return;

  const { tree, tabs, activeTabId } = useWorkspace.getState();
  const session: StoredSession = {
    roots: tree.map((node) => node.uri),
    tabs: tabs.slice(0, MAX_TABS).map((tab) => tab.uri),
    active: tabs.find((tab) => tab.id === activeTabId)?.uri ?? null,
  };
  shell.settings.set(KEY, session);
}

/**
 * Restores the previous session. Files deleted or moved in the meantime are
 * skipped without a fuss — a session restore must not bury the user in errors for
 * something they did not ask for.
 */
export async function restoreSession(shell: Shell): Promise<void> {
  if (shell.platform !== 'desktop') return;

  const session = shell.settings.get<StoredSession | null>(KEY, null);
  if (!session) return;

  for (const uri of session.roots ?? []) {
    try {
      await addRoot(shell, { uri, name: baseName(uri) });
    } catch {
      // The folder no longer exists.
    }
  }

  for (const uri of (session.tabs ?? []).slice(0, MAX_TABS)) {
    try {
      await openUri(shell, uri, { quiet: true });
    } catch {
      // The file no longer exists.
    }
  }

  if (session.active) {
    const tab = useWorkspace.getState().tabs.find((t) => t.uri === session.active);
    if (tab) useWorkspace.getState().activateTab(tab.id);
  }
}

/** Watches for changes and saves them with a delay — not every click in the tree needs a write. */
export function watchSession(shell: Shell): () => void {
  if (shell.platform !== 'desktop') return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveSession(shell), 400);
  };

  const unsubscribe = useWorkspace.subscribe(schedule);
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

function baseName(uri: Uri): string {
  const parts = uri.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? uri;
}
