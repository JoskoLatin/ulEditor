import { useEffect } from 'react';

import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { openUri } from '../shell/actions.js';
import { formatLabel } from '../shell/formats.js';
import { filterItems, formatCounts, scanLibrary, useLibrary } from '../shell/library.js';
import { FormatIcon, IconRefresh } from './Icons.js';

/**
 * Popis dokumenata nađenih na uređaju.
 *
 * Namjerno nema stabla mapa: mapa je ovdje podatak uz datoteku, ne način
 * kretanja. Redoslijed je po vremenu izmjene jer je na telefonu „ono što sam
 * jučer skinuo” korisnija os od abecede.
 */
export function Library() {
  const shell = useShell();
  const phase = useLibrary((s) => s.phase);
  const items = useLibrary((s) => s.items);
  const filter = useLibrary((s) => s.filter);
  const format = useLibrary((s) => s.format);
  const blocked = useLibrary((s) => s.blocked);
  const truncated = useLibrary((s) => s.truncated);
  const error = useLibrary((s) => s.error);
  const setFilter = useLibrary((s) => s.setFilter);
  const setFormat = useLibrary((s) => s.setFormat);

  // Prvi pogled skenira sam; ponovno skeniranje je na gumbu, jer traje.
  useEffect(() => {
    if (useLibrary.getState().phase === 'idle') void scanLibrary();
  }, []);

  const shown = filterItems(items, filter, format);
  const counts = formatCounts(items);

  return (
    <div className="library">
      <div className="library-head">
        <input
          className="library-filter"
          type="search"
          value={filter}
          placeholder={t('Filter by name')}
          onChange={(event) => setFilter(event.target.value)}
          disabled={items.length === 0}
        />
        <button
          className="icon-btn"
          title={t('Scan again')}
          onClick={() => void scanLibrary()}
          disabled={phase === 'scanning'}
        >
          <IconRefresh size={14} />
        </button>
      </div>

      {counts.length > 1 && (
        <div className="library-formats">
          <button data-active={format === null} onClick={() => setFormat(null)}>
            {t('All')} <span>{items.length}</span>
          </button>
          {counts.map(({ format: id, count }) => (
            <button key={id} data-active={format === id} onClick={() => setFormat(id)}>
              {formatLabel(id)} <span>{count}</span>
            </button>
          ))}
        </div>
      )}

      {phase === 'scanning' && <p className="library-note">{t('Looking for documents…')}</p>}

      {phase === 'done' && blocked && (
        <div className="library-blocked">
          <strong>{t('Documents are hidden')}</strong>
          <p>
            {t(
              'Android hides files from apps that do not have all-files access. The folders are visible, the documents are not.',
            )}
          </p>
          <p className="library-steps">
            {t('Settings → Apps → ulEditor → Permissions → All files access')}
          </p>
          <button className="library-retry" onClick={() => void scanLibrary()}>
            {t('Scan again')}
          </button>
        </div>
      )}

      {phase === 'done' && error && <p className="library-note">{error}</p>}

      {phase === 'done' && !blocked && !error && shown.length === 0 && (
        <p className="library-note">
          {items.length === 0 ? t('No documents found on this device.') : t('Nothing matches.')}
        </p>
      )}

      <ul className="library-list">
        {shown.map((item) => (
          <li key={item.uri}>
            <button className="library-item" onClick={() => void openUri(shell, item.uri)}>
              <FormatIcon family={FORMATS[item.format].family} size={17} />
              <span className="library-name">{item.name}</span>
              <span className="library-meta">
                {item.folder} · {size(item.size)}
                {item.modified ? ` · ${when(item.modified)}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {truncated && <p className="library-note">{t('Showing the newest results only.')}</p>}
    </div>
  );
}


function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Datum bez sata: u popisu dokumenata minuta ne znači ništa, a skraćuje redak
 * koji na telefonu i tako jedva stane.
 */
function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
