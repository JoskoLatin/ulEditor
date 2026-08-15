import { useEffect, useRef } from 'react';
import { FORMATS } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { closeTab } from '../shell/actions.js';
import { tabInstances, useWorkspace } from '../state/workspace.js';
import { FormatIcon, IconClose } from './Icons.js';

export function TabBar() {
  const shell = useShell();
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activateTab = useWorkspace((s) => s.activateTab);
  const barRef = useRef<HTMLDivElement>(null);

  // Aktivna kartica mora ostati vidljiva i kad je otvorena kroz paletu.
  useEffect(() => {
    const el = barRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  if (tabs.length === 0) return null;

  return (
    <div className="tabbar" role="tablist" ref={barRef}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="tab"
          role="tab"
          aria-selected={tab.id === activeTabId}
          data-active={tab.id === activeTabId}
          data-dirty={tab.dirty}
          title={tab.uri}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              void closeTab(shell, tab.id);
            }
          }}
          onClick={() => {
            activateTab(tab.id);
            tabInstances.get(tab.id)?.focus();
          }}
        >
          <FormatIcon family={FORMATS[tab.format].family} size={14} />
          <span className="name">{tab.name}</span>
          <button
            className="close"
            aria-label={`Zatvori ${tab.name}`}
            title={tab.dirty ? 'Nespremljene promjene' : 'Zatvori'}
            onClick={(e) => {
              e.stopPropagation();
              void closeTab(shell, tab.id);
            }}
          >
            <IconClose size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
