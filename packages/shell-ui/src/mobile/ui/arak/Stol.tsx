import { t } from '@uleditor/i18n';

import { formatLabel } from '../../../shell/formats.js';
import type { TabState } from '../../../state/workspace.js';
import { Icon } from './icons.js';
import { Page } from './Zid.js';

/**
 * *Stol*, the desk under the sheet (ADR 0009): what the corner shows when it
 * lifts the sheet. The name and state of the document in front, the tools for
 * it, and *hrpa*, the pile of the other open documents, the one used last
 * first.
 *
 * Reading only, until K4 and K6: Traži, which opens *crta*, and Odloži, which
 * puts the document away through the shell's own `closeTab` and so asks, the
 * shell's way, when something is unsaved. No tool of the editors' is repeated
 * here and none of theirs is hidden; the document is edited the way its editor
 * allows today.
 */
export function Stol({
  front,
  folder,
  others,
  onFind,
  onPutAway,
  onBringToFront,
  onWall,
}: {
  front: TabState;
  folder: string;
  others: TabState[];
  onFind(): void;
  onPutAway(): void;
  onBringToFront(tab: TabState): void;
  onWall(): void;
}) {
  return (
    <section className="arak-desk" data-ul-role="desk" aria-label={t('Tools and open documents')}>
      <div className="arak-desk-info">
        <h2 data-ul-role="desk-name">{front.name}</h2>
        <p>{folder ? `${formatLabel(front.format)}. ${folder}` : formatLabel(front.format)}</p>
        {front.status && <p>{front.status}</p>}
        <p
          className="arak-desk-state"
          data-ul-role="desk-state"
          data-state={front.dirty ? 'dirty' : front.readonly ? 'readonly' : 'clean'}
        >
          {front.dirty ? <span className="arak-dot" aria-hidden="true" /> : <Icon shape="check" size={20} />}
          {front.dirty ? t('Unsaved changes') : front.readonly ? t('Read-only') : t('No changes')}
        </p>
        <p className="arak-desk-tip">{t('Tap the sheet to put it back down.')}</p>
      </div>

      <div className="arak-desk-lower">
        <div className="arak-tools">
          <button className="arak-tool" data-ul-role="desk-find" onClick={onFind}>
            <Icon shape="search" size={28} />
            <span>{t('Find')}</span>
          </button>
          <button className="arak-tool" data-ul-role="desk-put-away" onClick={onPutAway}>
            <Icon shape="putAway" size={28} />
            <span>{t('Put away')}</span>
          </button>
        </div>

        <h3 className="arak-desk-label">
          {others.length > 0 ? t('Open, {n} more', { n: others.length }) : t('No other open documents')}
        </h3>
        <div className="arak-pile" data-ul-role="pile" data-scroll-x="true">
          {others.map((tab) => (
            <button key={tab.id} className="arak-tile small" data-ul-role="desk-document" data-name={tab.name} onClick={() => onBringToFront(tab)}>
              <Page format={tab.format} small />
              <span className="arak-tile-name">{tab.name}</span>
            </button>
          ))}
          <button className="arak-all" data-ul-role="desk-wall" onClick={onWall}>
            <span className="arak-all-box">
              <Icon shape="grid" size={30} />
            </span>
            <span className="arak-tile-name">{t('All documents')}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
