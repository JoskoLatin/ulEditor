/**
 * The document library — the mobile way of reaching a file.
 *
 * An explorer with a folder tree assumes the user knows where something of theirs
 * sits. On a phone they do not, and have no reason to: they know they have some
 * contract in a PDF. So no folder is opened here; the device is surveyed and
 * what was found is offered, newest first.
 *
 * The scan is done by Rust (`scan_library`) — the same reason as with search:
 * only the listing crosses the IPC boundary, not the content.
 *
 * **Denied access is reported, not passed over.** Android without the storage
 * permission returns folders with not one file and reports no error. The app
 * would then claim the phone holds no documents while it holds hundreds. The core
 * recognises that difference and it becomes `blocked` here, on which basis the
 * view offers instructions instead of an empty list.
 */

import { create } from 'zustand';
import { type FormatId, type Uri } from '@uleditor/plugin-sdk';

import { isTauri } from '../host/tauri-fs.js';

export interface LibraryItem {
  uri: Uri;
  name: string;
  format: FormatId;
  size: number;
  /** Unix ms; missing when the platform does not supply it. */
  modified?: number;
  /** The folder it was found in, e.g. `Download/Foxit`. */
  folder: string;
}

export type LibraryPhase = 'idle' | 'scanning' | 'done';

interface LibraryState {
  phase: LibraryPhase;
  items: LibraryItem[];
  /** A filter by name; empty means everything. */
  filter: string;
  /** The chosen format, or `null` for all of them. */
  format: FormatId | null;
  /** The system is hiding files — a permission is needed, the device is not empty. */
  blocked: boolean;
  scannedDirs: number;
  truncated: boolean;
  error: string | null;

  setFilter(filter: string): void;
  setFormat(format: FormatId | null): void;
}

export const useLibrary = create<LibraryState>((set) => ({
  phase: 'idle',
  items: [],
  filter: '',
  format: null,
  blocked: false,
  scannedDirs: 0,
  truncated: false,
  error: null,

  setFilter: (filter) => set({ filter }),
  setFormat: (format) => set({ format }),
}));

interface RawScan {
  entries: {
    uri: string;
    name: string;
    format: string;
    size: number;
    modified: number | null;
    folder: string;
  }[];
  scannedDirs: number;
  seenFiles: number;
  truncated: boolean;
}

/**
 * Surveys the device. A repeat call always starts afresh — the library
 * deliberately has no cache, because a stale list would be worse than a short
 * wait.
 */
export async function scanLibrary(): Promise<void> {
  if (!isTauri()) {
    useLibrary.setState({
      phase: 'done',
      items: [],
      error: 'Library needs the desktop or mobile app.',
    });
    return;
  }

  useLibrary.setState({ phase: 'scanning', error: null });

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const scan = await invoke<RawScan>('scan_library', { limit: 2000 });

    /*
     * An empty list alongside scanned folders but not one file seen means the
     * system is hiding content. The same check happens in the core; it is
     * repeated here because the view depends on it, and the core sends numbers
     * rather than a conclusion.
     */
    const blocked = scan.seenFiles === 0 && scan.scannedDirs > 1;

    const fresh: LibraryItem[] = scan.entries.map((entry) => ({
      uri: entry.uri as Uri,
      name: entry.name,
      format: entry.format as FormatId,
      size: entry.size,
      modified: entry.modified ?? undefined,
      folder: entry.folder,
    }));

    /*
     * When blocked, the list stays as it was. An empty result then says something
     * about the permission rather than about the device, so clearing already
     * displayed documents would amount to claiming they had vanished.
     */
    const previous = useLibrary.getState().items;

    useLibrary.setState({
      phase: 'done',
      items: blocked ? previous : merge(previous, fresh),
      blocked,
      scannedDirs: scan.scannedDirs,
      truncated: scan.truncated,
    });
  } catch (err) {
    useLibrary.setState({
      phase: 'done',
      items: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Merges a new scan with what is already on display.
 *
 * A rescan neither tears the list down nor rebuilds it from scratch: an entry
 * that has not changed keeps **the same object**, so React does not re-render a
 * row sitting in front of the user. New entries are added, changed ones are
 * refreshed.
 *
 * What is no longer found **drops out**. A list that only grows soon starts
 * offering deleted files, and a document that will not open is worse than a
 * document that is not there — the library would lose trust at exactly the point
 * where it builds it.
 *
 * The exception is being blocked: when Android hides the files, the core returns
 * nothing and the caller then does not touch the list at all (see `blocked`).
 */
function merge(previous: LibraryItem[], fresh: LibraryItem[]): LibraryItem[] {
  if (previous.length === 0) return fresh;

  const known = new Map(previous.map((item) => [item.uri, item]));

  return fresh.map((item) => {
    const old = known.get(item.uri);
    const unchanged =
      old && old.modified === item.modified && old.size === item.size && old.name === item.name;
    return unchanged ? old : item;
  });
}

/** The formats that actually turn up, by frequency — for the filter chips. */
export function formatCounts(items: LibraryItem[]): { format: FormatId; count: number }[] {
  const counts = new Map<FormatId, number>();
  for (const item of items) counts.set(item.format, (counts.get(item.format) ?? 0) + 1);
  return [...counts.entries()]
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count);
}

export function filterItems(
  items: LibraryItem[],
  filter: string,
  format: FormatId | null,
): LibraryItem[] {
  const needle = filter.trim().toLowerCase();
  return items.filter((item) => {
    if (format && item.format !== format) return false;
    if (!needle) return true;
    return item.name.toLowerCase().includes(needle) || item.folder.toLowerCase().includes(needle);
  });
}
