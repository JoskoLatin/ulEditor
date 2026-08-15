/**
 * Radnje koje spajaju datotečni sustav, registar editora i stanje UI-a.
 *
 * Sve što korisnik može pokrenuti — iz izbornika, palete ili tipkovnicom —
 * prolazi kroz ove funkcije, pa postoji točno jedno mjesto gdje se npr.
 * odlučuje smije li se spremiti.
 */

import { hasCapability, type DocumentHandle, type Uri } from '@uleditor/plugin-sdk';

import type { Shell } from '../host/index.js';
import { detectByName } from '../host/detect.js';
import {
  tabDocuments,
  tabInstances,
  useWorkspace,
  type TabState,
  type TreeNode,
} from '../state/workspace.js';

let counter = 0;
const nextId = () => `tab-${++counter}`;

/* ── otvaranje ───────────────────────────────────────────────────────── */

export async function openDocument(shell: Shell, doc: DocumentHandle): Promise<void> {
  const store = useWorkspace.getState();

  const existing = store.tabs.find((t) => t.uri === doc.uri);
  if (existing) {
    store.activateTab(existing.id);
    return;
  }

  const provider = shell.registry.resolve(doc);
  const id = nextId();

  const tab: TabState = {
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

  if (!provider) return;

  try {
    const instance = await provider.createInstance(shell, doc);
    tabInstances.set(id, instance);

    instance.onDirtyChange((dirty) => useWorkspace.getState().patchTab(id, { dirty }));
    instance.onStatusChange((status) => useWorkspace.getState().patchTab(id, { status }));

    // Tek sada površina zna da ima što montirati.
    useWorkspace.getState().patchTab(id, { ready: true });
  } catch (err) {
    useWorkspace.getState().patchTab(id, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function openUri(shell: Shell, uri: Uri): Promise<void> {
  try {
    await openDocument(shell, await shell.fs.open(uri));
  } catch (err) {
    shell.notify.show('error', `Otvaranje nije uspjelo: ${describe(err)}`);
  }
}

export async function openFiles(shell: Shell): Promise<void> {
  try {
    const docs = await shell.fs.pickFiles({ multiple: true });
    for (const doc of docs) await openDocument(shell, doc);
  } catch (err) {
    if (isAbort(err)) return;
    shell.notify.show('error', `Otvaranje datoteka nije uspjelo: ${describe(err)}`);
  }
}

export async function openFolder(shell: Shell): Promise<void> {
  try {
    const root = await shell.fs.pickDirectory();
    if (!root) return;

    const children = await shell.fs.readDirectory(root.uri);
    const node: TreeNode = {
      uri: root.uri,
      name: root.name,
      kind: 'directory',
      depth: 0,
      expanded: true,
      format: 'unknown',
      children: children.map((child) => toNode(child, 1)),
    };

    const { tree, setTree } = useWorkspace.getState();
    setTree([...tree.filter((n) => n.uri !== node.uri), node]);
  } catch (err) {
    if (isAbort(err)) return;
    shell.notify.show('error', `Otvaranje mape nije uspjelo: ${describe(err)}`);
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

/** Direktoriji se čitaju tek pri prvom otvaranju — repo s tisućama datoteka
 *  inače blokira UI na sekunde. */
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
    shell.notify.show('error', `Čitanje mape nije uspjelo: ${describe(err)}`);
  }
}

/* ── zatvaranje ──────────────────────────────────────────────────────── */

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
    const handle = shell.notify.show('warning', `${tab.name} ima nespremljene promjene.`, [
      { label: 'Odustani', run: () => (handle.dispose(), resolve('cancel')) },
      { label: 'Odbaci', run: () => (handle.dispose(), resolve('discard')) },
      { label: 'Spremi', run: () => (handle.dispose(), resolve('save')) },
    ]);
  });
}

/* ── spremanje ───────────────────────────────────────────────────────── */

export async function saveTab(shell: Shell, id: string): Promise<boolean> {
  const state = useWorkspace.getState();
  const tab = state.tabs.find((t) => t.id === id);
  const instance = tabInstances.get(id);
  if (!tab || !instance) return false;

  if (tab.readonly) {
    shell.notify.show('warning', `${tab.name} je otvorena samo za čitanje.`);
    return false;
  }

  try {
    const result = await instance.save();

    // Editor je prijavio da ne može reproducirati sve iz originala. Pitamo
    // korisnika PRIJE nego promjena postane trajna — nikad tiho.
    if (result.lostFidelity.length > 0) {
      const answer = await shell.notify.fidelityWarning(tab.uri, result.lostFidelity);
      if (answer === 'cancel') return false;
    }

    shell.notify.show('info', `Spremljeno: ${tab.name}`);
    return true;
  } catch (err) {
    shell.notify.show('error', `Spremanje nije uspjelo: ${describe(err)}`);
    return false;
  }
}

export async function saveActive(shell: Shell): Promise<void> {
  const id = useWorkspace.getState().activeTabId;
  if (id) await saveTab(shell, id);
}

/* ── pomoćno ─────────────────────────────────────────────────────────── */

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
