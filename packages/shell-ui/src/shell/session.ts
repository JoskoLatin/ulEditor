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
import { selectActiveTabId, useWorkspace, type GroupId } from '../state/workspace.js';
import { addRoot, openUri } from './actions.js';

const KEY = 'session.workspace';
/** Above this, restoring takes longer than anyone wants to wait for startup. */
const MAX_TABS = 24;

/**
 * What a stored session holds.
 *
 * `tabs` used to be a plain list of URIs and old settings still contain that
 * shape, so it is read either way — a person who updates the program should not
 * lose the session they had open when they did.
 */
interface StoredSession {
  roots: Uri[];
  tabs: Array<Uri | { uri: Uri; group: GroupId }>;
  active: Uri | null;
  /** The document in front of the second group, when there was one. */
  activeRight?: Uri | null;
}

export function saveSession(shell: Shell): void {
  if (shell.platform !== 'desktop') return;

  const state = useWorkspace.getState();
  const { tree, tabs } = state;
  const uriOf = (id: string | null) => tabs.find((tab) => tab.id === id)?.uri ?? null;
  const session: StoredSession = {
    roots: tree.map((node) => node.uri),
    tabs: tabs.slice(0, MAX_TABS).map((tab) => ({ uri: tab.uri, group: tab.group })),
    active: uriOf(selectActiveTabId(state)),
    activeRight: uriOf(state.active.right),
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

  /* The folders come back collapsed: the person did not just ask for any of
     them, and a morning tree of roots reads better as a shelf than as last
     night's spread. Expanding one is a click — the first level is already read. */
  for (const uri of session.roots ?? []) {
    try {
      await addRoot(shell, { uri, name: baseName(uri) }, { reveal: false, expanded: false });
    } catch {
      // The folder no longer exists.
    }
  }

  /*
   * Everything is opened into the left group first and moved afterwards. Opening
   * straight into the right one would create a split with an empty left half for
   * as long as the restore takes, and the store collapses exactly that — so the
   * arrangement would be undone while it was still being built.
   */
  const entries = (session.tabs ?? []).slice(0, MAX_TABS).map((entry) =>
    typeof entry === 'string' ? { uri: entry, group: 'left' as GroupId } : entry,
  );

  for (const entry of entries) {
    try {
      await openUri(shell, entry.uri, { quiet: true });
    } catch {
      // The file no longer exists.
    }
  }

  const store = useWorkspace.getState();
  const byUri = (uri: Uri | null | undefined) =>
    uri ? store.tabs.find((tab) => tab.uri === uri) : undefined;

  for (const entry of entries) {
    if (entry.group !== 'right') continue;
    const tab = byUri(entry.uri);
    if (tab) useWorkspace.getState().moveTabToOtherGroup(tab.id);
  }

  // The right one first, so the left is what ends up with the focus — which is
  // where it was when the window closed, unless the session says otherwise.
  const right = byUri(session.activeRight);
  if (right) useWorkspace.getState().activateTab(right.id);
  const active = byUri(session.active);
  if (active) useWorkspace.getState().activateTab(active.id);
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
