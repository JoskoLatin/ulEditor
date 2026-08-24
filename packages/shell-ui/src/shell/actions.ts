/**
 * The actions that tie the file system, the editor registry and the UI state
 * together.
 *
 * Everything the user can trigger — from a menu, the palette or the keyboard —
 * passes through these functions, so there is exactly one place where, say,
 * whether a save is allowed gets decided.
 */

import { hasCapability, type DocumentHandle, type Uri } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { detectByName } from '../host/detect.js';
import { isNarrow } from './narrow.js';
import { forget, rememberFile, rememberFolder } from './recent.js';
import {
  activeTabId,
  tabDocuments,
  tabInstances,
  useWorkspace,
  type TabState,
  type TreeNode,
} from '../state/workspace.js';

let counter = 0;
const nextId = () => `tab-${++counter}`;

/* ── opening ─────────────────────────────────────────────────────────── */

/**
 * On a narrow screen the panel covers the document, so it has to go the moment a
 * selection is made — otherwise the user opens a file and finds themselves
 * looking at the list they opened it from. On desktop the panel stays: there it
 * sits beside the content rather than over it, and the next document is chosen
 * from the same list.
 */
function dismissPanelOnNarrow(): void {
  if (isNarrow()) useWorkspace.getState().setSidebarVisible(false);
}

export async function openDocument(shell: Shell, doc: DocumentHandle): Promise<void> {
  const store = useWorkspace.getState();
  dismissPanelOnNarrow();

  const existing = store.tabs.find((t) => t.uri === doc.uri);
  if (existing) {
    store.activateTab(existing.id);
    return;
  }

  const provider = shell.registry.resolve(doc);
  const id = nextId();

  const tab: Omit<TabState, 'group'> = {
    id,
    uri: doc.uri,
    name: doc.name,
    format: doc.detection.format,
    providerId: provider?.id ?? null,
    dirty: false,
    status: '',
    error: provider ? null : shell.registry.explainMissing(doc),
    readonly: doc.stat.readonly || !provider || !hasCapability(provider, 'edit'),
    ready: false,
  };

  tabDocuments.set(id, doc);
  store.addTab(tab);
  /* Remembered on open rather than on close: a document opened and left open is
     still the last thing worked on, and a crash should not lose that. */
  rememberFile(shell, { uri: doc.uri, name: doc.name });

  if (!provider) return;

  try {
    const instance = await provider.createInstance(shell, doc);
    tabInstances.set(id, instance);

    instance.onDirtyChange((dirty) => useWorkspace.getState().patchTab(id, { dirty }));
    instance.onStatusChange((status) => useWorkspace.getState().patchTab(id, { status }));

    // Only now does the surface know it has something to mount.
    useWorkspace.getState().patchTab(id, { ready: true });
  } catch (err) {
    useWorkspace.getState().patchTab(id, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function openUri(
  shell: Shell,
  uri: Uri,
  opts?: { quiet?: boolean },
): Promise<void> {
  try {
    await openDocument(shell, await shell.fs.open(uri));
  } catch (err) {
    /* The recent list and the session survive a restart; the desktop sandbox
       does not — it starts every launch with no roots at all, so the first
       open of a remembered file is refused. Pointing at the file again is the
       same explicit gesture the file picker makes, so it re-registers the
       file's folder and the open is tried once more. */
    if (shell.fs.adoptPaths) {
      try {
        const [doc] = (await shell.fs.adoptPaths([uri])).documents;
        if (doc) {
          await openDocument(shell, doc);
          return;
        }
        /* Re-adopting found nothing, and the only way it does that quietly is
           the file itself being gone. Said as that, not as a sandbox refusal. */
        err = new Error(t('The file no longer exists.'));
      } catch {
        /* The retry failing leaves the original error standing. */
      }
    }
    /* A file that will not open is dropped from the recent list. Leaving it
       there means an error message on every click, and after two of those the
       list is not trusted again. */
    forget(shell, uri);
    // Restoring a session opens files the user did not just ask for; if one no
    // longer exists, that is not an error worth interrupting startup for.
    if (opts?.quiet) return;
    shell.notify.show('error', t('Could not open the document: {reason}', { reason: describe(err) }));
  }
}

export async function openFiles(shell: Shell): Promise<void> {
  try {
    const docs = await shell.fs.pickFiles({ multiple: true });
    for (const doc of docs) await openDocument(shell, doc);
  } catch (err) {
    if (isAbort(err)) return;
    shell.notify.show('error', t('Could not open the files: {reason}', { reason: describe(err) }));
  }
}

export async function openFolder(shell: Shell): Promise<void> {
  try {
    const root = await shell.fs.pickDirectory();
    if (root) await addRoot(shell, root);
  } catch (err) {
    if (isAbort(err)) return;
    shell.notify.show('error', t('Could not open the folder: {reason}', { reason: describe(err) }));
  }
}

/**
 * Adds a folder as a tree root and reads the first level straight away.
 *
 * The tree is then **shown**, and that is not decoration. A root added while the
 * panel is closed, or while it is showing the library, changes nothing anybody
 * can see — the person clicks their folder, the screen stays exactly as it was,
 * and they conclude the click was ignored. The one exception is the session
 * restore, which passes `reveal: false`: it re-adds every root from last time
 * and must not overrule whichever panel the person left open.
 */
export async function addRoot(
  shell: Shell,
  root: { uri: Uri; name: string },
  opts?: { reveal?: boolean; expanded?: boolean },
): Promise<void> {
  /* The recent list and the session survive a restart; the desktop sandbox
     does not — it starts every launch with no roots at all. A remembered
     folder is therefore handed back to it before it is read. For a folder
     that was just picked or dropped this re-registers a root that is already
     there, which changes nothing. */
  if (shell.fs.adoptPaths) {
    const { directories } = await shell.fs.adoptPaths([root.uri]);
    if (directories.length === 0) throw new Error(t('The folder no longer exists.'));
  }
  const children = await shell.fs.readDirectory(root.uri);
  /* A folder opened by hand unfolds — that is what was asked for. A restored
     one stays shut: several of them all unfolded bury each other, and the
     morning after, the shelf reads better than the spread. The first level is
     read either way, so unfolding one later is a click, not a wait. */
  const node: TreeNode = {
    uri: root.uri,
    name: root.name,
    kind: 'directory',
    depth: 0,
    expanded: opts?.expanded !== false,
    format: 'unknown',
    children: children.map((child) => toNode(child, 1)),
  };

  const { tree, setTree, setSidebarView } = useWorkspace.getState();
  setTree([...tree.filter((n) => n.uri !== node.uri), node]);
  rememberFolder(shell, root);
  if (opts?.reveal !== false) setSidebarView('explorer');
}

/**
 * A folder chosen from the list of recent ones.
 *
 * Separate from `addRoot` because of what happens when it fails. A folder that
 * has been moved or deleted since must leave the list, exactly as a file that
 * will not open does — otherwise every click on it is an error message, and
 * after two of those the list is not trusted again.
 */
export async function openRecentFolder(shell: Shell, root: { uri: Uri; name: string }): Promise<void> {
  try {
    await addRoot(shell, root);
  } catch (err) {
    forget(shell, root.uri);
    shell.notify.show('error', t('Could not open the folder: {reason}', { reason: describe(err) }));
  }
}

/**
 * A drop onto the window. The web gives `File` objects, desktop gives paths — the
 * difference lives here, not in the component that catches the event.
 *
 * A dropped folder becomes a tree root, a dropped file becomes a tab.
 */
export async function adoptDropped(
  shell: Shell,
  payload: { files?: FileList | File[]; paths?: string[] },
): Promise<void> {
  try {
    if (payload.paths?.length && shell.fs.adoptPaths) {
      const { documents, directories } = await shell.fs.adoptPaths(payload.paths);
      for (const dir of directories) await addRoot(shell, dir);
      for (const doc of documents) await openDocument(shell, doc);
      return;
    }

    if (payload.files && shell.fs.adoptFiles) {
      for (const doc of await shell.fs.adoptFiles(payload.files)) {
        await openDocument(shell, doc);
      }
    }
  } catch (err) {
    shell.notify.show(
      'error',
      t('Could not open what was dropped: {reason}', { reason: describe(err) }),
    );
  }
}

function toNode(entry: { uri: Uri; name: string; kind: 'file' | 'directory' }, depth: number): TreeNode {
  return {
    uri: entry.uri,
    name: entry.name,
    kind: entry.kind,
    depth,
    expanded: false,
    children: null,
    format: entry.kind === 'directory' ? 'unknown' : detectByName(entry.name).format,
  };
}

/** Directories are read only when first expanded — a repository with thousands
 *  of files would otherwise block the UI for seconds. */
export async function toggleDirectory(shell: Shell, node: TreeNode): Promise<void> {
  const { updateNode } = useWorkspace.getState();

  if (node.expanded) {
    updateNode(node.uri, { expanded: false });
    return;
  }

  if (node.children) {
    updateNode(node.uri, { expanded: true });
    return;
  }

  try {
    const entries = await shell.fs.readDirectory(node.uri);
    updateNode(node.uri, {
      expanded: true,
      children: entries.map((entry) => toNode(entry, node.depth + 1)),
    });
  } catch (err) {
    shell.notify.show('error', t('Could not read the folder: {reason}', { reason: describe(err) }));
  }
}

/* ── closing ─────────────────────────────────────────────────────────── */

export async function closeTab(shell: Shell, id: string): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id);
  if (!tab) return;

  if (tab.dirty) {
    const answer = await confirmDiscard(shell, tab);
    if (answer === 'cancel') return;
    if (answer === 'save') {
      const saved = await saveTab(shell, id);
      if (!saved) return;
    }
  }

  tabInstances.get(id)?.unmount();
  tabInstances.delete(id);
  tabDocuments.delete(id);
  useWorkspace.getState().closeTab(id);
}

function confirmDiscard(shell: Shell, tab: TabState): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const handle = shell.notify.show(
      'warning',
      t('{name} has unsaved changes.', { name: tab.name }),
      [
        { label: t('Cancel'), run: () => (handle.dispose(), resolve('cancel')) },
        { label: t('Discard'), run: () => (handle.dispose(), resolve('discard')) },
        { label: t('Save'), run: () => (handle.dispose(), resolve('save')) },
      ],
    );
  });
}

/* ── saving ──────────────────────────────────────────────────────────── */

export async function saveTab(shell: Shell, id: string): Promise<boolean> {
  const state = useWorkspace.getState();
  const tab = state.tabs.find((t) => t.id === id);
  const instance = tabInstances.get(id);
  if (!tab || !instance) return false;

  if (tab.readonly) {
    shell.notify.show('warning', t('{name} is open read-only.', { name: tab.name }));
    return false;
  }

  try {
    const result = await instance.save();

    // The editor reported it cannot reproduce everything from the original. We
    // ask the user BEFORE the change becomes permanent — never silently.
    if (result.lostFidelity.length > 0) {
      const answer = await shell.notify.fidelityWarning(tab.uri, result.lostFidelity);
      if (answer === 'cancel') return false;
    }

    /* A save that could not write back into its own file wrote a new one —
       the old `.xls` converted to `.xlsx`. The tab follows it: it is the file
       the next save goes to, and a tab still named after the original would
       send the person looking for their changes in the wrong document. */
    if (result.uri !== tab.uri) {
      const name = result.uri.split(/[\\/]/).pop() ?? result.uri;
      useWorkspace.getState().patchTab(id, { uri: result.uri, name });
      rememberFile(shell, { uri: result.uri, name });
      shell.notify.show('info', t('Saved as {name}', { name }));
      return true;
    }

    shell.notify.show('info', t('Saved: {name}', { name: tab.name }));
    return true;
  } catch (err) {
    // The person closed the "where to" dialog; that is not a failure to report.
    if (isAbort(err)) return false;
    shell.notify.show('error', t('Save failed: {reason}', { reason: describe(err) }));
    return false;
  }
}

export async function saveActive(shell: Shell): Promise<void> {
  const id = activeTabId();
  if (id) await saveTab(shell, id);
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
