import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openFolder } from '../shell/actions.js';
import { useWorkspace } from '../state/workspace.js';
import { Explorer } from './Explorer.js';
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
   * Širina ide kao CSS varijabla, ne kao `width`. Inline `width` bi imao veću
   * specifičnost od svakog pravila u tablici stilova, pa se na uskom ekranu
   * ploča ne bi mogla pretvoriti u preklopnu bez `!important`.
   */
  return (
    <aside className="sidebar" style={{ '--sidebar-w': `${width}px` } as React.CSSProperties}>
      <div className="sidebar-head">
        <h2>{title(view)}</h2>
        {view === 'explorer' && (
          <button className="icon-btn" title={t('Open folder')} onClick={() => void openFolder(shell)}>
            <IconFolderOpen size={14} />
          </button>
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
 * Zatamnjenje iza preklopne ploče.
 *
 * Na uskom ekranu ploča prekriva sadržaj, pa mora imati i način da se zatvori
 * ondje gdje ju korisnik pokušava zatvoriti — dodirom pokraj nje. Prije je
 * zatamnjenje bilo `box-shadow` same ploče, što izgleda isto ali ne prima
 * dodir, pa je ploča djelovala kao da se ne da maknuti.
 *
 * Na širokom ekranu ga CSS sakriva: ondje ploča nikoga ne prekriva.
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

    // Tijekom povlačenja tekst se ne smije selektirati, inače kursor "zapne".
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
