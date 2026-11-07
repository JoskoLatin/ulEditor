import { selectActiveTabId, useWorkspace, type GroupId } from '../state/workspace.js';
import { Pane } from './Pane.js';
import { Welcome } from './Welcome.js';

/**
 * The surface the editors live on.
 *
 * Every tab gets a permanent container that is merely hidden when switching, and
 * the instance is mounted exactly once. Unmounting on every switch would lose the
 * scroll position, the cursor and the undo history — which is precisely how you
 * recognise an editor not worth using.
 */
export function EditorSurface({ group }: { group: GroupId }) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeInGroup = useWorkspace((s) => s.active[group]);
  const focusedTabId = useWorkspace(selectActiveTabId);

  const mine = tabs.filter((tab) => tab.group === group);
  if (mine.length === 0) return <Welcome />;

  return (
    <div className="surface">
      {mine.map((tab) => (
        <Pane
          key={tab.id}
          tab={tab}
          active={tab.id === activeInGroup}
          /* In front of its own group, but the caret belongs to one document in
             the window — taking the focus for the group that does not have it
             would move the cursor out from under the user's hands. */
          focused={tab.id === focusedTabId}
        />
      ))}
    </div>
  );
}
