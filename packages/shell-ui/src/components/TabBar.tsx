import { useEffect, useRef } from 'react';
import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { closeTab } from '../shell/actions.js';
import { tabInstances, useWorkspace, type GroupId } from '../state/workspace.js';
import { FormatIcon, IconClose } from './Icons.js';

export function TabBar({ group }: { group: GroupId }) {
  const shell = useShell();
  const all = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.active[group]);
  const activateTab = useWorkspace((s) => s.activateTab);
  const moveTabToOtherGroup = useWorkspace((s) => s.moveTabToOtherGroup);
  const barRef = useRef<HTMLDivElement>(null);

  const tabs = all.filter((tab) => tab.group === group);

  // The active tab has to stay visible even when it was opened through the palette.
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
          /* A double-click sends the tab across. Dragging would be the expected
             gesture and is the next step; a double-click is discoverable from
             the same command in the palette and costs no drag machinery. */
          onDoubleClick={() => moveTabToOtherGroup(tab.id)}
          onClick={() => {
            activateTab(tab.id);
            tabInstances.get(tab.id)?.focus();
          }}
        >
          <FormatIcon family={FORMATS[tab.format].family} size={14} />
          <span className="name">{tab.name}</span>
          <button
            className="close"
            aria-label={t('Close {name}', { name: tab.name })}
            title={tab.dirty ? t('Unsaved changes') : t('Close')}
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
