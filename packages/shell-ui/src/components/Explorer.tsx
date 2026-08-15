import { Fragment } from 'react';
import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openFolder, openUri, toggleDirectory } from '../shell/actions.js';
import { useWorkspace, type TreeNode } from '../state/workspace.js';
import { FolderIcon, FormatIcon, IconChevron, IconFolderOpen } from './Icons.js';

export function Explorer() {
  const tree = useWorkspace((s) => s.tree);

  if (tree.length === 0) return <EmptyState />;

  return (
    <div role="tree" aria-label={t('Files')}>
      {tree.map((node) => (
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
  const activeUri = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId)?.uri);

  const isDir = node.kind === 'directory';
  const descriptor = FORMATS[node.format];

  const onActivate = () => {
    if (isDir) void toggleDirectory(shell, node);
    else void openUri(shell, node.uri);
  };

  return (
    <Fragment>
      <button
        className="tree-row"
        role="treeitem"
        aria-expanded={isDir ? node.expanded : undefined}
        aria-selected={activeUri === node.uri}
        data-selected={activeUri === node.uri}
        data-open={node.expanded}
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

      {isDir && node.expanded && node.children
        ? node.children.map((child) => <Branch key={child.uri} node={child} />)
        : null}
    </Fragment>
  );
}
