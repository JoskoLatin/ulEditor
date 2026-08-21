import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { useWorkspace } from '../state/workspace.js';
import { IconSearch } from './Icons.js';

/** Podniz-podudaranje s razmacima: "opfo" pronalazi "Open folder". */
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

  // The commands are read on every open — the `when` conditions depend on state.
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

  // A layout effect, not an ordinary one: the focus has to be set before the
  // browser paints the dialog. With requestAnimationFrame the first typed
  // character sometimes escapes to <body> — rarely enough to be missed in manual
  // testing, often enough to annoy.
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
      <div className="palette" role="dialog" aria-label={t('Command palette')} onKeyDown={onKeyDown}>
        <div className="palette-input">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('Type a command…')}
            aria-label={t('Search commands')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 ? (
            <div className="palette-empty">{t('No matching command.')}</div>
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
