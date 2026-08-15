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

const TINTS: { id: ReadingTint; label: string }[] = [
  { id: 'day', label: 'Dnevno' },
  { id: 'sepia', label: 'Sepija' },
  { id: 'night', label: 'Noć' },
];

const FLOWS: { id: ReadingFlow; label: string }[] = [
  { id: 'paged', label: 'Stranice' },
  { id: 'scroll', label: 'Svitak' },
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
        <button className="reader-btn" onClick={exitReading} title="Izađi iz čitanja (Esc)">
          <IconClose size={14} />
          <span>Izađi</span>
        </button>

        <div className="reader-title">{title}</div>

        <div className="reader-nav">
          <button className="reader-icon" onClick={() => readerPage(-1)} title="Prethodna stranica">
            <IconArrow dir="left" size={14} />
          </button>
          <button className="reader-icon" onClick={() => readerPage(1)} title="Sljedeća stranica">
            <IconArrow dir="right" size={14} />
          </button>
        </div>

        <div className="reader-tools">
          <button
            className="reader-btn"
            data-active={panel === 'outline'}
            onClick={() => setPanel('outline')}
            title="Sadržaj"
          >
            <IconList size={14} />
            <span>Sadržaj</span>
          </button>
          <button
            className="reader-btn"
            data-active={panel === 'type'}
            onClick={() => setPanel('type')}
            title="Tipografija"
          >
            <IconType size={14} />
            <span>Izgled</span>
          </button>
        </div>
      </div>

      <ProgressRail />

      <div className="reader-status">
        <span>{progress.label}</span>
        {progress.minutesLeft !== undefined && (
          <span className="reader-left">još ~{progress.minutesLeft} min</span>
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
      aria-label="Napredak čitanja"
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
        <p className="reader-empty">Ovaj dokument nema sadržaj.</p>
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
        <span>Pismo</span>
        <div className="reader-seg">
          {(['serif', 'sans'] as const).map((face) => (
            <button
              key={face}
              data-active={options.typeface === face}
              onClick={() => change({ typeface: face })}
            >
              {face === 'serif' ? 'Serifno' : 'Bezserifno'}
            </button>
          ))}
        </div>
      </label>

      <label>
        <span>Veličina — {options.fontSize} px</span>
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
        <span>Prored — {options.lineHeight.toFixed(2)}</span>
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
        <span>Širina stupca — {options.measure} znakova</span>
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
        <span>Podloga</span>
        <div className="reader-seg">
          {TINTS.map((tint) => (
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
        <span>Tok</span>
        <div className="reader-seg">
          {FLOWS.map((flow) => (
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
