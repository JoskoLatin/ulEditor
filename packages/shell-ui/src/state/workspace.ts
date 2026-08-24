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
  /** Unix ms, last written. `null` where the platform does not report it — the
   *  web gives it for dropped files and not for directory entries. */
  modified: number | null;
}

/**
 * How the tree is ordered.
 *
 * Sorting happens where the tree is drawn, not in the stored nodes: the order
 * is a way of looking at a folder, and re-sorting must not mean re-reading it
 * or losing which branches are open.
 */
export type TreeSort = 'name' | 'type' | 'date';

/**
 * The two editor groups.
 *
 * Two, not n. A third column on a normal screen leaves each document too narrow
 * to read, and the state that makes n groups work — a tree of splits, each with
 * its own orientation — is most of a window manager. Two covers what people
 * actually do with a split: a document beside the thing it is being written
 * from.
 */
export type GroupId = 'left' | 'right';

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
  /** Which of the two groups shows this tab. */
  group: GroupId;
}

export type SidebarView = 'library' | 'explorer' | 'search' | 'formats';

/** What the find bar is looking for. In the store so it survives the bar moving
 *  from one group to the other — the same term across documents is the normal
 *  case, and retyping it because the focus moved is not. */
export interface FindQuery {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

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
  treeSort: TreeSort;
  tabs: TabState[];
  /** The tab in front of each group. The one the user is in is `active[focused]`. */
  active: Record<GroupId, string | null>;
  focused: GroupId;
  /** The share of the width the left group takes when both are shown. */
  splitRatio: number;

  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarView: SidebarView;
  paletteOpen: boolean;
  findOpen: boolean;
  find: FindQuery;
  preferencesOpen: boolean;
  quickOpen: boolean;

  setTree(tree: TreeNode[]): void;
  updateNode(uri: Uri, patch: Partial<TreeNode>): void;
  setTreeSort(sort: TreeSort): void;

  addTab(tab: Omit<TabState, 'group'> & { group?: GroupId }): void;
  closeTab(id: string): void;
  activateTab(id: string): void;
  patchTab(id: string, patch: Partial<TabState>): void;

  focusGroup(group: GroupId): void;
  moveTabToOtherGroup(id: string): void;
  setSplitRatio(ratio: number): void;

  setSidebarVisible(visible: boolean): void;
  setSidebarWidth(width: number): void;
  setSidebarView(view: SidebarView): void;
  setPaletteOpen(open: boolean): void;
  setFindOpen(open: boolean): void;
  setFind(patch: Partial<FindQuery>): void;
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

type Placement = Pick<WorkspaceState, 'tabs' | 'active' | 'focused'>;

/**
 * The one invariant of the split: it exists only while both groups hold a tab.
 *
 * Everything that removes a tab from a group — closing it, moving it across —
 * ends here, so an empty group cannot survive as a blank half of the window with
 * a resize handle beside it. When one side empties, what is left goes back to the
 * left group and the split is simply gone.
 */
function collapseEmptyGroup(next: Placement): Placement {
  const left = next.tabs.filter((tab) => tab.group === 'left');
  const right = next.tabs.filter((tab) => tab.group === 'right');
  if (left.length > 0 && right.length > 0) return next;

  const survivor = left.length > 0 ? next.active.left : next.active.right;
  return {
    tabs: next.tabs.map((tab) => (tab.group === 'left' ? tab : { ...tab, group: 'left' })),
    active: { left: survivor ?? next.tabs[0]?.id ?? null, right: null },
    focused: 'left',
  };
}

/** The tab that takes over when `id` leaves `group`: the neighbour to the right,
 *  then the one to the left — the same behaviour as in the editors people know. */
function neighbourOf(tabs: TabState[], group: GroupId, id: string): string | null {
  const inGroup = tabs.filter((tab) => tab.group === group);
  const index = inGroup.findIndex((tab) => tab.id === id);
  if (index === -1) return null;
  const rest = inGroup.filter((tab) => tab.id !== id);
  return rest[index]?.id ?? rest[index - 1]?.id ?? null;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  tree: [],
  treeSort: 'name',
  tabs: [],
  active: { left: null, right: null },
  focused: 'left',
  splitRatio: 0.5,

  sidebarVisible: true,
  sidebarWidth: 264,
  sidebarView: defaultSidebarView(),
  paletteOpen: false,
  findOpen: false,
  find: { query: '', caseSensitive: false, regex: false },
  preferencesOpen: false,
  quickOpen: false,

  setTree: (tree) => set({ tree }),
  setTreeSort: (treeSort) => set({ treeSort }),

  updateNode: (uri, patch) => set((s) => ({ tree: mapTree(s.tree, uri, patch) })),

  addTab: (tab) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.uri === tab.uri);
      // Already open, possibly in the other group: go to it rather than open a
      // second view of one document. Two live editors over one file would each
      // hold their own unsaved text, and one of them would lose.
      if (existing) {
        return { active: { ...s.active, [existing.group]: existing.id }, focused: existing.group };
      }
      // A new document opens where the user is looking.
      const group = tab.group ?? s.focused;
      return {
        tabs: [...s.tabs, { ...tab, group }],
        active: { ...s.active, [group]: tab.id },
        focused: group,
      };
    }),

  closeTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const successor = neighbourOf(s.tabs, tab.group, id);
      return collapseEmptyGroup({
        tabs: s.tabs.filter((t) => t.id !== id),
        active:
          s.active[tab.group] === id ? { ...s.active, [tab.group]: successor } : s.active,
        focused: s.focused,
      });
    }),

  activateTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return {};
      return { active: { ...s.active, [tab.group]: id }, focused: tab.group };
    }),

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

  focusGroup: (group) =>
    set((s) => (s.active[group] === null ? {} : { focused: group })),

  moveTabToOtherGroup: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const target: GroupId = tab.group === 'left' ? 'right' : 'left';
      const successor = neighbourOf(s.tabs, tab.group, id);
      return collapseEmptyGroup({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, group: target } : t)),
        active: { ...s.active, [tab.group]: successor, [target]: id },
        focused: target,
      });
    }),

  // The bounds leave both halves usable: a group at less than a fifth of the
  // width shows a line of text at a time and is a worse way of hiding a document
  // than closing it.
  setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }),

  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: Math.min(520, Math.max(180, sidebarWidth)) }),
  setSidebarView: (sidebarView) => set({ sidebarView, sidebarVisible: true }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setFindOpen: (findOpen) => set({ findOpen }),
  setFind: (patch) => set((s) => ({ find: { ...s.find, ...patch } })),
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
  setQuickOpen: (quickOpen) => set({ quickOpen }),
}));

/* ── reading the state ───────────────────────────────────────────────── */

/** The tab the user is in: the one in front of the group that has the focus. */
export function selectActiveTabId(s: WorkspaceState): string | null {
  return s.active[s.focused];
}

/** True while both groups hold something — see `collapseEmptyGroup`. */
export function selectSplit(s: WorkspaceState): boolean {
  return s.tabs.some((tab) => tab.group === 'right');
}

export function selectGroupTabs(group: GroupId) {
  return (s: WorkspaceState) => s.tabs.filter((tab) => tab.group === group);
}

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

export function activeTabId(): string | null {
  return selectActiveTabId(useWorkspace.getState());
}

export function activeInstance(): EditorInstance | undefined {
  const id = activeTabId();
  return id ? instances.get(id) : undefined;
}

export function activeTab(): TabState | undefined {
  const id = activeTabId();
  return useWorkspace.getState().tabs.find((t) => t.id === id);
}
