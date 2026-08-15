/**
 * Pogledi bočne ploče — jedan popis za obje trake.
 *
 * Na širokom ekranu pogledi stoje u aktivnosnoj traci lijevo, na uskom u
 * naslovnoj traci gore. Ako bi svaka od njih držala vlastiti popis, prije ili
 * kasnije bi se razišle.
 *
 * **Mape se na telefonu ne nude.** Stablo direktorija je desktop metafora i
 * knjižnica ga zamjenjuje u cijelosti; ostavljeno, bilo bi to drugi način da se
 * radi isto, samo lošiji.
 */

import { t } from '@uleditor/i18n';

import type { SidebarView } from '../state/workspace.js';
import { IconBook, IconFiles, IconLayers, IconSearch } from '../components/Icons.js';

export interface ViewEntry {
  id: SidebarView;
  label: string;
  icon: typeof IconFiles;
  /** Pogledi koji na uskom ekranu nemaju smisla. */
  desktopOnly?: boolean;
}

/** Funkcija, ne konstanta: prijevod se mora dogoditi pri renderu. */
export const views = (): ViewEntry[] => [
  { id: 'library', label: t('Library — documents on this device'), icon: IconBook },
  { id: 'explorer', label: t('Explorer (Ctrl+B)'), icon: IconFiles, desktopOnly: true },
  { id: 'search', label: t('Search in project (Ctrl+Shift+H)'), icon: IconSearch },
  { id: 'formats', label: t('Supported formats'), icon: IconLayers, desktopOnly: true },
];

/** Prag je isti kao u CSS-u — jedno mjesto odlučuje što je „usko”. */
export const NARROW = '(max-width: 720px)';

export function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW).matches;
}

export function visibleViews(): ViewEntry[] {
  const narrow = isNarrow();
  return views().filter((view) => !(narrow && view.desktopOnly));
}
