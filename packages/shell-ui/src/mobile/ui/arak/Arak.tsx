import { useEffect, useRef, useState } from 'react';
import { hintSeen, markHintSeen } from '@uleditor/mobile-core';
import { FORMATS, type FormatId } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { closeTab, openUri } from '../../../shell/actions.js';
import type { LibraryItem } from '../../../shell/library.js';
import { selectActiveTabId, useWorkspace, type TabState } from '../../../state/workspace.js';
import { DocumentStage } from '../../common/DocumentStage.js';
import { closeLayer, isLayerOpen, openLayer, useLayers } from '../../common/history.js';
import { useLibraryView } from '../../common/library-view.js';
import type { InterfaceProps } from '../../common/MobileApp.js';
import { useOpenDocuments } from '../../common/open-documents.js';
import { settingsStore } from '../../common/settings.js';
import { Crta } from './Crta.js';
import { Fold, HintArrow } from './icons.js';
import { Questions } from './Questions.js';
import { Stol } from './Stol.js';
import { Zid } from './Zid.js';

import './tokens.css';
import './arak.css';

/** Arak's layers, bottom first: the sheet over the wall, then the desk or the strip. */
const SHEET = 'arak.sheet';
const DESK = 'arak.desk';
const FIND = 'arak.find';

/** A kind of document, for the first-time hint: one hint per kind, once (ADR 0009, `prefs.ts`). */
type Kind = 'pdf' | 'text' | 'sheet' | 'other';

function kindOf(format: FormatId): Kind {
  const family = FORMATS[format]?.family;
  if (family === 'fixed') return 'pdf';
  if (family === 'document' || family === 'book') return 'text';
  if (family === 'sheet') return 'sheet';
  return 'other';
}

function hintText(kind: Kind): string {
  switch (kind) {
    case 'pdf':
      return t('Scroll with your finger to turn the pages. The folded corner at the bottom right lifts the sheet: under it are search and your other open documents.');
    case 'text':
      return t('Scroll with your finger to read. The folded corner at the bottom right lifts the sheet: under it are search and your other open documents.');
    case 'sheet':
      return t('Move the table with your finger, in any direction. The folded corner at the bottom right lifts the sheet: under it are search and your other open documents.');
    default:
      return t('The folded corner at the bottom right lifts the sheet: under it are search and your other open documents.');
  }
}

/**
 * **Arak**, *a sheet of paper* (ADR 0009): the document is the whole screen,
 * and everything else lies under it.
 *
 * - *Zid*, the wall, is the base: the library, grouped by day and month.
 * - A tap on a page lays the document over it as a sheet, edge to edge, through
 *   `DocumentStage`, which mounts each editor once and keeps it.
 * - *Ugao*, the folded corner, is the one fixed thing on the sheet. A tap lifts
 *   the sheet and shows *stol*, the desk under it: the document's tools and
 *   *hrpa*, the pile of the others open.
 * - *Crta*, the strip above the keyboard, is where the search is typed.
 * - *Ceduljica*, a sticky note by the corner, tells once per kind of document
 *   what the corner is.
 *
 * Back closes the top layer: the strip, the desk, then the sheet, back to the
 * wall; on the wall it is not caught, and the app leaves. Every layer is one in
 * `mobile/common/history.ts`, so the system's Back and a tap close the same
 * thing. The shell's questions are drawn as Arak's own sheet above the keyboard
 * (`Questions`).
 *
 * Reading only, K6a: the document is edited the way its editor allows today,
 * and Arak adds no editing of its own. Every element a check drives carries a
 * `data-ul-role` marker; `tools/mobile-drivers/arak.mjs` lists them.
 */
export default function Arak({ shell, ui }: InterfaceProps) {
  const tabs = useWorkspace((s) => s.tabs);
  const frontId = useWorkspace(selectActiveTabId);
  const activateTab = useWorkspace((s) => s.activateTab);
  const stack = useLayers((s) => s.stack);
  const library = useLibraryView();
  const order = useOpenDocuments();
  const store = settingsStore(shell);
  const [, seen] = useState(0);

  const front = tabs.find((tab) => tab.id === frontId) ?? null;
  const sheet = front !== null && isLayerOpen(stack, SHEET);
  const desk = sheet && isLayerOpen(stack, DESK);
  const find = sheet && !desk && isLayerOpen(stack, FIND);
  const place = !sheet ? 'wall' : desk ? 'desk' : find ? 'find' : 'sheet';

  /* The colours the editors that paint on a canvas read were taken before
     Arak's were in; now they are, so they are read again (ADR 0009, "Look"). */
  useEffect(() => {
    shell.theme.setPreference(shell.theme.preference);
  }, [shell]);

  /* A document newly in front, however it got there (the wall, the pile, the
     session coming back), is laid over the wall. */
  const lastFront = useRef<string | null>(null);
  useEffect(() => {
    if (frontId && frontId !== lastFront.current) openLayer({ id: SHEET });
    lastFront.current = frontId;
  }, [frontId]);

  /* The last document put away: back to the wall, with nothing left over it. */
  useEffect(() => {
    if (tabs.length > 0) return;
    closeLayer(FIND);
    closeLayer(DESK);
    closeLayer(SHEET);
  }, [tabs.length]);

  const openTab = (tab: TabState) => {
    activateTab(tab.id);
    openLayer({ id: SHEET });
  };

  /* One already open is brought up at once. A new one comes to the front when
     its tab is added, and the effect above lays it over the wall; nothing is
     opened after the editor has loaded, which can be long after the person
     has gone back to the wall. */
  const openItem = (item: LibraryItem) => {
    const open = useWorkspace.getState().tabs.find((tab) => tab.uri === item.uri);
    if (open) openTab(open);
    else void openUri(shell, item.uri, { adopt: true });
  };

  const kind = front ? kindOf(front.format) : null;
  const hint = kind && sheet && !desk && !find && !hintSeen(store, `arak.${kind}`) ? kind : null;
  const dismissHint = () => {
    if (!hint) return;
    markHintSeen(store, `arak.${hint}`);
    seen((n) => n + 1);
  };

  const lift = () => {
    dismissHint();
    openLayer({ id: DESK });
  };

  const putAway = async () => {
    if (!front) return;
    const next = order.find((tab) => tab.id !== front.id)?.id ?? null;
    await closeTab(shell, front.id);
    /* Cancelled, or saving it failed: it stays where it was, desk and all. */
    if (useWorkspace.getState().tabs.some((tab) => tab.id === front.id)) return;
    closeLayer(DESK);
    if (next && useWorkspace.getState().tabs.some((tab) => tab.id === next)) activateTab(next);
  };

  const folder = front ? (library.items.find((item) => item.uri === front.uri)?.folder ?? '') : '';
  const others = order.filter((tab) => tab.id !== frontId);

  return (
    <div className="arak" data-ul-role="mobile-shell" data-ui={ui} data-place={place} data-layers={stack.length}>
      <Zid library={library} open={order} hidden={sheet} onOpenItem={openItem} onOpenTab={openTab} />

      {desk && front && (
        <Stol
          front={front}
          folder={folder}
          others={others}
          onFind={() => {
            closeLayer(DESK);
            openLayer({ id: FIND });
          }}
          onPutAway={() => void putAway()}
          onBringToFront={(tab) => {
            activateTab(tab.id);
            closeLayer(DESK);
          }}
          onWall={() => {
            closeLayer(DESK);
            closeLayer(SHEET);
          }}
        />
      )}

      {/* Mounted while anything is open, shown or not: an editor is mounted
          once, and the wall hides the sheet rather than taking it down. */}
      {tabs.length > 0 && (
        <div
          className="arak-sheet"
          data-ul-role="document-sheet"
          data-shown={sheet ? 'true' : 'false'}
          data-lifted={desk ? 'true' : undefined}
          data-name={front?.name}
          data-format={front?.format}
          inert={!sheet}
        >
          <div className="arak-paper" inert={desk}>
            <div className="arak-stage">
              <DocumentStage />
            </div>
          </div>

          {sheet && !desk && !find && (
            <button
              className="arak-corner"
              data-ul-role="corner"
              data-count={tabs.length}
              data-dirty={front?.dirty ? 'true' : undefined}
              aria-label={t('Lift the sheet: tools and open documents')}
              onClick={lift}
            >
              <Fold />
              {tabs.length > 1 && <span className="arak-corner-count">{tabs.length}</span>}
              {front?.dirty && <span className="arak-corner-dot" />}
            </button>
          )}

          {hint && (
            <aside className="arak-hint" role="note" data-ul-role="hint" data-kind={hint}>
              <p>{hintText(hint)}</p>
              <button className="arak-hint-ok" data-ul-role="hint-dismiss" onClick={dismissHint}>
                {t('Got it')}
              </button>
              <HintArrow />
            </aside>
          )}

          {desk && (
            <button
              className="arak-lifted"
              data-ul-role="lifted-sheet"
              aria-label={t('Put the sheet back down')}
              onClick={() => closeLayer(DESK)}
            />
          )}
        </div>
      )}

      {find && <Crta onClose={() => closeLayer(FIND)} />}

      <Questions shell={shell} />
    </div>
  );
}
