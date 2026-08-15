import { useCallback, useEffect, useRef, useState } from 'react';

import { useShell } from '../shell/context.js';
import { openFolder } from '../shell/actions.js';
import { useWorkspace } from '../state/workspace.js';
import { Explorer } from './Explorer.js';
import { FormatsPanel } from './FormatsPanel.js';
import { IconFolderOpen } from './Icons.js';

const TITLES = {
  explorer: 'Istraživač',
  formats: 'Formati',
} as const;

export function Sidebar() {
  const shell = useShell();
  const view = useWorkspace((s) => s.sidebarView);
  const width = useWorkspace((s) => s.sidebarWidth);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <h2>{TITLES[view]}</h2>
        {view === 'explorer' && (
          <button className="icon-btn" title="Otvori mapu" onClick={() => void openFolder(shell)}>
            <IconFolderOpen size={14} />
          </button>
        )}
      </div>
      <div className="sidebar-scroll">{view === 'explorer' ? <Explorer /> : <FormatsPanel />}</div>
    </aside>
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
      aria-label="Promijeni širinu ploče"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(264)}
    />
  );
}
