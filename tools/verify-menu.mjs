/**
 * The menu bar's contents, checked without a browser.
 *
 * Two different things can go wrong here and only one of them is visible. A
 * menu that draws badly is noticed the first time it is opened; a menu whose
 * row names a command that has since been renamed simply has one fewer row,
 * and nobody counts the rows. So the agreement between `menus.ts` and
 * `commands.ts` is checked as text — every id the menu asks for is an id the
 * commands register — and the drawing rules are checked against a small
 * registry made here, where the awkward cases can be arranged on purpose.
 *
 * The Alt keys themselves need a real keyboard and live in verify-ui.mjs.
 *
 *   node tools/verify-menu.mjs
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildMenus, menuDefinitions, menuForLetter, mnemonicOf, rowForLetter } = await import(
  pathToFileURL(resolve(ROOT, 'packages/shell-ui/src/shell/menus.ts')).href
);
const { LOCALES, setLocale } = await import(
  pathToFileURL(resolve(ROOT, 'packages/i18n/src/index.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── the menu and the commands name the same things ──────────────────── */

/*
 * The one check that catches the failure nobody sees. A row whose command is
 * not registered is left out on purpose — that is how the zoom stays off the
 * web build — which means a typo and a deliberate absence look exactly alike
 * from the outside.
 */
const source = await readFile(resolve(ROOT, 'packages/shell-ui/src/shell/commands.ts'), 'utf8');
const registered = new Set([...source.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]));

/* The languages are registered in a loop, one command per language, so their
   ids are not in the source as literals. */
if (source.includes('id: `prefs.language.${locale.id}`')) {
  for (const locale of LOCALES) registered.add(`prefs.language.${locale.id}`);
}

const wanted = menuDefinitions().flatMap((menu) =>
  menu.entries.filter((entry) => entry !== 'rule').map((entry) => entry.command),
);
const orphans = wanted.filter((id) => !registered.has(id));

check(
  'every row of the menu names a command that is registered',
  orphans.length === 0,
  orphans.length ? orphans.join(', ') : `${wanted.length} rows, ${registered.size} commands`,
);
check(
  'and the languages are among them',
  LOCALES.every((locale) => wanted.includes(`prefs.language.${locale.id}`)),
  LOCALES.map((l) => l.id).join(', '),
);

/* ── a registry to draw against ──────────────────────────────────────── */

/**
 * A command registry with the awkward cases in it: one that cannot run now,
 * one that this build does not have at all, and two that share a first letter.
 */
function fakeShell({ savable = true, zoom = true, theme = 'dark', locale = 'en' } = {}) {
  const commands = new Map();
  const add = (id, title, extra = {}) => commands.set(id, { id, title, ...extra });

  add('file.openFolder', 'Open folder…', { keybinding: ['Ctrl', 'K'] });
  add('file.openFiles', 'Open files…');
  add('file.quickOpen', 'Open file by name…');
  add('file.save', 'Save', { keybinding: ['Ctrl', 'S'], when: () => savable });
  add('file.close', 'Close tab', { when: () => savable });
  add('file.forgetRecent', 'Forget recently opened files');
  add('file.exit', 'Exit', { when: () => true });
  add('edit.undo', 'Undo');
  add('edit.redo', 'Redo');
  add('find.inDocument', 'Find in document');
  add('view.search', 'Search in project');
  add('view.toggleSidebar', 'Toggle side panel');
  add('view.explorer', 'Show file explorer');
  add('view.formats', 'Show supported formats');
  add('view.reading', 'Reading mode');
  add('view.splitTab', 'Move the tab to the other side');
  add('view.focusOtherGroup', 'Go to the other side');
  add('view.commandPalette', 'Command palette');
  add('view.preferences', 'All preferences…');
  add('prefs.themeLight', 'Light');
  add('prefs.themeDark', 'Dark');
  add('prefs.themeSystem', 'Follow system');
  for (const entry of LOCALES) add(`prefs.language.${entry.id}`, entry.native);
  add('help.source', 'Source code');
  add('help.report', 'Report a problem');
  add('help.about', 'About ulEditor');

  /* The zoom and the inspector are the "not in this build" case: registered
     with a `when` that never comes true, and marked `constant` in the menu. */
  if (zoom) {
    add('view.zoomIn', 'Zoom in', { keybinding: ['Ctrl', '+'] });
    add('view.zoomOut', 'Zoom out');
    add('view.zoomReset', 'Reset the interface size');
  } else {
    add('view.zoomIn', 'Zoom in', { when: () => false });
    add('view.zoomOut', 'Zoom out', { when: () => false });
    add('view.zoomReset', 'Reset the interface size', { when: () => false });
  }

  return {
    platform: 'desktop',
    locale,
    theme: { preference: theme },
    commands: { get: (id) => commands.get(id) },
  };
}

const shell = fakeShell();
const menus = buildMenus(shell);
const byTitle = (title) => menus.find((menu) => menu.title === title);
const rowsOf = (menu) => menu.rows.filter((row) => row !== 'rule');
const idsOf = (menu) => rowsOf(menu).map((row) => row.id);

check('the bar has its five headings', menus.length === 5, menus.map((m) => m.title).join(' · '));

/* ── greyed, not removed ─────────────────────────────────────────────── */

/*
 * The rule that makes a menu readable: what cannot be done right now keeps its
 * place. A list that shortens itself moves everything below the gap, and the
 * fourth row is somewhere else every time it is opened.
 */
{
  const withDocument = idsOf(byTitle('File'));
  const empty = buildMenus(fakeShell({ savable: false }));
  const withNothingOpen = idsOf(empty.find((menu) => menu.title === 'File'));

  check(
    'a command that cannot run now still has its row',
    withDocument.join() === withNothingOpen.join(),
    withNothingOpen.join(', '),
  );
  check(
    'and the row is out of reach rather than gone',
    rowsOf(empty.find((menu) => menu.title === 'File')).find((row) => row.id === 'file.save')
      ?.enabled === false,
  );
}

/*
 * The other half of the same rule. The zoom on the web is not "not now", it is
 * "not here" — the browser's own zoom is already on those keys — so it is left
 * out, and the rule that separated it goes with it rather than leaving a line
 * across an empty stretch of menu.
 */
{
  const web = buildMenus(fakeShell({ zoom: false })).find((menu) => menu.title === 'View');
  check(
    'what the build does not have is left out entirely',
    !idsOf(web).includes('view.zoomIn'),
    idsOf(web).join(', '),
  );
  check(
    'and the rule that separated it does not stay behind',
    !web.rows.some((row, i) => row === 'rule' && web.rows[i + 1] === 'rule'),
    JSON.stringify(web.rows.map((row) => (row === 'rule' ? '—' : row.id))),
  );
  check(
    'no menu begins or ends with a rule',
    buildMenus(fakeShell({ zoom: false })).every(
      (menu) => menu.rows[0] !== 'rule' && menu.rows[menu.rows.length - 1] !== 'rule',
    ),
  );
}

/* ── the tick ────────────────────────────────────────────────────────── */

{
  const prefs = byTitle('Preferences');
  const marked = rowsOf(prefs).filter((row) => row.checked === true);
  const themes = marked.filter((row) => row.id.startsWith('prefs.theme'));
  check(
    'the theme in use is ticked, and no other theme is',
    themes.length === 1 && themes[0]?.id === 'prefs.themeDark',
    marked.map((row) => row.id).join(', '),
  );
  check(
    'the language in use is ticked too, and it is the only one',
    marked.filter((row) => row.id.startsWith('prefs.language')).length === 1 &&
      marked.some((row) => row.id === 'prefs.language.en'),
    marked.map((row) => row.id).join(', '),
  );
  check(
    'a row that is not one of a set is not ticked either way',
    rowsOf(byTitle('File')).every((row) => row.checked === null),
  );

  const croatian = buildMenus(fakeShell({ locale: 'hr', theme: 'light' })).find(
    (menu) => menu.title === 'Preferences',
  );
  check(
    'and the tick follows the setting rather than remembering the first answer',
    rowsOf(croatian).filter((row) => row.checked === true).map((row) => row.id).sort().join() ===
      'prefs.language.hr,prefs.themeLight',
    rowsOf(croatian).filter((row) => row.checked).map((row) => row.id).join(', '),
  );
}

/* ── the letters ─────────────────────────────────────────────────────── */

check(
  'every heading has a letter, and no two share one',
  new Set(menus.map((menu) => menu.title[menu.mnemonic]?.toLowerCase())).size === menus.length &&
    menus.every((menu) => menu.mnemonic >= 0),
  menus.map((menu) => `${menu.title}=${menu.title[menu.mnemonic]}`).join(' '),
);

/* In English nothing collides, and each heading keeps the letter anybody who
   has used Windows already expects: F, E, V, P, H. The collisions are Croatian,
   and they are further down. */
check(
  'in English every heading keeps its first letter',
  menus.every((menu) => menu.mnemonic === 0),
  menus.map((menu) => menu.title[menu.mnemonic]).join(''),
);

{
  const view = byTitle('View');
  const letters = rowsOf(view)
    .filter((row) => row.mnemonic >= 0)
    .map((row) => row.title[row.mnemonic].toLowerCase());
  check(
    'inside one menu no two rows answer to the same letter',
    new Set(letters).size === letters.length,
    letters.join(''),
  );
}

check('a letter finds its heading', menuForLetter(menus, 'v') === menus.indexOf(byTitle('View')));
check('and an unused letter finds nothing', menuForLetter(menus, 'q') === -1);

check(
  'a letter runs the row it underlines',
  rowForLetter(byTitle('File'), 'o')?.id === 'file.openFolder',
  rowForLetter(byTitle('File'), 'o')?.id,
);

/*
 * A row nobody can press does not answer to its letter either. Otherwise Alt,
 * F, S on an empty window would look like it had saved something.
 */
{
  const empty = buildMenus(fakeShell({ savable: false })).find((menu) => menu.title === 'File');
  check('a greyed row does not answer to its letter', rowForLetter(empty, 's') === null);
}

/*
 * Mnemonics are computed, never written down, because the headings are
 * translated and a letter chosen for `File` says nothing about `Datoteka`.
 * This is the case that made it worth computing: in Croatian, `Prikaz` and
 * `Postavke` and `Pomoć` all begin with P.
 */
{
  const taken = new Set();
  const letters = ['Datoteka', 'Uređivanje', 'Prikaz', 'Postavke', 'Pomoć'].map((title) => {
    const at = mnemonicOf(title, taken);
    return `${title}=${[...title][at]}`;
  });
  check(
    'three Croatian headings beginning with P get three different letters',
    taken.size === 5,
    letters.join(' '),
  );
}

{
  setLocale('hr');
  const hr = buildMenus(fakeShell({ locale: 'hr' }));
  check(
    'and the bar built in Croatian is Croatian',
    hr[0]?.title === 'Datoteka' && hr[4]?.title === 'Pomoć',
    hr.map((menu) => menu.title).join(' · '),
  );
  check(
    'with letters of its own, all different',
    new Set(hr.map((menu) => [...menu.title][menu.mnemonic]?.toLowerCase())).size === hr.length,
    hr.map((menu) => `${menu.title}=${[...menu.title][menu.mnemonic]}`).join(' '),
  );
  setLocale('en');
}

/* ── the shortcut a row shows is the command's own ────────────────────── */

check(
  'a row shows the keys the command carries',
  rowsOf(byTitle('File')).find((row) => row.id === 'file.save')?.keys?.join(' ') === 'Ctrl S',
);
check(
  'and a command with no binding shows nothing',
  rowsOf(byTitle('File')).find((row) => row.id === 'file.openFiles')?.keys === null,
);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
