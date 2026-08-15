/**
 * Obnova sesije.
 *
 * Program koji se otvori prazan nakon što si zatvorio prozor s dvanaest
 * kartica nije alat nego demo. Pamte se korijeni stabla, otvorene kartice i
 * koja je bila aktivna.
 *
 * **Samo desktop.** Na webu je `Uri` ključ `FileSystemHandle`-a koji vrijedi
 * unutar jedne sesije; oživljavanje traži IndexedDB i novo pitanje korisniku
 * za dozvolu pri svakom pokretanju. Radije ne obnavljamo ništa nego da se
 * program otvori s dijalozima za dozvole.
 */

import type { Uri } from '@uleditor/plugin-sdk';

import type { Shell } from '../host/index.js';
import { useWorkspace } from '../state/workspace.js';
import { addRoot, openUri } from './actions.js';

const KEY = 'session.workspace';
/** Iznad ovoga obnova traje dulje nego što itko želi čekati pokretanje. */
const MAX_TABS = 24;

interface StoredSession {
  roots: Uri[];
  tabs: Uri[];
  active: Uri | null;
}

export function saveSession(shell: Shell): void {
  if (shell.platform !== 'desktop') return;

  const { tree, tabs, activeTabId } = useWorkspace.getState();
  const session: StoredSession = {
    roots: tree.map((node) => node.uri),
    tabs: tabs.slice(0, MAX_TABS).map((tab) => tab.uri),
    active: tabs.find((tab) => tab.id === activeTabId)?.uri ?? null,
  };
  shell.settings.set(KEY, session);
}

/**
 * Vraća prošlu sesiju. Datoteke koje su u međuvremenu obrisane ili premještene
 * se preskaču bez buke — obnova sesije ne smije zasuti korisnika greškama za
 * nešto što nije tražio.
 */
export async function restoreSession(shell: Shell): Promise<void> {
  if (shell.platform !== 'desktop') return;

  const session = shell.settings.get<StoredSession | null>(KEY, null);
  if (!session) return;

  for (const uri of session.roots ?? []) {
    try {
      await addRoot(shell, { uri, name: baseName(uri) });
    } catch {
      // Mapa više ne postoji.
    }
  }

  for (const uri of (session.tabs ?? []).slice(0, MAX_TABS)) {
    try {
      await openUri(shell, uri, { quiet: true });
    } catch {
      // Datoteka više ne postoji.
    }
  }

  if (session.active) {
    const tab = useWorkspace.getState().tabs.find((t) => t.uri === session.active);
    if (tab) useWorkspace.getState().activateTab(tab.id);
  }
}

/** Prati promjene i sprema ih odgođeno — svaki klik po stablu ne treba zapis. */
export function watchSession(shell: Shell): () => void {
  if (shell.platform !== 'desktop') return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveSession(shell), 400);
  };

  const unsubscribe = useWorkspace.subscribe(schedule);
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

function baseName(uri: Uri): string {
  const parts = uri.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? uri;
}
