/**
 * The side panel views — one list for both bars.
 *
 * On a wide screen the views sit in the activity bar on the left, on a narrow one
 * in the title bar at the top. If each held a list of its own, sooner or later
 * they would drift apart.
 *
 * **Folders are not offered on a phone.** The directory tree is a desktop
 * metaphor and the library replaces it entirely; left in, it would be a second
 * way of doing the same thing, only worse.
 */

import { t } from '@uleditor/i18n';

import type { SidebarView } from '../state/workspace.js';
import { IconBook, IconFiles, IconLayers, IconSearch } from '../components/Icons.js';
import { isNarrow } from './narrow.js';

export interface ViewEntry {
  id: SidebarView;
  label: string;
  icon: typeof IconFiles;
  /** The views that make no sense on a narrow screen. */
  desktopOnly?: boolean;
}

/** A function, not a constant: the translation has to happen at render time. */
export const views = (): ViewEntry[] => [
  { id: 'library', label: t('Library — documents on this device'), icon: IconBook },
  { id: 'explorer', label: t('Explorer (Ctrl+B)'), icon: IconFiles, desktopOnly: true },
  { id: 'search', label: t('Search in project (Ctrl+Shift+H)'), icon: IconSearch },
  { id: 'formats', label: t('Supported formats'), icon: IconLayers, desktopOnly: true },
];

export function visibleViews(): ViewEntry[] {
  const narrow = isNarrow();
  return views().filter((view) => !(narrow && view.desktopOnly));
}
