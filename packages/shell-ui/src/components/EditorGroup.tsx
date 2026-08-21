/**
 * One editor group: its tabs, its documents, and the find bar when it is the
 * group in front.
 *
 * The whole point of the split is that two documents are visible at once while
 * exactly one of them has the caret. So the group carries the focus, not the
 * tab: clicking anywhere inside a group makes it the one that Ctrl+S saves,
 * Ctrl+W closes and the status bar describes.
 *
 * The find bar lives in the focused group rather than above both. It searches
 * one document, so it belongs beside that document — and with a single group it
 * sits exactly where it always has, under the tabs.
 */

import { useWorkspace, type GroupId } from '../state/workspace.js';
import { EditorSurface } from './EditorSurface.js';
import { FindPanel } from './FindPanel.js';
import { TabBar } from './TabBar.js';

export function EditorGroup({ group }: { group: GroupId }) {
  const focused = useWorkspace((s) => s.focused === group);
  const focusGroup = useWorkspace((s) => s.focusGroup);
  const split = useWorkspace((s) => s.tabs.some((tab) => tab.group === 'right'));

  return (
    <section
      className="group"
      data-focused={focused}
      data-split={split}
      /*
       * Capturing, because the click usually lands inside an editor that stops
       * it — CodeMirror and the PDF layer both do. Without the capture phase the
       * group under the pointer would never learn it had been clicked.
       */
      onMouseDownCapture={() => focusGroup(group)}
      onFocusCapture={() => focusGroup(group)}
    >
      <TabBar group={group} />
      {focused ? <FindPanel /> : null}
      <EditorSurface group={group} />
    </section>
  );
}

/**
 * The handle between the two groups.
 *
 * The same shape as the side panel's, and for the same reason: a person who has
 * learned that the seam between two areas can be dragged expects every seam to
 * behave that way.
 */
export function GroupResizer() {
  const setSplitRatio = useWorkspace((s) => s.setSplitRatio);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const row = event.currentTarget.parentElement;
    if (!row) return;

    // While dragging, text must not be selectable, otherwise the cursor "sticks"
    // — the same handling as the side panel's handle.
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const move = (e: PointerEvent) => {
      const box = row.getBoundingClientRect();
      if (box.width <= 0) return;
      setSplitRatio((e.clientX - box.left) / box.width);
    };
    const up = () => {
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return <div className="group-resizer" onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" />;
}
