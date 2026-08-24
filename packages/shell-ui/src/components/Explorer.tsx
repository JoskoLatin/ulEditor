import { Fragment, useMemo, useState } from 'react';
import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openFolder, openUri, refreshRoot, removeRoot, toggleDirectory } from '../shell/actions.js';
import { SORT_LABELS, sortTree } from '../shell/tree-sort.js';
import { selectActiveTabId, useWorkspace, type TreeNode, type TreeSort } from '../state/workspace.js';
import { FolderIcon, FormatIcon, IconChevron, IconFolderOpen, IconRefresh, IconTrash } from './Icons.js';

export function Explorer() {
  const tree = useWorkspace((s) => s.tree);
  const sort = useWorkspace((s) => s.treeSort);

  /* Sorted where it is drawn, and only when something it depends on changed —
     a folder of a few thousand entries is sorted in a millisecond, but not on
     every unrelated render. */
  const ordered = useMemo(() => sortTree(tree, sort), [tree, sort]);

  if (tree.length === 0) return <EmptyState />;

  return (
    <div role="tree" aria-label={t('Files')}>
      {ordered.map((node) => (
        <Branch key={node.uri} node={node} />
      ))}
    </div>
  );
}

function EmptyState() {
  const shell = useShell();

  return (
    <div className="empty-note">
      <p style={{ margin: 0 }}>
        {t('No folder open. Open one to get a file tree, or drop files straight into the window.')}
      </p>
      <button className="ghost-btn" onClick={() => void openFolder(shell)}>
        <IconFolderOpen size={13} /> {t('Open folder')}
      </button>
      {!shell.canPersist && (
        <p style={{ margin: 0, color: 'var(--warn)' }}>
          {t(
            'This browser has no File System Access API — files can be read but not saved. The desktop build has no such limit.',
          )}
        </p>
      )}
    </div>
  );
}

function Branch({ node }: { node: TreeNode }) {
  const shell = useShell();
  const activeUri = useWorkspace((s) => s.tabs.find((t) => t.id === selectActiveTabId(s))?.uri);
  const [busy, setBusy] = useState(false);

  const isDir = node.kind === 'directory';
  const isRoot = node.depth === 0;
  const descriptor = FORMATS[node.format];

  const onActivate = () => {
    if (isDir) void toggleDirectory(shell, node);
    else void openUri(shell, node.uri);
  };

  const onRefresh = async () => {
    setBusy(true);
    try {
      await refreshRoot(shell, node);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Fragment>
      {/*
        A row, not a button, once it has controls of its own: a button inside a
        button is invalid HTML, and browsers resolve it by dropping the inner
        one — so the refresh and remove controls would render and do nothing.
      */}
      <div
        className="tree-row"
        role="treeitem"
        aria-expanded={isDir ? node.expanded : undefined}
        aria-selected={activeUri === node.uri}
        data-selected={activeUri === node.uri}
        data-open={node.expanded}
        data-root={isRoot || undefined}
      >
        <button
          className="tree-label"
          style={{ paddingLeft: 8 + node.depth * 12 }}
          onClick={onActivate}
          title={node.name}
        >
          <span className="chev">{isDir ? <IconChevron size={11} /> : null}</span>
          <span className="fmt-icon">
            {isDir ? (
              <FolderIcon open={node.expanded} size={15} />
            ) : (
              <FormatIcon family={descriptor.family} size={15} />
            )}
          </span>
          <span className="label">{node.name}</span>
        </button>

        {/*
          Only on a root. Deeper folders are re-read by the one above them, and
          "remove" has no meaning for a folder that is inside another — it
          would be asking to hide a piece of the folder you are looking at.
        */}
        {isRoot && (
          <span className="tree-actions">
            <button
              className="icon-btn"
              title={t('Check for new files')}
              aria-label={t('Check for new files')}
              data-busy={busy || undefined}
              disabled={busy}
              onClick={() => void onRefresh()}
            >
              <IconRefresh size={13} />
            </button>
            <button
              className="icon-btn"
              title={t('Remove from the list — the folder itself is not touched')}
              aria-label={t('Remove from the list — the folder itself is not touched')}
              onClick={() => removeRoot(shell, node)}
            >
              <IconTrash size={13} />
            </button>
          </span>
        )}
      </div>

      {isDir && node.expanded && node.children
        ? node.children.map((child) => <Branch key={child.uri} node={child} />)
        : null}
    </Fragment>
  );
}

/**
 * The order the tree is drawn in.
 *
 * A `<select>` rather than a menu of our own: it is one of the few controls
 * the platform draws better than we would, it reaches the keyboard and the
 * screen reader for free, and on a phone it becomes the native picker.
 */
export function TreeSortPicker() {
  const shell = useShell();
  const sort = useWorkspace((s) => s.treeSort);
  const setTreeSort = useWorkspace((s) => s.setTreeSort);

  return (
    <select
      className="sort-select"
      value={sort}
      title={t('Sort by')}
      aria-label={t('Sort by')}
      onChange={(event) => {
        const next = event.target.value as TreeSort;
        setTreeSort(next);
        // An order is a preference, not a thing to choose again every morning.
        shell.settings.set('explorer.sort', next);
      }}
    >
      {(Object.keys(SORT_LABELS) as TreeSort[]).map((id) => (
        <option key={id} value={id}>
          {t(SORT_LABELS[id])}
        </option>
      ))}
    </select>
  );
}
