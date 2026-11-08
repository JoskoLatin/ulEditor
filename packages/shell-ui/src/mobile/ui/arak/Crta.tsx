import { useEffect, type FormEvent } from 'react';
import { t } from '@uleditor/i18n';

import { useFind } from '../../common/find.js';
import { ToolRow } from '../../common/ToolRow.js';
import { Icon } from './icons.js';

/**
 * *Crta*, the paper strip above the keyboard: in reading, the search in the
 * document in front (ADR 0009, Use 1).
 *
 * The search is `useFind`, the editors' own `find()` as the desktop's bar
 * drives it; this draws it. It stands on the keyboard's top edge
 * (`bottom: var(--kb-inset)`), and the document's stage ends where it begins,
 * so a hit the editor reveals lands in what can be seen: the editors do not
 * honour a covered part of the screen yet (`--ul-obscured-bottom`, K4).
 *
 * The first hit is shown as soon as the hits are in, as "1 od 6"; the arrows
 * go round, and they sit in a row that never takes the focus, so the keyboard
 * stays up while they are pressed. Enter goes to the next hit. Gotovo, or Back,
 * closes the strip.
 *
 * Not in it yet: letters without their marks finding the marked ones
 * ("jamcevina" for "Jamčevina"), which is `foldDiacritics` in K4.
 */
export function Crta({ onClose }: { onClose(): void }) {
  const find = useFind();
  const total = find.results.length;

  /* A search that finds something shows the first hit, as the strip's count says. */
  const { results, go } = find;
  /* On the hits alone: `go` is a new function on every render. */
  useEffect(() => {
    if (results.length > 0) go(0);
  }, [results]);

  const count = find.searching
    ? t('searching…')
    : find.query
      ? total === 0
        ? t('no results')
        : t('{n} of {total}', { n: find.current + 1, total })
      : '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    find.next();
  };

  return (
    <form className="arak-crta" data-ul-role="find-strip" role="search" onSubmit={submit}>
      <div className="arak-crta-row">
        <span className="arak-crta-lead">
          <Icon shape="search" />
        </span>
        <input
          className="arak-field"
          data-ul-role="find-field"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoFocus
          value={find.query}
          onChange={(event) => find.setQuery(event.target.value)}
          placeholder={t('Find in document…')}
          aria-label={t('Find in document')}
        />
        <span
          className="arak-count"
          data-ul-role="find-count"
          data-current={total > 0 ? find.current + 1 : 0}
          data-total={total}
          aria-live="polite"
        >
          {count}
        </span>
        <ToolRow label={t('Find in document')}>
          <button type="button" className="arak-square" data-ul-role="find-prev" aria-label={t('Previous match')} disabled={total === 0} onClick={find.previous}>
            <Icon shape="up" />
          </button>
          <button type="button" className="arak-square" data-ul-role="find-next" aria-label={t('Next match')} disabled={total === 0} onClick={find.next}>
            <Icon shape="down" />
          </button>
        </ToolRow>
      </div>
      <div className="arak-crta-row small">
        <span className="arak-crta-where" data-ul-role="find-where">
          {total > 0 ? find.results[find.current]?.label : ''}
        </span>
        <button type="button" className="arak-text-button" data-ul-role="find-close" onClick={onClose}>
          {t('Done')}
        </button>
      </div>
    </form>
  );
}
