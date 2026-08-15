import { FORMATS } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { formatLabel } from '../shell/formats.js';
import { useWorkspace } from '../state/workspace.js';
import { familyColor } from './Icons.js';

export function StatusBar() {
  const shell = useShell();
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setPaletteOpen = useWorkspace((s) => s.setPaletteOpen);

  const active = tabs.find((t) => t.id === activeTabId);
  const descriptor = active ? FORMATS[active.format] : null;
  const provider = active?.providerId
    ? shell.registry.all().find((p) => p.id === active.providerId)
    : null;

  return (
    <footer className="statusbar">
      <button className="status-item" onClick={() => setPaletteOpen(true)} title={t('Command palette')}>
        ⌘ {t('commands')}
      </button>

      {descriptor && (
        <span className="status-item" title={t('Format: {name}', { name: formatLabel(descriptor.id) })}>
          <span className="swatch" style={{ background: familyColor(descriptor.family) }} />
          {formatLabel(descriptor.id)}
        </span>
      )}

      {active?.readonly && (
        <span className="status-item" title={t('Saving is not available for this document')}>
          {t('read-only')}
        </span>
      )}

      <span className="status-origin">made in Vodice</span>

      <span className="spacer" />

      {active?.status && <span className="status-item">{active.status}</span>}

      {provider && (
        <span className="status-item" title={`${provider.id} — ${provider.capabilities.join(', ')}`}>
          {provider.displayName}
        </span>
      )}

      {active?.dirty && (
        <span className="status-item" data-tone="accent">
          {t('unsaved')}
        </span>
      )}

      <span
        className="status-item"
        title={shell.canPersist ? t('Saving to disk is available') : t('No write permission')}
      >
        {shell.canPersist ? t('disk') : t('read-only')}
      </span>
    </footer>
  );
}
