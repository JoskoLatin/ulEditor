import { useMemo } from 'react';
import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';
import { getLocale, t } from '@uleditor/i18n';

import { formatLabel } from '../../../shell/formats.js';
import type { LibraryItem } from '../../../shell/library.js';
import type { TabState } from '../../../state/workspace.js';
import type { useLibraryView } from '../../common/library-view.js';
import { FormatMark } from './icons.js';
import { groupByDate } from './wall.js';

/** A page on the wall: the format's mark where a picture of the page will be (after K8). */
export function Page({ format, small = false }: { format: FormatId; small?: boolean }) {
  const family = FORMATS[format]?.family ?? 'other';
  return (
    <span className="arak-page" data-family={family}>
      <FormatMark family={family} size={small ? 28 : 48} />
      {!small && <span className="arak-page-label">{formatLabel(format)}</span>}
    </span>
  );
}

/**
 * *Zid*, the wall: the library as Arak's base (ADR 0009, Use 1).
 *
 * The documents on the device, as `useLibraryView` has them, grouped by the day
 * each was last changed; above them the documents already open, and, when
 * Android hides the documents, a sheet that says so and what to do. A tap on a
 * page opens it. What the library holds and how it was found is the shell's
 * (`shell/library.ts`); the wall only lays it out.
 *
 * Left out on purpose until their steps: the blank page for a note and the
 * page for photographing paper (K6, after K5), the search across the library
 * (by name it exists, by content after K6) and a picture of each page (after
 * K8).
 */
export function Zid({
  library,
  open,
  hidden,
  onOpenItem,
  onOpenTab,
}: {
  library: ReturnType<typeof useLibraryView>;
  open: TabState[];
  hidden: boolean;
  onOpenItem(item: LibraryItem): void;
  onOpenTab(tab: TabState): void;
}) {
  const groups = useMemo(
    () =>
      groupByDate(library.items, new Date(), getLocale(), {
        today: t('Today'),
        week: t('This week'),
        undated: t('No date'),
      }),
    [library.items],
  );
  const folderOf = useMemo(() => new Map(library.items.map((item) => [item.uri, item.folder])), [library.items]);

  return (
    <main className="arak-wall" data-ul-role="wall" data-hidden={hidden ? 'true' : undefined} inert={hidden} aria-label={t('All documents')}>
      {library.phase === 'done' && library.blocked && (
        <section className="arak-permission" data-ul-role="permission-sheet">
          <h2>{t('Android is hiding your documents')}</h2>
          <p>
            {t('Android hides files from apps that do not have all-files access. The folders are visible, the documents are not.')}
          </p>
          <ol>
            <li>
              <span>
                {t("In Android's settings, find the permissions of ulEditor:")}{' '}
                <b>{t('Settings → Apps → ulEditor → Permissions → All files access')}</b>
              </span>
            </li>
            <li>
              <span>{t('Turn on access to all files.')}</span>
            </li>
            <li>
              <span>{t('Come back here and tap Scan again.')}</span>
            </li>
          </ol>
          <button className="arak-pill main" data-ul-role="library-rescan" onClick={() => void library.rescan()}>
            {t('Scan again')}
          </button>
        </section>
      )}

      {open.length > 0 && (
        <section className="arak-wall-open">
          <h2 className="arak-small-title">{t('Open documents')}</h2>
          <div className="arak-wall-pile" data-scroll-x="true">
            {open.map((tab) => (
              <button key={tab.id} className="arak-tile small" data-ul-role="open-document" data-name={tab.name} onClick={() => onOpenTab(tab)}>
                <Page format={tab.format} small />
                <span className="arak-tile-name">{tab.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {library.phase === 'scanning' && library.items.length === 0 && (
        <p className="arak-wall-note" data-ul-role="library-state">
          {t('Looking for documents…')}
        </p>
      )}
      {library.phase === 'done' && library.error && (
        <p className="arak-wall-note" data-ul-role="library-state">
          {library.error}
        </p>
      )}
      {library.phase === 'done' && !library.error && !library.blocked && library.total === 0 && (
        <p className="arak-wall-note" data-ul-role="library-state">
          {t('No documents found on this device.')}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.id} className="arak-wall-group" data-ul-role="wall-group" data-group={group.id}>
          <h2 className="arak-group-title" data-ul-role="wall-group-title">
            {group.title}
          </h2>
          <div className="arak-cols">
            {group.items.map((item) => (
              <button
                key={item.uri}
                className="arak-tile"
                data-ul-role="library-row"
                data-name={item.name}
                data-format={item.format}
                onClick={() => onOpenItem(item)}
              >
                <Page format={item.format} />
                <span className="arak-tile-name">{item.name}</span>
                <span className="arak-tile-meta">{folderOf.get(item.uri) || formatLabel(item.format)}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
