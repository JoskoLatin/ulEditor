import { Pane } from '../../components/Pane.js';
import { selectActiveTabId, useWorkspace } from '../../state/workspace.js';

/**
 * The stage the editors live on, on a phone.
 *
 * Every open document has its place here and its editor is mounted into it
 * once, as on the desktop's `EditorSurface`, through the same `Pane`: only the
 * one in front is shown, and the others are hidden, not taken down. Taking one
 * down would lose its place, its caret and its undo, and it is the same
 * document the person swipes back to a moment later.
 *
 * One stage for the whole window: a phone has no second tab group, and every
 * document opened there goes into the first. An interface places the stage
 * and draws everything around it; it does not mount an editor itself.
 *
 * `focus`: whether the document in front takes the focus when it is mounted
 * and when it comes to the front. Off unless asked for, because on a phone the
 * focus in a text brings the keyboard up, and that is for the person to ask
 * for (a note's first line, K6), not for the opening of a PDF.
 */
export function DocumentStage({ focus = false }: { focus?: boolean }) {
  const tabs = useWorkspace((s) => s.tabs);
  const front = useWorkspace(selectActiveTabId);

  if (tabs.length === 0) return null;

  return (
    <div className="surface" data-ul-role="document-stage">
      {tabs.map((tab) => (
        <Pane key={tab.id} tab={tab} active={tab.id === front} focused={focus && tab.id === front} />
      ))}
    </div>
  );
}
