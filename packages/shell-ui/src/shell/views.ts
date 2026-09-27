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
 *
 * **And the library is not offered in a browser.** It scans the device's own
 * folders, which a tab cannot read; offered anyway, it was a panel saying so —
 * and on a narrow screen the first thing a person saw. There the folder tree
 * is the way in, on a phone as well.
 */

import { t } from '@uleditor/i18n';

import type { SidebarView } from '../state/workspace.js';
import { IconBook, IconFiles, IconLayers, IconSearch } from '../components/Icons.js';
import { isTauri } from '../host/tauri-fs.js';
import { isNarrow } from './narrow.js';

export interface ViewEntry {
  id: SidebarView;
  label: string;
  icon: typeof IconFiles;
  /** The views that make no sense on a narrow screen. */
  desktopOnly?: boolean;
  /** Needs the application's own access to the device, which a browser lacks. */
  appOnly?: boolean;
  /** Hidden on a narrow screen only where the library stands in for it. */
  replacedByLibrary?: boolean;
}

/** A function, not a constant: the translation has to happen at render time. */
export const views = (): ViewEntry[] => [
  { id: 'library', label: t('Library — documents on this device'), icon: IconBook, appOnly: true },
  { id: 'explorer', label: t('Explorer (Ctrl+B)'), icon: IconFiles, replacedByLibrary: true },
  { id: 'search', label: t('Search in project (Ctrl+Shift+H)'), icon: IconSearch },
  { id: 'formats', label: t('Supported formats'), icon: IconLayers, desktopOnly: true },
];

export function visibleViews(): ViewEntry[] {
  const narrow = isNarrow();
  const app = isTauri();
  return views().filter(
    (view) =>
      !(view.appOnly && !app) && !(narrow && view.desktopOnly) && !(narrow && app && view.replacedByLibrary),
  );
}
