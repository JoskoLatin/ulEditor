import { useEffect, useRef } from 'react';

import { t } from '@uleditor/i18n';

import {
  selectActiveTabId,
  tabInstances,
  useWorkspace,
  type GroupId,
  type TabState,
} from '../state/workspace.js';
import { Welcome } from './Welcome.js';
import { IconWarning } from './Icons.js';

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

function Pane({ tab, active, focused }: { tab: TabState; active: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current || !tab.ready || !ref.current) return;
    const instance = tabInstances.get(tab.id);
    if (!instance) return;

    mounted.current = true;
    void Promise.resolve(instance.mount(ref.current)).then(() => {
      if (focused) instance.focus();
    });
  }, [tab.id, tab.ready, focused]);

  // The focus follows the active tab, but only once the editor is mounted.
  useEffect(() => {
    if (focused && mounted.current) tabInstances.get(tab.id)?.focus();
  }, [focused, tab.id]);

  if (tab.error) {
    return (
      <div className="mount" style={{ display: active ? 'flex' : 'none' }}>
        <div className="surface-error">
          <IconWarning size={22} />
          <strong>{t('This document could not be opened')}</strong>
          <p style={{ margin: 0 }}>{tab.error}</p>
          <code>{tab.name}</code>
        </div>
      </div>
    );
  }

  return (
    <div className="mount" style={{ display: active ? 'flex' : 'none' }}>
      <div ref={ref} style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }} />
      {!tab.ready && (
        <div className="surface-loading">{t('Loading {name}…', { name: tab.name })}</div>
      )}
    </div>
  );
}
