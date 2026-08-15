import { useEffect, useRef } from 'react';

import { t } from '@uleditor/i18n';

import { tabInstances, useWorkspace, type TabState } from '../state/workspace.js';
import { Welcome } from './Welcome.js';
import { IconWarning } from './Icons.js';

/**
 * Površina na kojoj žive editori.
 *
 * Svaka kartica dobiva trajni kontejner koji se pri prebacivanju samo skriva,
 * a instanca se montira točno jednom. Demontaža pri svakom prebacivanju
 * izgubila bi poziciju scrolla, kursor i undo povijest — a upravo se po tome
 * prepoznaje editor koji se ne isplati koristiti.
 */
export function EditorSurface() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);

  if (tabs.length === 0) return <Welcome />;

  return (
    <div className="surface">
      {tabs.map((tab) => (
        <Pane key={tab.id} tab={tab} active={tab.id === activeTabId} />
      ))}
    </div>
  );
}

function Pane({ tab, active }: { tab: TabState; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current || !tab.ready || !ref.current) return;
    const instance = tabInstances.get(tab.id);
    if (!instance) return;

    mounted.current = true;
    void Promise.resolve(instance.mount(ref.current)).then(() => {
      if (active) instance.focus();
    });
  }, [tab.id, tab.ready, active]);

  // Fokus prati aktivnu karticu, ali tek nakon što je editor montiran.
  useEffect(() => {
    if (active && mounted.current) tabInstances.get(tab.id)?.focus();
  }, [active, tab.id]);

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
