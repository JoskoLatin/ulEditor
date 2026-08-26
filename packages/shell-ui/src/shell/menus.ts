/**
 * What is under each heading of the menu bar.
 *
 * The menu holds no actions of its own. Every row names a command, and the
 * command is where the title, the shortcut and the question of whether it can
 * be run right now already live — the same entries the palette lists and the
 * same ones the keyboard reaches. A menu carrying its own copy of any of that
 * would be a second answer to a question already answered, and the two would
 * drift on the first change.
 *
 * Rows are **greyed, not removed**, when a command cannot run at this moment.
 * A menu that changes shape has to be read again every time it is opened,
 * because everything below the missing row has moved — the same reason the
 * undo button in the title bar is drawn dim rather than taken away.
 *
 * No DOM and no React here, so the checks drive it directly.
 */

import { LOCALES, t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';

export interface EntryDefinition {
  /** The command's id. A row whose command was never registered is left out. */
  command: string;
  /**
   * For a command whose availability is settled by the build rather than by the
   * moment: the zoom, which on the web is the browser's own and better left to
   * it; the inspector, which exists only in a webview that has one; Exit, which
   * needs a window to close. Those are left out entirely — the argument for
   * greying is that the row will come alive again, and these never will.
   */
  constant?: boolean;
  /** A mark beside the row: the theme in use, the language in use. */
  checked?: (shell: Shell) => boolean;
}

export type EntryOrRule = EntryDefinition | 'rule';

export interface MenuDefinition {
  title: string;
  entries: EntryOrRule[];
}

/**
 * A function rather than a constant, for two reasons that point the same way:
 * `t()` must not be called while a module loads, when the language has not been
 * chosen yet — and the languages themselves come from `LOCALES`, so adding one
 * adds its row here without anybody having to remember to.
 */
export function menuDefinitions(): MenuDefinition[] {
  return [
    {
      title: t('File'),
      entries: [
        { command: 'file.openFolder' },
        { command: 'file.openFiles' },
        { command: 'file.quickOpen' },
        'rule',
        { command: 'file.save' },
        { command: 'file.close' },
        'rule',
        { command: 'file.forgetRecent' },
        'rule',
        { command: 'file.exit', constant: true },
      ],
    },
    {
      title: t('Edit'),
      entries: [
        { command: 'edit.undo' },
        { command: 'edit.redo' },
        'rule',
        { command: 'find.inDocument' },
        { command: 'view.search' },
      ],
    },
    {
      title: t('View'),
      entries: [
        { command: 'view.toggleSidebar' },
        { command: 'view.explorer' },
        { command: 'view.formats' },
        'rule',
        { command: 'view.reading' },
        'rule',
        { command: 'view.splitTab' },
        { command: 'view.focusOtherGroup' },
        'rule',
        { command: 'view.zoomIn', constant: true },
        { command: 'view.zoomOut', constant: true },
        { command: 'view.zoomReset', constant: true },
        'rule',
        { command: 'view.commandPalette' },
        { command: 'view.devtools', constant: true },
      ],
    },
    {
      /*
       * The theme and the language, one click deep and not behind a dialog.
       * Until now they were reachable through Ctrl+comma or by typing their
       * name into the palette — which is to say, reachable by somebody who
       * already knew they were there.
       */
      title: t('Preferences'),
      entries: [
        { command: 'prefs.themeLight', checked: (shell) => shell.theme.preference === 'light' },
        { command: 'prefs.themeDark', checked: (shell) => shell.theme.preference === 'dark' },
        { command: 'prefs.themeSystem', checked: (shell) => shell.theme.preference === 'system' },
        'rule',
        ...LOCALES.map((locale) => ({
          command: `prefs.language.${locale.id}`,
          checked: (shell: Shell) => shell.locale === locale.id,
        })),
        'rule',
        { command: 'view.preferences' },
      ],
    },
    {
      title: t('Help'),
      entries: [
        { command: 'view.formats' },
        'rule',
        { command: 'help.source' },
        { command: 'help.report' },
        'rule',
        { command: 'help.about' },
      ],
    },
  ];
}

/* ── what the bar draws ──────────────────────────────────────────────── */

export interface MenuItem {
  id: string;
  title: string;
  /** Shown at the right of the row; the command owns the binding itself. */
  keys: string[] | null;
  enabled: boolean;
  /** `null` for a row that is not one of a set — most of them. */
  checked: boolean | null;
  /** Index into `title` of the letter that runs this row, or -1. */
  mnemonic: number;
}

export type MenuRow = MenuItem | 'rule';

export interface Menu {
  title: string;
  mnemonic: number;
  rows: MenuRow[];
}

/**
 * The letter that opens a menu, or runs a row.
 *
 * Computed from the text as it will be read, not written down beside it. The
 * headings are translated, so a letter chosen for `File` says nothing about
 * `Datoteka` — and a second list of letters kept in step with the first is how
 * `Prikaz` and `Postavke` would both end up answering to P.
 *
 * `taken` is carried along the list and added to, so each heading gets the
 * first letter still free. Croatian letters work as they stand: a keystroke
 * arrives as the character it produces, and `š` is a key.
 */
export function mnemonicOf(title: string, taken: Set<string>): number {
  const letters = [...title];
  for (let i = 0; i < letters.length; i++) {
    const letter = (letters[i] ?? '').toLowerCase();
    if (!/\p{L}/u.test(letter) || taken.has(letter)) continue;
    taken.add(letter);
    return i;
  }
  return -1;
}

/**
 * Two rules in a row, or one at either end, separate nothing — which is what is
 * left when the commands around one turn out not to exist in this build.
 */
function trimRules(rows: MenuRow[]): MenuRow[] {
  const out: MenuRow[] = [];
  for (const row of rows) {
    if (row === 'rule' && (out.length === 0 || out[out.length - 1] === 'rule')) continue;
    out.push(row);
  }
  while (out.length > 0 && out[out.length - 1] === 'rule') out.pop();
  return out;
}

export function buildMenus(shell: Shell): Menu[] {
  const barLetters = new Set<string>();

  return menuDefinitions().map((definition) => {
    const itemLetters = new Set<string>();
    const rows: MenuRow[] = [];

    for (const entry of definition.entries) {
      if (entry === 'rule') {
        rows.push('rule');
        continue;
      }

      const command = shell.commands.get(entry.command);
      if (!command) continue;

      const available = command.when?.() !== false;
      if (entry.constant && !available) continue;

      rows.push({
        id: command.id,
        title: command.title,
        keys: command.keybinding ?? null,
        enabled: available,
        checked: entry.checked ? entry.checked(shell) : null,
        mnemonic: mnemonicOf(command.title, itemLetters),
      });
    }

    return {
      title: definition.title,
      mnemonic: mnemonicOf(definition.title, barLetters),
      rows: trimRules(rows),
    };
  });
}

/** The row a typed letter means, or nothing. A greyed row does not answer. */
export function rowForLetter(menu: Menu, letter: string): MenuItem | null {
  const wanted = letter.toLowerCase();
  for (const row of menu.rows) {
    if (row === 'rule' || !row.enabled || row.mnemonic < 0) continue;
    if ([...row.title][row.mnemonic]?.toLowerCase() === wanted) return row;
  }
  return null;
}

/** The menu a typed letter opens, by index, or -1. */
export function menuForLetter(menus: Menu[], letter: string): number {
  const wanted = letter.toLowerCase();
  return menus.findIndex(
    (menu) => menu.mnemonic >= 0 && [...menu.title][menu.mnemonic]?.toLowerCase() === wanted,
  );
}
