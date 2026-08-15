import { FORMATS } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
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
      <button className="status-item" onClick={() => setPaletteOpen(true)} title="Paleta naredbi">
        ⌘ naredbe
      </button>

      {descriptor && (
        <span className="status-item" title={`Format: ${descriptor.label}`}>
          <span className="swatch" style={{ background: familyColor(descriptor.family) }} />
          {descriptor.label}
        </span>
      )}

      {active?.readonly && (
        <span className="status-item" title="Spremanje nije dostupno za ovaj dokument">
          samo čitanje
        </span>
      )}

      <span className="spacer" />

      {active?.status && <span className="status-item">{active.status}</span>}

      {provider && (
        <span className="status-item" title={`${provider.id} — ${provider.capabilities.join(', ')}`}>
          {provider.displayName}
        </span>
      )}

      {active?.dirty && (
        <span className="status-item" data-tone="accent">
          nespremljeno
        </span>
      )}

      <span className="status-item" title={shell.canPersist ? 'Spremanje na disk je dostupno' : 'Bez dozvole za pisanje'}>
        {shell.canPersist ? 'disk' : 'read-only'}
      </span>
    </footer>
  );
}
