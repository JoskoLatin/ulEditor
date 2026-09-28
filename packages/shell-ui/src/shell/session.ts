/**
 * Session restore.
 *
 * A program that opens empty after you closed a window with twelve tabs is a demo,
 * not a tool. The tree roots, the open tabs and which one was active are
 * remembered.
 *
 * **On the web, only the folders.** There a `Uri` is a key to a
 * `FileSystemHandle` valid within one visit. The folders' handles are kept in
 * IndexedDB by the host (ADR 0002, step 8), and one the browser still allows
 * comes back as it does on desktop. One it would ask about again is offered
 * with a button instead, and the browser asks only when that is pressed: the
 * program never opens with permission dialogs. Tabs are not restored there —
 * each would be one more handle to keep and to ask about.
 */

import type { Uri } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { selectActiveTabId, useWorkspace, type GroupId } from '../state/workspace.js';
import { addRoot, openRecentFolder, openUri } from './actions.js';

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
  if (shell.platform !== 'desktop') return restoreWebFolders(shell);

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

/**
 * The web's restore: the folders open at the last visit. Those the browser
 * still allows come back shut and without changing the panel, as on desktop.
 * For each one it would ask about, a notice with a button; the browser's own
 * question comes only from that click, and the folder then opens as if picked.
 */
async function restoreWebFolders(shell: Shell): Promise<void> {
  const restored = await shell.fs.restoreRoots?.();
  if (!restored) return;
  for (const root of restored.ready) {
    try {
      await addRoot(shell, root, { reveal: false, expanded: false });
    } catch {
      // Still allowed, but gone since: forgotten without a fuss.
      void shell.fs.forgetRoot?.(root.uri);
    }
  }
  for (const root of restored.waiting) {
    const notice = shell.notify.show(
      'info',
      t('{name} was open last time. The browser asks before the program may read it again.', { name: root.name }),
      [
        {
          label: t('Open {name} again', { name: root.name }),
          run: async () => {
            const entry = await root.grant();
            notice.dispose();
            if (entry) await openRecentFolder(shell, entry);
          },
        },
        {
          /* Without this, the only way to be rid of a folder nobody wants
             back is the browser's prompt — and ignoring the notice would keep
             the folder's handle on the origin for good. */
          label: t('Forget {name}', { name: root.name }),
          run: async () => {
            notice.dispose();
            await shell.fs.forgetRoot?.(root.uri);
          },
        },
      ],
    );
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
