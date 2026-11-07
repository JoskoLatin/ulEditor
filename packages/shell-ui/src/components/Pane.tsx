import { useEffect, useRef } from 'react';

import { t } from '@uleditor/i18n';

import { record } from '../shell/crash.js';
import { tabInstances, useWorkspace, type TabState } from '../state/workspace.js';
import { IconWarning } from './Icons.js';

/**
 * One document's place on a surface: the container its editor is mounted into,
 * once, and merely hidden while another document is in front.
 *
 * A file of its own because two surfaces hold documents: the desktop's
 * `EditorSurface`, one per tab group, and the mobile shell's `DocumentStage`
 * (ADR 0009). Both have to mount an editor exactly once, and that rule is kept
 * here, in one place.
 */
export function Pane({ tab, active, focused }: { tab: TabState; active: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const patchTab = useWorkspace((s) => s.patchTab);

  useEffect(() => {
    if (mounted.current || !tab.ready || !ref.current) return;
    const instance = tabInstances.get(tab.id);
    if (!instance) return;

    mounted.current = true;
    void Promise.resolve(instance.mount(ref.current))
      .then(() => {
        if (focused) instance.focus();
      })
      /*
       * An editor that never started used to leave a tab that looked like a
       * perfectly ordinary empty document — right name, right title bar, right
       * status line, and nothing in it. The panel below already exists for a
       * document that could not be opened; this is the same thing one step
       * later, and it belongs in the same place.
       */
      .catch((error: unknown) => {
        record(error, { where: 'starting an editor', format: tab.format, providerId: tab.providerId });
        patchTab(tab.id, { error: error instanceof Error ? error.message : String(error) });
      });
  }, [tab.id, tab.ready, focused, patchTab]);

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
    /* Marked because one document in the window has the caret, and `Ctrl+A`
       has to know which: selecting "everything" without it takes the tab bar,
       the tree and the status line along with the text. */
    <div className="mount" data-focused={focused ? 'true' : undefined} style={{ display: active ? 'flex' : 'none' }}>
      <div ref={ref} style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }} />
      {!tab.ready && (
        <div className="surface-loading">{t('Loading {name}…', { name: tab.name })}</div>
      )}
    </div>
  );
}
