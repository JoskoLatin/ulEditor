import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openFolder } from '../shell/actions.js';
import { useWorkspace } from '../state/workspace.js';
import { Explorer, TreeSortPicker } from './Explorer.js';
import { FormatsPanel } from './FormatsPanel.js';
import { Library } from './Library.js';
import { SearchPanel } from './SearchPanel.js';
import { IconFolderOpen } from './Icons.js';
import type { SidebarView } from '../state/workspace.js';

const title = (view: SidebarView): string =>
  view === 'library'
    ? t('Library')
    : view === 'explorer'
      ? t('Explorer')
      : view === 'search'
        ? t('Search')
        : t('Formats');

export function Sidebar() {
  const shell = useShell();
  const view = useWorkspace((s) => s.sidebarView);
  const width = useWorkspace((s) => s.sidebarWidth);

  /*
   * The width goes through a CSS variable rather than `width`. An inline `width`
   * would outrank every rule in the stylesheet, so on a narrow screen the panel
   * could not become an overlay without `!important`.
   */
  return (
    <aside className="sidebar" style={{ '--sidebar-w': `${width}px` } as React.CSSProperties}>
      <div className="sidebar-head">
        <h2>{title(view)}</h2>
        {view === 'explorer' && (
          <>
            <TreeSortPicker />
            <button className="icon-btn" title={t('Open folder')} onClick={() => void openFolder(shell)}>
              <IconFolderOpen size={14} />
            </button>
          </>
        )}
      </div>
      <div className="sidebar-scroll">
        {view === 'library' && <Library />}
        {view === 'explorer' && <Explorer />}
        {view === 'search' && <SearchPanel />}
        {view === 'formats' && <FormatsPanel />}
      </div>
    </aside>
  );
}

/**
 * The scrim behind the overlay panel.
 *
 * On a narrow screen the panel covers the content, so it needs a way to be closed
 * where the user tries to close it — with a tap beside it. The scrim used to be a
 * `box-shadow` on the panel itself, which looks the same but takes no touch, so
 * the panel felt immovable.
 *
 * On a wide screen the CSS hides it: there the panel covers nobody.
 */
export function SidebarScrim() {
  const setVisible = useWorkspace((s) => s.setSidebarVisible);
  return (
    <button
      className="sidebar-scrim"
      aria-label={t('Close panel')}
      tabIndex={-1}
      onClick={() => setVisible(false)}
    />
  );
}

export function SidebarResizer() {
  const width = useWorkspace((s) => s.sidebarWidth);
  const setWidth = useWorkspace((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      origin.current = { x: event.clientX, width };
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      setWidth(origin.current.width + (event.clientX - origin.current.x));
    };
    const onUp = () => setDragging(false);

    // While dragging, text must not be selectable, otherwise the cursor "sticks".
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      document.body.style.userSelect = previous;
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, setWidth]);

  return (
    <div
      className="resizer"
      data-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize panel')}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(264)}
    />
  );
}
