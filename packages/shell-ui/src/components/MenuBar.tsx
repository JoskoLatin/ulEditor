import { useEffect, useRef, useState } from 'react';

import { t } from '@uleditor/i18n';

import { useShell } from '../shell/context.js';
import { useReading } from '../shell/reading.js';
import { buildMenus, menuForLetter, rowForLetter, type Menu, type MenuItem } from '../shell/menus.js';
import { activeInstance, useWorkspace } from '../state/workspace.js';

/**
 * The menu bar: File, Edit, View, Preferences, Help.
 *
 * It exists because a keystroke tells nobody it is there. Everything this
 * program can do was reachable — from the palette, from Ctrl+comma, from a key
 * combination — and all of it was reachable *only* by somebody who already knew.
 * A menu is the one part of an interface that answers "what can this thing do"
 * without being asked a question first.
 *
 * Alt is the way in, the way it has been on Windows for thirty years: tap it and
 * the first menu opens with the letters underlined, or hold it and press the
 * letter directly. The letters are worked out from the headings as translated,
 * so they are Croatian letters in a Croatian interface — see `mnemonicOf`.
 *
 * **AltGr is not Alt.** On a Croatian keyboard the third level of the keys — the
 * one that types @, {, ], € — is AltGr, which Windows reports as Ctrl **and**
 * Alt together. Every reading of Alt here therefore refuses when Ctrl is down.
 * Without that, typing an e-mail address into the find box would open menus.
 */

/** Option types characters on a Mac and no menu bar has ever answered to it. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** The heading with one letter underlined, or plainly, when none was free. */
function Label({ text, mnemonic }: { text: string; mnemonic: number }) {
  if (mnemonic < 0) return <>{text}</>;
  const letters = [...text];
  return (
    <>
      {letters.slice(0, mnemonic).join('')}
      <u>{letters[mnemonic]}</u>
      {letters.slice(mnemonic + 1).join('')}
    </>
  );
}

export function MenuBar() {
  const shell = useShell();
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  /* Windows hides the underlines until somebody reaches for Alt, and so do we:
     five underlined letters in the title bar of a program nobody has pressed
     Alt in is decoration. */
  const [underlined, setUnderlined] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  /* The global key handler captures, so it has to be told to stand back while a
     menu has the keyboard — see `handleKey` in commands.ts. */
  const setMenuOpen = useWorkspace((s) => s.setMenuOpen);
  useEffect(() => {
    setMenuOpen(open !== null);
    return () => setMenuOpen(false);
  }, [open, setMenuOpen]);

  /*
   * Rebuilt on every render rather than remembered. What a row says about
   * itself — whether it can be run, whether it is the theme in use — is true of
   * this moment only, and the render that opens the menu is the moment. Fifty
   * lookups in a Map is not a cost worth a cache that can be stale.
   */
  const menus = buildMenus(shell);

  const close = (returnFocus = true) => {
    setOpen(null);
    setActive(-1);
    setUnderlined(false);
    if (returnFocus) barRef.current?.querySelector<HTMLButtonElement>('[data-open="true"]')?.focus();
  };

  const run = (row: MenuItem) => {
    setOpen(null);
    setActive(-1);
    setUnderlined(false);
    /* The panel the keyboard was in is about to be removed, and focus left on a
       removed element falls to the document body, where no key does anything.
       It goes back to the document — which is where somebody who has just
       chosen from a menu is looking. A command that opens a dialog moves it on
       again from there. */
    activeInstance()?.focus();
    void shell.commands.execute(row.id).catch((err: unknown) => {
      shell.notify.show('error', err instanceof Error ? err.message : String(err));
    });
  };

  /* The focus goes into the panel as it opens, so the arrows and the letters
     reach it rather than whatever was behind. */
  useEffect(() => {
    if (open !== null) dropRef.current?.focus();
  }, [open]);

  /* A click anywhere else closes it — including on the document, which is where
     somebody who opened a menu by accident clicks next. */
  useEffect(() => {
    if (open === null) return;
    const onDown = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /*
   * Alt, in the two ways it is pressed.
   *
   * Tapped on its own it opens the first menu — which is only a tap if nothing
   * else was pressed while it was down, so the flag is cleared by any other
   * key. Held with a letter it opens that menu directly.
   *
   * The listener bubbles rather than captures, so a panel that is already open
   * gets the keystroke first and can stop it: the letters belong to its rows
   * while it is open.
   */
  useEffect(() => {
    if (IS_MAC) return;
    let tapped = false;

    const onKeyDown = (event: KeyboardEvent) => {
      /* The reading room hides the whole frame, this bar with it. Alt there
         opened a menu nobody could see, and left it open behind the reader. */
      if (useReading.getState().active) {
        tapped = false;
        return;
      }
      if (event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        tapped = !event.repeat;
        return;
      }
      tapped = false;

      if (!event.altKey || event.ctrlKey || event.metaKey || [...event.key].length !== 1) return;
      const index = menuForLetter(buildMenus(shell), event.key);
      if (index < 0) return;
      event.preventDefault();
      setUnderlined(true);
      setActive(-1);
      setOpen(index);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt' || !tapped) return;
      tapped = false;
      /* Without this the webview moves the focus to its own chrome, and the
         next arrow key goes somewhere nobody can see. */
      event.preventDefault();
      setUnderlined(true);
      setActive(-1);
      setOpen((current) => (current === null ? 0 : null));
    };

    /* Alt held while the mouse is used is not a tap. Without this, Alt+click
       anywhere in the window opened the File menu the moment Alt came back up. */
    const onMouseDown = () => {
      tapped = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [shell]);

  /** The rows that can be landed on: not a rule, and not out of reach. */
  const reachable = (menu: Menu): MenuItem[] =>
    menu.rows.filter((row): row is MenuItem => row !== 'rule' && row.enabled);

  const step = (menu: Menu, direction: number) => {
    const rows = reachable(menu);
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row.id === activeId(menu));
    const next = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : (current + direction + rows.length) % rows.length;
    setActive(menu.rows.indexOf(rows[next] as MenuItem));
  };

  const activeId = (menu: Menu) => {
    const row = menu.rows[active];
    return row && row !== 'rule' ? row.id : null;
  };

  const onPanelKey = (event: React.KeyboardEvent) => {
    if (open === null) return;
    const menu = menus[open];
    if (!menu) return;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        step(menu, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        step(menu, -1);
        return;
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        setActive(-1);
        setOpen((current) => ((current ?? 0) + direction + menus.length) % menus.length);
        return;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        event.stopPropagation();
        const row = menu.rows[active];
        if (row && row !== 'rule' && row.enabled) run(row);
        return;
      }
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      default:
        break;
    }

    /* A letter runs its row. Ctrl and Alt are somebody else's business — and on
       this keyboard Ctrl+Alt is how the third level of the keys is typed. */
    if (event.ctrlKey || event.metaKey || [...event.key].length !== 1) return;
    const row = rowForLetter(menu, event.key);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    run(row);
  };

  return (
    <div className="menubar" role="menubar" aria-label={t('Menu')} ref={barRef}>
      {menus.map((menu, index) => {
        const isOpen = open === index;
        /* The tick column is reserved only where something can be ticked —
           otherwise every row in every menu starts an indent in from its own
           heading, for the sake of two menus that need it. */
        const marks = menu.rows.some((row) => row !== 'rule' && row.checked !== null);

        return (
          <div className="menu-anchor" key={menu.title}>
            <button
              type="button"
              className="menu-title"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={isOpen}
              data-open={isOpen}
              onMouseDown={(event) => {
                /* On mouse down, not on click: a menu bar that waits for the
                   button to come back up feels a frame late, and a click that
                   started on the heading would first be read as a click outside
                   the panel it is meant to close. */
                event.preventDefault();
                setUnderlined(false);
                setActive(-1);
                setOpen(isOpen ? null : index);
              }}
              onMouseEnter={() => {
                if (open !== null && !isOpen) {
                  setActive(-1);
                  setOpen(index);
                }
              }}
              /* A heading is a button, and a button that answers only to the
                 mouse is a button half the people who reach it cannot press.
                 Tab lands here; Enter, Space and Down all open it, which is
                 what they do on every other menu bar. */
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                setUnderlined(true);
                setActive(-1);
                setOpen(isOpen ? null : index);
              }}
            >
              <Label text={menu.title} mnemonic={underlined ? menu.mnemonic : -1} />
            </button>

            {isOpen ? (
              <div
                className="menu-panel"
                role="menu"
                aria-label={menu.title}
                data-marks={marks}
                tabIndex={-1}
                ref={dropRef}
                onKeyDown={onPanelKey}
              >
                {menu.rows.map((row, position) =>
                  row === 'rule' ? (
                    <div className="menu-rule" role="separator" key={`rule-${position}`} />
                  ) : (
                    <button
                      type="button"
                      className="menu-row"
                      /* A row that is one of a set says so, and says which one
                         is chosen. Drawn it is a tick; spoken it is nothing at
                         all unless the role carries it. */
                      role={row.checked === null ? 'menuitem' : 'menuitemradio'}
                      aria-checked={row.checked === null ? undefined : row.checked}
                      key={row.id}
                      disabled={!row.enabled}
                      data-active={position === active}
                      /* Kept on mouse down like the headings, so the pointer and
                         the keyboard agree about which row is under the hand. */
                      onMouseEnter={() => setActive(position)}
                      onClick={() => run(row)}
                    >
                      {marks ? <span className="menu-mark">{row.checked ? '✓' : ''}</span> : null}
                      <span className="menu-label">
                        <Label text={row.title} mnemonic={row.mnemonic} />
                      </span>
                      {row.keys ? <kbd>{row.keys.join(' ')}</kbd> : null}
                    </button>
                  ),
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
