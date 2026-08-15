/**
 * Stanje radnog prostora: stablo, tabovi, ploče.
 *
 * Imperativni objekti (DocumentHandle, EditorInstance) namjerno NISU u
 * storeu — drže se u zasebnim mapama. Store sadrži samo ono što UI
 * uspoređuje pri renderu, pa promjena kursora u editoru ne izaziva
 * ponovni render cijelog stabla.
 */

import { create } from 'zustand';
import type { DocumentHandle, EditorInstance, FormatId, Uri } from '@uleditor/plugin-sdk';

export interface TreeNode {
  uri: Uri;
  name: string;
  kind: 'file' | 'directory';
  depth: number;
  /** `null` dok direktorij nije pročitan — učitava se lijeno na prvo otvaranje. */
  children: TreeNode[] | null;
  expanded: boolean;
  format: FormatId;
}

export interface TabState {
  id: string;
  uri: Uri;
  name: string;
  format: FormatId;
  providerId: string | null;
  dirty: boolean;
  /** Tekst za statusnu traku koji editor sam objavljuje. */
  status: string;
  /** Poruka kad dokument nije moguće otvoriti. */
  error: string | null;
  readonly: boolean;
  /** Instanca editora je stvorena i čeka montažu u DOM. */
  ready: boolean;
}

export type SidebarView = 'explorer' | 'formats';

interface WorkspaceState {
  tree: TreeNode[];
  tabs: TabState[];
  activeTabId: string | null;

  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarView: SidebarView;
  paletteOpen: boolean;
  findOpen: boolean;
  preferencesOpen: boolean;

  setTree(tree: TreeNode[]): void;
  updateNode(uri: Uri, patch: Partial<TreeNode>): void;

  addTab(tab: TabState): void;
  closeTab(id: string): void;
  activateTab(id: string): void;
  patchTab(id: string, patch: Partial<TabState>): void;

  setSidebarVisible(visible: boolean): void;
  setSidebarWidth(width: number): void;
  setSidebarView(view: SidebarView): void;
  setPaletteOpen(open: boolean): void;
  setFindOpen(open: boolean): void;
  setPreferencesOpen(open: boolean): void;
}

/** Rekurzivno mapiranje stabla — čuva reference čvorova koji se nisu mijenjali. */
function mapTree(nodes: TreeNode[], uri: Uri, patch: Partial<TreeNode>): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.uri === uri) {
      changed = true;
      return { ...node, ...patch };
    }
    if (node.children) {
      const children = mapTree(node.children, uri, patch);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  tree: [],
  tabs: [],
  activeTabId: null,

  sidebarVisible: true,
  sidebarWidth: 264,
  sidebarView: 'explorer',
  paletteOpen: false,
  findOpen: false,
  preferencesOpen: false,

  setTree: (tree) => set({ tree }),

  updateNode: (uri, patch) => set((s) => ({ tree: mapTree(s.tree, uri, patch) })),

  addTab: (tab) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.uri === tab.uri);
      if (existing) return { activeTabId: existing.id };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index === -1) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        // Susjed desno, pa lijevo — isto ponašanje kao u uređivačima koje ljudi znaju.
        activeTabId = tabs[index]?.id ?? tabs[index - 1]?.id ?? null;
      }
      return { tabs, activeTabId };
    }),

  activateTab: (id) => set({ activeTabId: id }),

  patchTab: (id, patch) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index === -1) return {};
      const current = s.tabs[index]!;
      const merged = { ...current, ...patch };
      // Bez ovoga svaki status tick izaziva render cijele liste tabova.
      const same = (Object.keys(patch) as (keyof TabState)[]).every((k) => current[k] === merged[k]);
      if (same) return {};
      const tabs = [...s.tabs];
      tabs[index] = merged;
      return { tabs };
    }),

  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: Math.min(520, Math.max(180, sidebarWidth)) }),
  setSidebarView: (sidebarView) => set({ sidebarView, sidebarVisible: true }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setFindOpen: (findOpen) => set({ findOpen }),
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
}));

/* ── imperativni registri ────────────────────────────────────────────── */

const documents = new Map<string, DocumentHandle>();
const instances = new Map<string, EditorInstance>();

export const tabDocuments = {
  set: (tabId: string, doc: DocumentHandle) => documents.set(tabId, doc),
  get: (tabId: string) => documents.get(tabId),
  delete: (tabId: string) => documents.delete(tabId),
};

export const tabInstances = {
  set: (tabId: string, instance: EditorInstance) => instances.set(tabId, instance),
  get: (tabId: string) => instances.get(tabId),
  delete: (tabId: string) => instances.delete(tabId),
};

export function activeInstance(): EditorInstance | undefined {
  const id = useWorkspace.getState().activeTabId;
  return id ? instances.get(id) : undefined;
}

export function activeTab(): TabState | undefined {
  const { tabs, activeTabId } = useWorkspace.getState();
  return tabs.find((t) => t.id === activeTabId);
}
