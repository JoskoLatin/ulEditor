/**
 * The library as an interface shows it: `useLibraryView`.
 *
 * The documents on the device are `useLibrary`'s, found by Rust and kept newest
 * first (`shell/library.ts`), with the state in which Android hides them
 * (`blocked`). An interface shows a part of that list: Četiri boje's reading
 * library only what can be read, its correcting library only what can be
 * changed. Each such part is a predicate over the same list, never a list of
 * its own, so a document found once is found in all of them.
 *
 * The first look at the device is started here when nothing has looked yet, as
 * the desktop's library panel does.
 */

import { useEffect, useMemo } from 'react';

import { filterItems, scanLibrary, useLibrary, type LibraryItem } from '../../shell/library.js';

/**
 * `keep`: which documents this view shows. Pass a stable function (declared
 * outside the component, or memoised); a new one on every render recomputes
 * the list on every render.
 */
export function useLibraryView(keep?: (item: LibraryItem) => boolean) {
  const items = useLibrary((s) => s.items);
  const filter = useLibrary((s) => s.filter);
  const format = useLibrary((s) => s.format);
  const phase = useLibrary((s) => s.phase);
  const blocked = useLibrary((s) => s.blocked);
  const error = useLibrary((s) => s.error);
  const truncated = useLibrary((s) => s.truncated);
  const setFilter = useLibrary((s) => s.setFilter);
  const setFormat = useLibrary((s) => s.setFormat);

  useEffect(() => {
    if (useLibrary.getState().phase === 'idle') void scanLibrary();
  }, []);

  const shown = useMemo(() => {
    const matching = filterItems(items, filter, format);
    return keep ? matching.filter(keep) : matching;
  }, [items, filter, format, keep]);

  return {
    items: shown,
    total: items.length,
    phase,
    blocked,
    error,
    truncated,
    filter,
    setFilter,
    format,
    setFormat,
    rescan: () => scanLibrary(),
  };
}
