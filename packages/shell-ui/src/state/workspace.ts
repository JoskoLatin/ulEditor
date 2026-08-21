/**
 * The workspace state: the tree, the tabs, the panels.
 *
 * Imperative objects (DocumentHandle, EditorInstance) are deliberately NOT in the
 * store — they are held in separate maps. The store contains only what the UI
 * compares while rendering, so moving the cursor in an editor does not re-render
 * the whole tree.
 */

import { create } from 'zustand';
import type { DocumentHandle, EditorInstance, FormatId, Uri } from '@uleditor/plugin-sdk';

export interface TreeNode {
  uri: Uri;
  name: string;
  kind: 'file' | 'directory';
  depth: number;
  /** `null` until the directory has been read — it loads lazily on first expand. */
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
  /** The status bar text the editor publishes itself. */
  status: string;
  /** The message for when a document cannot be opened. */
  error: string | null;
  readonly: boolean;
  /** The editor instance has been created and is waiting to be mounted into the DOM. */
  ready: boolean;
}

export type SidebarView = 'library' | 'explorer' | 'search' | 'formats';

/**
 * On a narrow screen the library is the default view, on a wide one the explorer.
 *
 * This is a matter of habit rather than size: on a phone you reach a document by
 * having the program find it, on a computer by opening a folder you already know.
 * The same threshold as in the CSS; a restored session overrides this, because an
 * explicit choice beats an assumption.
 */
function defaultSidebarView(): SidebarView {
  if (typeof window === 'undefined') return 'explorer';
  return window.matchMedia('(max-width: 720px)').matches ? 'library' : 'explorer';
}

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
  quickOpen: boolean;

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
  setQuickOpen(open: boolean): void;
}

/** A recursive tree map — it preserves the references of nodes that did not change. */
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
  sidebarView: defaultSidebarView(),
  paletteOpen: false,
  findOpen: false,
  preferencesOpen: false,
  quickOpen: false,

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
        // The neighbour to the right, then the left — the same behaviour as in the editors people know.
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
      // Without this every status tick renders the whole tab list.
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
  setQuickOpen: (quickOpen) => set({ quickOpen }),
}));

/* ── the imperative registries ───────────────────────────────────────── */

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
