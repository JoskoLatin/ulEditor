/**
 * The order the file tree is drawn in.
 *
 * Sorting happens here, at drawing time, and not in the stored nodes. Two
 * reasons: changing the order must not mean re-reading a folder or losing
 * which branches are open, and the order is a way of looking at a folder
 * rather than a fact about it.
 *
 * **Folders stay above files, under every order.** That is not a preference —
 * a tree whose folders are scattered among the files by date cannot be
 * navigated, because the thing you open to go deeper is no longer where you
 * look for it.
 *
 * No DOM and no React here, so the checks drive it directly.
 */

import type { TreeNode, TreeSort } from '../state/workspace.js';

/**
 * Names, compared the way a person reads them.
 *
 * `Intl.Collator` rather than `<`: it puts `č` where Croatian expects it
 * instead of after `z`, and `numeric` keeps `slika2` before `slika10`, which
 * is the order anybody naming files that way meant.
 */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The label a file is grouped under when sorting by type.
 *
 * The extension, not the detected format: the tree knows a name, and reading
 * every file in a folder to group it would make opening one cost what opening
 * all of them costs. A file with no extension sorts under the empty string,
 * which puts it first — with the others of its kind, which is the point.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function compare(a: TreeNode, b: TreeNode, sort: TreeSort): number {
  // Folders first, always — see the module comment.
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

  if (sort === 'date') {
    /* Newest first: sorting by date is asked for to find what changed, and
       what changed is at the end of the list under any other order. An entry
       whose date the platform does not report goes last rather than to 1970,
       where it would sit above real files and look like the oldest thing in
       the folder. */
    if (a.modified !== b.modified) {
      if (a.modified === null) return 1;
      if (b.modified === null) return -1;
      return b.modified - a.modified;
    }
  }

  if (sort === 'type' && a.kind === 'file') {
    const byType = byName.compare(extensionOf(a.name), extensionOf(b.name));
    if (byType !== 0) return byType;
  }

  // The tie-break under every order, and the whole of `name`.
  return byName.compare(a.name, b.name);
}

/**
 * The nodes in the chosen order, and their children with them.
 *
 * A new array every time rather than a sort in place: the nodes are React's
 * state, and reordering them where they live would change a rendered list
 * without telling it.
 */
export function sortTree(nodes: TreeNode[], sort: TreeSort): TreeNode[] {
  return [...nodes]
    .sort((a, b) => compare(a, b, sort))
    .map((node) =>
      node.children ? { ...node, children: sortTree(node.children, sort) } : node,
    );
}

/** What the control is called in the menu. English source; `t()` at display. */
export const SORT_LABELS: Record<TreeSort, string> = {
  name: 'Name',
  type: 'Type',
  date: 'Date modified',
};

export function isTreeSort(value: unknown): value is TreeSort {
  return value === 'name' || value === 'type' || value === 'date';
}
