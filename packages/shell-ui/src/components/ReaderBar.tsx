/**
 * Traka čitaonice.
 *
 * Jedina kontrola koja se u načinu čitanja vidi. Sve što nudi vodi natrag u
 * tekst: sadržaj, tipografija, napredak. Namjerno nema ništa o datoteci —
 * spremanje, kartice i stablo su u ovom načinu rada nevidljivi jer ne
 * sudjeluju u čitanju.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReadingFlow, ReadingTint } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import {
  exitReading,
  persistReadingOptions,
  readerGoTo,
  readerOutline,
  readerPage,
  readerSeek,
  useReading,
} from '../shell/reading.js';
import { IconArrow, IconClose, IconList, IconType } from './Icons.js';

/** Funkcije, ne konstante: prijevod se mora dogoditi pri renderu. */
const tints = (): { id: ReadingTint; label: string }[] => [
  { id: 'day', label: t('Day') },
  { id: 'sepia', label: t('Sepia') },
  { id: 'night', label: t('Night') },
];

const flows = (): { id: ReadingFlow; label: string }[] => [
  { id: 'paged', label: t('Pages') },
  { id: 'scroll', label: t('Scroll') },
];

export function ReaderBar() {
  const shell = useShell();
  const title = useReading((s) => s.title);
  const panel = useReading((s) => s.panel);
  const setPanel = useReading((s) => s.setPanel);
  const progress = useReading((s) => s.progress);

  return (
    <div className="reader">
      <div className="reader-bar">
        <button className="reader-btn" onClick={exitReading} title={t('Leave reading mode (Esc)')}>
          <IconClose size={14} />
          <span>{t('Close')}</span>
        </button>

        <div className="reader-title">{title}</div>

        <div className="reader-nav">
          <button className="reader-icon" onClick={() => readerPage(-1)} title={t('Previous page')}>
            <IconArrow dir="left" size={14} />
          </button>
          <button className="reader-icon" onClick={() => readerPage(1)} title={t('Next page')}>
            <IconArrow dir="right" size={14} />
          </button>
        </div>

        <div className="reader-tools">
          <button
            className="reader-btn"
            data-active={panel === 'outline'}
            onClick={() => setPanel('outline')}
            title={t('Contents')}
          >
            <IconList size={14} />
            <span>{t('Contents')}</span>
          </button>
          <button
            className="reader-btn"
            data-active={panel === 'type'}
            onClick={() => setPanel('type')}
            title={t('Typography')}
          >
            <IconType size={14} />
            <span>{t('Layout')}</span>
          </button>
        </div>
      </div>

      <ProgressRail />

      <div className="reader-status">
        <span>{progress.label}</span>
        {progress.minutesLeft !== undefined && (
          <span className="reader-left">{t('~{n} min left', { n: progress.minutesLeft })}</span>
        )}
      </div>

      {panel === 'outline' && <OutlinePanel />}
      {panel === 'type' && <TypePanel onCommit={() => persistReadingOptions(shell)} />}
    </div>
  );
}

/**
 * Traka napretka koja se može vući. Dok se vuče, prikazuje se lokalna
 * vrijednost — inače bi pokazivač poskakivao na svaki `onProgress` iz editora.
 */
function ProgressRail() {
  const fraction = useReading((s) => s.progress.fraction);
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? fraction;

  return (
    <input
      className="reader-rail"
      type="range"
      min={0}
      max={1000}
      step={1}
      value={Math.round(value * 1000)}
      aria-label={t('Reading progress')}
      onChange={(event) => {
        const next = Number(event.target.value) / 1000;
        setDragging(next);
        readerSeek(next);
      }}
      onPointerUp={() => setDragging(null)}
      onBlur={() => setDragging(null)}
    />
  );
}

function OutlinePanel() {
  // Dohvat pri otvaranju, ne pri ulasku u čitanje: PDF svoje oznake učitava
  // asinkrono, pa bi popis snimljen prve sekunde bio prazan.
  const [outline] = useState(readerOutline);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => ref.current?.querySelector('button')?.focus(), []);

  if (outline.length === 0) {
    return (
      <div className="reader-panel" ref={ref}>
        <p className="reader-empty">{t('This document has no table of contents.')}</p>
      </div>
    );
  }

  return (
    <div className="reader-panel reader-outline" ref={ref}>
      {outline.map((entry) => (
        <button key={entry.id} data-depth={entry.depth} onClick={() => readerGoTo(entry.id)}>
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function TypePanel({ onCommit }: { onCommit: () => void }) {
  const options = useReading((s) => s.options);
  const patch = useReading((s) => s.patchOptions);

  const change = (next: Parameters<typeof patch>[0]) => {
    patch(next);
    onCommit();
  };

  return (
    <div className="reader-panel reader-type">
      <label>
        <span>{t('Typeface')}</span>
        <div className="reader-seg">
          {(['serif', 'sans'] as const).map((face) => (
            <button
              key={face}
              data-active={options.typeface === face}
              onClick={() => change({ typeface: face })}
            >
              {face === 'serif' ? t('Serif') : t('Sans')}
            </button>
          ))}
        </div>
      </label>

      <label>
        <span>{t('Size — {n} px', { n: options.fontSize })}</span>
        <input
          type="range"
          min={14}
          max={30}
          step={1}
          value={options.fontSize}
          onChange={(e) => change({ fontSize: Number(e.target.value) })}
        />
      </label>

      <label>
        <span>{t('Line height — {n}', { n: options.lineHeight.toFixed(2) })}</span>
        <input
          type="range"
          min={1.2}
          max={2.2}
          step={0.05}
          value={options.lineHeight}
          onChange={(e) => change({ lineHeight: Number(e.target.value) })}
        />
      </label>

      <label>
        <span>{t('Column width — {n} characters', { n: options.measure })}</span>
        <input
          type="range"
          min={40}
          max={100}
          step={2}
          value={options.measure}
          onChange={(e) => change({ measure: Number(e.target.value) })}
        />
      </label>

      <label>
        <span>{t('Background')}</span>
        <div className="reader-seg">
          {tints().map((tint) => (
            <button
              key={tint.id}
              data-active={options.tint === tint.id}
              onClick={() => change({ tint: tint.id })}
            >
              {tint.label}
            </button>
          ))}
        </div>
      </label>

      <label>
        <span>{t('Flow')}</span>
        <div className="reader-seg">
          {flows().map((flow) => (
            <button
              key={flow.id}
              data-active={options.flow === flow.id}
              onClick={() => change({ flow: flow.id })}
            >
              {flow.label}
            </button>
          ))}
        </div>
      </label>
    </div>
  );
}
