/**
 * Vodoravni split ispod glavnog područja.
 *
 * Traka ploče nosi ime dokumenta i **izbor formata u koji se sprema** — jer
 * dokument u ploči nije došao s diska, pa dok se ne odabere format nema ni
 * odredišta. To je razlika prema običnoj kartici, i zato ploča ima vlastitu
 * traku umjesto da se pravi da je kartica kao svaka druga.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import {
  closeScratch,
  saveScratch,
  scratchInstance,
  useScratch,
  type ScratchFormat,
} from '../shell/scratch.js';
import { IconClose, IconSave } from './Icons.js';

/** Isti popis kao u `@uleditor/text-export`, ali bez uvoza tog paketa —
 *  pdf-lib ne smije ući u početni bundle zbog jednog izbornika. */
const FORMATS: { id: ScratchFormat; label: string }[] = [
  { id: 'txt', label: 'Plain text' },
  { id: 'md', label: 'Markdown' },
  { id: 'docx', label: 'Word document' },
  { id: 'pdf', label: 'PDF' },
];

export function SplitPane() {
  const shell = useShell();
  const open = useScratch((s) => s.open);
  const height = useScratch((s) => s.height);
  const name = useScratch((s) => s.name);
  const format = useScratch((s) => s.format);
  const setFormat = useScratch((s) => s.setFormat);
  const dirty = useScratch((s) => s.dirty);
  const status = useScratch((s) => s.status);
  const ready = useScratch((s) => s.ready);

  const mountRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  // Instanca se montira točno jednom, kao i kod kartica.
  useEffect(() => {
    if (!open) {
      mounted.current = false;
      return;
    }
    if (mounted.current || !ready || !mountRef.current) return;

    const instance = scratchInstance();
    if (!instance) return;

    mounted.current = true;
    void Promise.resolve(instance.mount(mountRef.current)).then(() => instance.focus());
  }, [open, ready]);

  if (!open) return null;

  return (
    <>
      <SplitResizer />
      <section className="split" style={{ height }} aria-label={t('Split below')}>
        <header className="split-bar">
          <span className="split-name" title={name}>
            {name}
            {dirty ? ' •' : ''}
          </span>

          <label className="split-format" title={t('Choose the format this document is saved in')}>
            <span>{t('Save as')}</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as ScratchFormat)}>
              {FORMATS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t(entry.label)}
                </option>
              ))}
            </select>
          </label>

          <button className="chrome-btn" onClick={() => void saveScratch(shell)} title={t('Save')}>
            <IconSave size={13} />
            {t('Save')}
          </button>

          <button
            className="icon-btn"
            onClick={() => void closeScratch(shell)}
            aria-label={t('Close')}
            title={t('Close')}
          >
            <IconClose size={12} />
          </button>
        </header>

        <div className="split-mount" ref={mountRef} />

        <footer className="split-status">
          <span>{status || t('Not saved yet')}</span>
        </footer>
      </section>
    </>
  );
}

function SplitResizer() {
  const height = useScratch((s) => s.height);
  const setHeight = useScratch((s) => s.setHeight);
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ y: 0, height: 0 });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      origin.current = { y: event.clientY, height };
      setDragging(true);
    },
    [height],
  );

  useEffect(() => {
    if (!dragging) return;

    // Prema gore znači više prostora ploči, pa je predznak obrnut.
    const onMove = (event: PointerEvent) =>
      setHeight(origin.current.height - (event.clientY - origin.current.y));
    const onUp = () => setDragging(false);

    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      document.body.style.userSelect = previous;
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, setHeight]);

  return (
    <div
      className="split-resizer"
      data-dragging={dragging}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('Resize split')}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setHeight(300)}
    />
  );
}
