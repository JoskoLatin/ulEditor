import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '@uleditor/plugin-sdk';

import { useShell } from '../shell/context.js';
import { useWorkspace } from '../state/workspace.js';
import { IconSearch } from './Icons.js';

/** Podniz-podudaranje s razmacima: "otvm" pronalazi "Otvori mapu". */
function fuzzy(text: string, query: string): number[] | null {
  if (!query) return [];
  const lower = text.toLowerCase();
  const positions: number[] = [];
  let cursor = 0;

  for (const char of query.toLowerCase()) {
    if (char === ' ') continue;
    const index = lower.indexOf(char, cursor);
    if (index === -1) return null;
    positions.push(index);
    cursor = index + 1;
  }
  return positions;
}

/** Ocjena: raniji pogoci i uzastopni nizovi znakova su bolji. */
function score(positions: number[]): number {
  if (positions.length === 0) return 0;
  let value = -(positions[0] ?? 0);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === (positions[i - 1] ?? 0) + 1) value += 4;
  }
  return value;
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <span>{text}</span>;
  const marked = new Set(positions);
  return (
    <span>
      {[...text].map((char, index) =>
        marked.has(index) ? <mark key={index}>{char}</mark> : <span key={index}>{char}</span>,
      )}
    </span>
  );
}

export function CommandPalette() {
  const shell = useShell();
  const open = useWorkspace((s) => s.paletteOpen);
  const setOpen = useWorkspace((s) => s.setPaletteOpen);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Naredbe se čitaju pri svakom otvaranju — `when` uvjeti ovise o stanju.
  const commands = useMemo(() => (open ? shell.commands.all() : []), [open, shell]);

  const matches = useMemo(() => {
    const rows: { command: Command; positions: number[]; score: number }[] = [];
    for (const command of commands) {
      const label = command.category ? `${command.category}: ${command.title}` : command.title;
      const positions = fuzzy(label, query);
      if (!positions) continue;
      rows.push({ command, positions, score: score(positions) });
    }
    if (query) rows.sort((a, b) => b.score - a.score);
    return rows;
  }, [commands, query]);

  // Layout effect, ne obični: fokus mora biti postavljen prije nego preglednik
  // iscrta okvir. S requestAnimationFrame prvi otipkani znak zna pobjeći na
  // <body> — dovoljno rijetko da se u ručnom testiranju previdi, dovoljno
  // često da smeta.
  useLayoutEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const run = (command: Command) => {
    setOpen(false);
    void shell.commands.execute(command.id).catch((err: unknown) => {
      shell.notify.show('error', err instanceof Error ? err.message : String(err));
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setSelected((i) => (matches.length ? (i + 1) % matches.length : 0));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelected((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
        break;
      case 'Enter': {
        event.preventDefault();
        const match = matches[selected];
        if (match) run(match.command);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="palette" role="dialog" aria-label="Paleta naredbi" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Upiši naredbu…"
            aria-label="Pretraži naredbe"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 ? (
            <div className="palette-empty">Nema naredbe koja odgovara.</div>
          ) : (
            matches.map(({ command, positions }, index) => {
              const label = command.category ? `${command.category}: ${command.title}` : command.title;
              return (
                <button
                  key={command.id}
                  className="palette-item"
                  data-active={index === selected}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => run(command)}
                >
                  <Highlighted text={label} positions={positions} />
                  {command.keybinding && <span className="hint">{command.keybinding.join(' ')}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
