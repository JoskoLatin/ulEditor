/**
 * The built-in commands and the global keyboard shortcuts.
 *
 * Every action exists as a command before it gets a button — that way everything
 * is reachable from the palette, and the UI stays a thin layer over the same
 * entry point.
 */

import { LOCALES, t } from '@uleditor/i18n';

import type { Shell, ThemePreference } from '../host/index.js';
import { activeInstance, activeTabId, useWorkspace } from '../state/workspace.js';
import {
  closeTab,
  openFiles,
  openFolder,
  openThroughLibreOffice,
  openUri,
  saveActive,
} from './actions.js';
import { chooseLocale, requestExit } from './lifecycle.js';
import { canRead, exitReading, readerPage, toggleReading, useReading } from './reading.js';
import { closeScratch, openScratch, saveScratch, useScratch } from './scratch.js';
import { canZoom, resetZoom, stepZoom, watchZoomGesture } from './zoom.js';
import { clearRecent, hasRecent } from './recent.js';
import { devtoolsAvailable, openDevtools, watchDevtools } from './devtools.js';
import { canUpdate, checkForUpdates, checksOnStart, setChecksOnStart } from './updates.js';

/** Where the program comes from. The Help menu is the only thing that asks. */
const REPOSITORY = 'https://github.com/JoskoLatin/ulEditor';

/**
 * The theme, applied and remembered in one move.
 *
 * Two steps rather than one, and forgetting the second is invisible until the
 * next start — which is exactly the kind of bug that gets reported as "it does
 * not remember anything".
 */
function setTheme(shell: Shell, preference: ThemePreference): void {
  shell.theme.setPreference(preference);
  shell.settings.set('theme', preference);
}

/**
 * Opens a file and puts the cursor on a line in it.
 *
 * `openUri` rather than a direct open, for the reason it exists: a definition
 * is very often **outside every folder that was opened** — the standard
 * library, a crate under `~/.cargo/registry`, a package in `node_modules` — and
 * the desktop sandbox has never been told about those. `openUri` re-adopts the
 * path the way the file picker would, which is the same explicit gesture with
 * a different origin.
 *
 * **And it opens even a file that is already open**, rather than looking for
 * its tab first. A definition arrives as `C:/dev/x.rs` — a path made out of the
 * server's URL — while every tab is named the way the file system hands paths
 * out, `C:\dev\x.rs`. Those are one file and two strings, and comparing them
 * here would mean this function keeping its own opinion about what makes two
 * paths the same. `openUri` goes through the VFS, which resolves, and
 * `openDocument` then finds the tab under the name it gave it — one place
 * deciding, which is the only number of places that ever works.
 *
 * The wait is for the mount. An instance is created asynchronously, and a jump
 * that arrived before it would land in an editor that does not exist yet; the
 * same hundred and twenty milliseconds the search panel waits for the same
 * reason.
 */
async function goToLocation(
  shell: Shell,
  path: string,
  line: number,
  column: number,
): Promise<void> {
  await openUri(shell, path);
  await new Promise((resolve) => setTimeout(resolve, 120));
  activeInstance()?.revealPosition?.(line, column);
}

export function registerCommands(shell: Shell): () => void {
  const store = () => useWorkspace.getState();

  const disposables = [
    shell.commands.register({
      id: 'file.openFolder',
      title: t('Open folder…'),
      category: t('File'),
      keybinding: ['Ctrl', 'K'],
      run: () => openFolder(shell),
    }),
    shell.commands.register({
      id: 'file.openFiles',
      title: t('Open files…'),
      category: t('File'),
      keybinding: ['Ctrl', 'O'],
      run: () => openFiles(shell),
    }),
    shell.commands.register({
      id: 'file.save',
      title: t('Save'),
      category: t('File'),
      keybinding: ['Ctrl', 'S'],
      when: () => activeTabId() !== null,
      run: () => saveActive(shell),
    }),
    shell.commands.register({
      id: 'file.close',
      title: t('Close tab'),
      category: t('File'),
      keybinding: ['Ctrl', 'W'],
      when: () => activeTabId() !== null,
      run: () => {
        const id = activeTabId();
        if (id) void closeTab(shell, id);
      },
    }),

    shell.commands.register({
      id: 'edit.undo',
      title: t('Undo'),
      category: t('Edit'),
      keybinding: ['Ctrl', 'Z'],
      when: () => !!activeInstance(),
      run: () => activeInstance()?.undo(),
    }),
    shell.commands.register({
      id: 'edit.redo',
      title: t('Redo'),
      category: t('Edit'),
      keybinding: ['Ctrl', 'Shift', 'Z'],
      when: () => !!activeInstance(),
      run: () => activeInstance()?.redo(),
    }),

    shell.commands.register({
      id: 'find.inDocument',
      title: t('Find in document'),
      category: t('Edit'),
      keybinding: ['Ctrl', 'Shift', 'F'],
      when: () => !!activeInstance(),
      run: () => store().setFindOpen(true),
    }),

    shell.commands.register({
      id: 'view.toggleSidebar',
      title: t('Toggle side panel'),
      category: t('View'),
      keybinding: ['Ctrl', 'B'],
      run: () => store().setSidebarVisible(!store().sidebarVisible),
    }),
    shell.commands.register({
      id: 'view.explorer',
      title: t('Show file explorer'),
      category: t('View'),
      run: () => store().setSidebarView('explorer'),
    }),
    shell.commands.register({
      id: 'file.quickOpen',
      title: t('Open file by name…'),
      category: t('File'),
      keybinding: ['Ctrl', 'P'],
      run: () => store().setQuickOpen(true),
    }),

    shell.commands.register({
      id: 'view.search',
      title: t('Search in project'),
      category: t('View'),
      keybinding: ['Ctrl', 'Shift', 'H'],
      run: () => store().setSidebarView('search'),
    }),
    shell.commands.register({
      id: 'view.formats',
      title: t('Show supported formats'),
      category: t('View'),
      run: () => store().setSidebarView('formats'),
    }),
    shell.commands.register({
      id: 'view.cycleTheme',
      title: t('Cycle theme (light / dark / system)'),
      category: t('View'),
      run: () => {
        const next = shell.theme.cycle();
        shell.settings.set('theme', next);
      },
    }),

    shell.commands.register({
      id: 'view.reading',
      title: t('Reading mode'),
      category: t('View'),
      keybinding: ['Ctrl', 'Shift', 'R'],
      when: () => canRead() || useReading.getState().active,
      run: () => toggleReading(shell),
    }),

    /*
     * The seam through which a plugin publishes a result that is not a file on
     * disk — the first user is OCR over an image. The editor knows nothing about
     * the panel below, only the name of the command.
     */
    shell.commands.register({
      id: 'scratch.openText',
      title: t('Open text in a split below'),
      category: t('View'),
      when: () => false,
      run: (payload) => {
        const options = payload as { name?: string; text?: string } | undefined;
        if (!options?.text) return;
        return openScratch(shell, { name: options.name ?? t('Untitled'), text: options.text });
      },
    }),
    /*
     * Following a name to where it was defined, in two halves — because the two
     * halves are genuinely different jobs. The editor knows where the cursor is
     * and which server has the file; the shell knows what a tab is. Neither
     * learns the other's half.
     */
    shell.commands.register({
      id: 'edit.goToDefinition',
      title: t('Go to definition'),
      category: t('Edit'),
      keybinding: ['F12'],
      when: () => activeInstance()?.goToDefinition !== undefined,
      run: () => activeInstance()?.goToDefinition?.(),
    }),
    /*
     * A new paragraph. The shell offers it and the editor decides where it goes
     * — it is the editor that knows where the cursor is, and the document's own
     * seam that knows whether this format can take one at all.
     */
    shell.commands.register({
      id: 'edit.insertParagraph',
      title: t('Insert paragraph below'),
      category: t('Edit'),
      keybinding: ['Ctrl', 'Enter'],
      when: () => activeInstance()?.canInsertParagraph?.() === true,
      run: () => activeInstance()?.insertParagraph?.(),
    }),
    /*
     * And taking one away — the same shape, and the same division of labour:
     * the shell asks whether this document could take it at all, and the
     * editor answers where the cursor is and whether that paragraph may go.
     */
    shell.commands.register({
      id: 'edit.removeParagraph',
      title: t('Remove this paragraph'),
      category: t('Edit'),
      keybinding: ['Ctrl', 'Shift', 'Backspace'],
      when: () => activeInstance()?.canRemoveParagraph?.() === true,
      run: () => activeInstance()?.removeParagraph?.(),
    }),
    shell.commands.register({
      id: 'editor.goToLocation',
      title: t('Go to a place in a file'),
      category: t('Edit'),
      /* A seam rather than an action: it is meaningless without somewhere to
         go, so it is never offered in the palette. */
      when: () => false,
      run: (payload) => {
        const target = payload as
          | { path?: string; line?: number; column?: number }
          | undefined;
        if (!target?.path) return;
        return goToLocation(shell, target.path, target.line ?? 1, target.column ?? 1);
      },
    }),
    shell.commands.register({
      id: 'scratch.close',
      title: t('Close the split below'),
      category: t('View'),
      when: () => useScratch.getState().open,
      run: () => closeScratch(shell),
    }),

    /*
     * The zoom is registered as commands too, so it is in the palette and not
     * only under a key combination nobody was told about. On the web these are
     * hidden: the browser's own zoom is already bound to the same keys and does
     * the job better than we could.
     */
    shell.commands.register({
      id: 'view.zoomIn',
      title: t('Zoom in'),
      category: t('View'),
      keybinding: ['Ctrl', '+'],
      when: () => canZoom(shell),
      run: () => void stepZoom(shell, 1),
    }),
    shell.commands.register({
      id: 'view.zoomOut',
      title: t('Zoom out'),
      category: t('View'),
      keybinding: ['Ctrl', '-'],
      when: () => canZoom(shell),
      run: () => void stepZoom(shell, -1),
    }),
    shell.commands.register({
      id: 'view.zoomReset',
      title: t('Reset the interface size'),
      category: t('View'),
      keybinding: ['Ctrl', '0'],
      when: () => canZoom(shell),
      run: () => void resetZoom(shell),
    }),

    /*
     * The split moves the tab rather than copying it. Two live editors over one
     * file would each hold their own unsaved text and one of them would lose —
     * showing one document twice needs the editors to support a second view of
     * one buffer, and none of them do yet.
     */
    shell.commands.register({
      id: 'view.splitTab',
      title: t('Move the tab to the other side'),
      category: t('View'),
      keybinding: ['Ctrl', '\\'],
      when: () => activeTabId() !== null,
      run: () => {
        const id = activeTabId();
        if (id) store().moveTabToOtherGroup(id);
      },
    }),
    shell.commands.register({
      id: 'view.focusOtherGroup',
      title: t('Go to the other side'),
      category: t('View'),
      keybinding: ['Ctrl', '`'],
      when: () => store().tabs.some((tab) => tab.group === 'right'),
      run: () => {
        const state = store();
        state.focusGroup(state.focused === 'left' ? 'right' : 'left');
        activeInstance()?.focus();
      },
    }),

    /* Somewhere to clear it. A list of what you have opened is a small piece of
       history about you, and a program that keeps one owes you a way to say no. */
    shell.commands.register({
      id: 'file.forgetRecent',
      title: t('Forget recently opened files'),
      category: t('File'),
      when: () => hasRecent(shell),
      run: () => {
        clearRecent(shell);
        shell.notify.show('info', t('The list of recent files is empty again.'));
      },
    }),

    /* The way out that asks first — see `requestExit`. The button in the corner
       of the title bar goes through the same function. */
    shell.commands.register({
      id: 'file.exit',
      title: t('Exit'),
      category: t('File'),
      when: () => shell.platform === 'desktop',
      run: () => requestExit(shell),
    }),

    /*
     * The inspector. It opens in a window of its own — WebView2 owns its
     * devtools and offers no way to dock them beside the page; docking is a
     * Chrome feature, not a webview one.
     */
    shell.commands.register({
      id: 'view.devtools',
      title: t('Developer tools'),
      category: t('View'),
      keybinding: ['F12'],
      when: () => devtoolsAvailable,
      run: () => void openDevtools(),
    }),

    shell.commands.register({
      id: 'view.preferences',
      title: t('All preferences…'),
      category: t('Preferences'),
      keybinding: ['Ctrl', ','],
      run: () => store().setPreferencesOpen(true),
    }),

    /*
     * The palette as a command of its own, so it has a row in the menu. Its
     * keystroke has always worked and told nobody it existed; the one route
     * into everything this program can do should not itself be the thing you
     * have to already know.
     */
    shell.commands.register({
      id: 'view.commandPalette',
      title: t('Command palette'),
      category: t('View'),
      keybinding: ['Ctrl', 'Shift', 'P'],
      run: () => store().setPaletteOpen(true),
    }),

    /*
     * The theme, spelled out rather than cycled. `view.cycleTheme` stays for the
     * button in the activity bar, where one press and one icon is the whole
     * interaction — but a menu that offers "cycle" makes the reader work out
     * which of three states they are in and how many presses away the one they
     * want is.
     */
    shell.commands.register({
      id: 'prefs.themeLight',
      title: t('Light'),
      category: t('Theme'),
      run: () => setTheme(shell, 'light'),
    }),
    shell.commands.register({
      id: 'prefs.themeDark',
      title: t('Dark'),
      category: t('Theme'),
      run: () => setTheme(shell, 'dark'),
    }),
    shell.commands.register({
      id: 'prefs.themeSystem',
      title: t('Follow system'),
      category: t('Theme'),
      run: () => setTheme(shell, 'system'),
    }),

    /*
     * One command per language, from the same list the settings panel reads.
     * The title is the language's own name and is not translated: `Hrvatski` is
     * what somebody looking for Croatian is looking for, whatever language the
     * interface is currently in — which, if they are looking, is one they cannot
     * read.
     */
    ...LOCALES.map((locale) =>
      shell.commands.register({
        id: `prefs.language.${locale.id}`,
        title: locale.native,
        category: t('Language'),
        run: () => chooseLocale(shell, locale.id),
      }),
    ),

    shell.commands.register({
      id: 'help.source',
      title: t('Source code'),
      category: t('Help'),
      when: () => !!shell.openExternal,
      run: () => shell.openExternal?.(REPOSITORY),
    }),
    shell.commands.register({
      id: 'help.report',
      title: t('Report a problem'),
      category: t('Help'),
      when: () => !!shell.openExternal,
      run: () => shell.openExternal?.(`${REPOSITORY}/issues`),
    }),
    /* The updater, where a person can find it. Both rows are hidden in the web
       build rather than shown and refused: a browser tab does not update
       itself, and offering to would be a promise made to the wrong platform. */
    /*
     * The conversion, as a command, because the editor that needs it must not
     * have to know what a shell is. `editor-vector` draws a button that runs
     * this — the same seam OCR uses to publish its result.
     */
    shell.commands.register({
      id: 'convert.openAsPdf',
      title: t('Open through LibreOffice'),
      category: t('File'),
      run: (uri) => {
        const target = typeof uri === 'string' ? uri : useWorkspace.getState().tabs.find((tab) => tab.id === activeTabId())?.uri;
        if (target) void openThroughLibreOffice(shell, target);
      },
    }),

    shell.commands.register({
      id: 'help.updates',
      title: t('Check for updates…'),
      category: t('Help'),
      when: () => canUpdate(shell),
      run: () => void checkForUpdates(shell),
    }),
    shell.commands.register({
      id: 'help.updatesOnStart',
      title: t('Check for updates on start'),
      category: t('Help'),
      when: () => canUpdate(shell),
      run: () => setChecksOnStart(shell, !checksOnStart(shell)),
    }),

    shell.commands.register({
      id: 'help.about',
      title: t('About ulEditor'),
      category: t('Help'),
      run: () => store().setAboutOpen(true),
    }),

    shell.commands.register({
      id: 'nav.nextTab',
      title: t('Next tab'),
      category: t('Navigation'),
      keybinding: ['Ctrl', 'Tab'],
      when: () => tabsInFocusedGroup() > 1,
      run: () => cycleTab(1),
    }),
    shell.commands.register({
      id: 'nav.prevTab',
      title: t('Previous tab'),
      category: t('Navigation'),
      keybinding: ['Ctrl', 'Shift', 'Tab'],
      when: () => tabsInFocusedGroup() > 1,
      run: () => cycleTab(-1),
    }),
  ];

  const onKeyDown = (event: KeyboardEvent) => handleKey(shell, event);
  window.addEventListener('keydown', onKeyDown, { capture: true });
  const stopZoomGesture = watchZoomGesture(shell);
  watchDevtools(shell);

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    stopZoomGesture();
    for (const d of disposables) d.dispose();
  };
}

function tabsInFocusedGroup(): number {
  const state = useWorkspace.getState();
  return state.tabs.filter((tab) => tab.group === state.focused).length;
}

/** Within one group. Ctrl+Tab crossing to the other side would be a way of
 *  losing the document you were reading, not a way of reaching it. */
function cycleTab(direction: number): void {
  const state = useWorkspace.getState();
  const inGroup = state.tabs.filter((tab) => tab.group === state.focused);
  if (inGroup.length < 2) return;
  const index = inGroup.findIndex((tab) => tab.id === activeTabId());
  const next = inGroup[(index + direction + inGroup.length) % inGroup.length];
  if (next) state.activateTab(next.id);
}

/**
 * The global shortcuts. A deliberately short list: anything an editor binds itself
 * (Ctrl+F in CodeMirror, Ctrl+Z inside text) is not intercepted here.
 */
function handleKey(shell: Shell, event: KeyboardEvent): void {
  const store = useWorkspace.getState();
  const key = event.key.toLowerCase();

  const target = event.target as HTMLElement | null;
  const inTextField =
    target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

  /*
   * A menu has the keyboard while it is open, and this handler captures — it
   * runs before the panel does. Without this, Escape out of a menu also left
   * reading mode or closed the find panel in the same keystroke, and a letter
   * meant for a row reached a shortcut instead.
   */
  if (store.menuOpen && !store.paletteOpen) return;

  // Escape closes search wherever the focus is — the panel, the editor or a tab.
  // Binding it to the panel alone means Escape from the editor does nothing,
  // which is exactly where it is pressed from most often.
  if (event.key === 'Escape' && store.findOpen && !store.paletteOpen) {
    event.preventDefault();
    store.setFindOpen(false);
    activeInstance()?.focus();
    return;
  }

  // Reading mode is left with the same key everything else is left with.
  if (event.key === 'Escape' && useReading.getState().active && !store.paletteOpen) {
    event.preventDefault();
    exitReading();
    return;
  }

  /*
   * F12 carries no modifier, so it is read before the guard below sends every
   * unmodified key away.
   *
   * **It follows a name where an editor can follow one, and opens the developer
   * tools where none can.** Those are the two things F12 means — the second in
   * a browser, the first in every code editor — and this program is a code
   * editor that happens to be drawn in a browser. Nothing is lost by preferring
   * the editor: `Ctrl+Shift+I` below is the developer tools either way, and
   * over a PDF, a picture or the welcome screen there is no name to follow and
   * F12 does exactly what it always did.
   */
  if (event.key === 'F12') {
    const instance = activeInstance();
    if (instance?.goToDefinition) {
      event.preventDefault();
      instance.goToDefinition();
      return;
    }
    if (devtoolsAvailable) {
      event.preventDefault();
      void openDevtools();
      return;
    }
  }

  const mod = event.ctrlKey || event.metaKey;

  // Turning pages without a modifier works when the focus is on the reading bar
  // too, not only on the text — otherwise every button click would need the focus
  // restored by hand.
  if (!mod && useReading.getState().active && !inTextField) {
    const forward = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
    const back = ['ArrowLeft', 'ArrowUp', 'PageUp'];
    if (forward.includes(event.key)) {
      event.preventDefault();
      readerPage(event.shiftKey && event.key === ' ' ? -1 : 1);
      return;
    }
    if (back.includes(event.key)) {
      event.preventDefault();
      readerPage(-1);
      return;
    }
  }

  if (!mod) return;

  /*
   * AltGr is not Ctrl, whatever Windows reports.
   *
   * On a Croatian keyboard the third level of the keys is AltGr, and Windows
   * sends it as Ctrl **and** Alt together — so every shortcut below was reading
   * a keystroke meant to type a character. The switch matches on the character
   * produced, which hides most of the damage: AltGr+W gives `|`, AltGr+F gives
   * `[`, and neither is bound. Two are. AltGr+Q gives a backslash, which is
   * bound to moving the tab to the other side, and AltGr+7 gives a backtick,
   * which is bound to jumping to it — so typing a Windows path or opening a
   * Markdown code fence split the workspace instead, and the character never
   * arrived.
   *
   * Nothing in this program binds Ctrl+Alt or Cmd+Option, so there is nothing
   * to lose by refusing the combination outright. It sits below the reading-mode
   * branch above deliberately: that one asks for no modifier at all.
   */
  if (event.altKey) return;

  /*
   * Zoom, and before the Shift branch below rather than among the plain Ctrl
   * cases. The same keystroke arrives spelled several ways: on most layouts
   * Ctrl+plus is physically Ctrl+Shift+`=`, which the browser reports as `+`
   * with shiftKey set. Down among the unshifted cases it would never be
   * reached, and plus is the one people press.
   */
  if (canZoom(shell) && ['=', '+', '-', '_', '0'].includes(key)) {
    event.preventDefault();
    if (key === '0') void resetZoom(shell);
    else void stepZoom(shell, key === '-' || key === '_' ? -1 : 1);
    return;
  }

  // Ctrl+Shift+P — the palette. It works with the focus inside an editor too.
  if (event.shiftKey && key === 'p') {
    event.preventDefault();
    store.setPaletteOpen(!store.paletteOpen);
    return;
  }

  // Inside an input field (e.g. the text of a PDF note) Ctrl+Z must remain the
  // browser's text undo, not the editor's undo.
  if (event.shiftKey) {
    if (key === 'r') {
      event.preventDefault();
      toggleReading(shell);
      return;
    }
    if (key === 'i' && devtoolsAvailable) {
      event.preventDefault();
      void openDevtools();
      return;
    }
    // Ctrl+Shift+H — project-wide search. Ctrl+Shift+F stays with the document.
    if (key === 'h') {
      event.preventDefault();
      store.setSidebarView('search');
      return;
    }

    if (key === 'tab') {
      event.preventDefault();
      cycleTab(-1);
    }
    /*
     * Ctrl+Shift+Backspace — the paragraph the cursor is in, taken away.
     *
     * Registered keybindings are drawn, not dispatched — the menu and the
     * palette read them, and this hand-written handler is what actually fires
     * — so an entry here is what makes the chord live at all. Deliberately not
     * guarded by `inTextField`: the caret is inside the very paragraph being
     * removed, which is exactly where a person stands when they want it gone,
     * and the same reasoning Ctrl+Enter is allowed for. Chromium does nothing
     * with this chord inside a `contenteditable`, measured, so nothing is
     * taken from the browser; an editor that cannot remove a paragraph lets it
     * through untouched.
     */
    if (key === 'backspace' && activeInstance()?.canRemoveParagraph?.()) {
      event.preventDefault();
      activeInstance()?.removeParagraph?.();
      return;
    }
    if (key === 'z' && !inTextField && activeInstance()) {
      event.preventDefault();
      activeInstance()?.redo();
    }
    // Ctrl+Shift+F — the search that works across all formats, PDF included.
    // Ctrl+F stays with CodeMirror, which offers replace alongside search.
    if (key === 'f' && activeInstance()) {
      event.preventDefault();
      store.setFindOpen(true);
    }
    return;
  }

  switch (key) {
    /*
     * Ctrl+Enter — a paragraph after the one the cursor is in, from wherever
     * the cursor is, typing or not.
     *
     * Plain Enter is the editor's own, and only while typing: there it splits
     * the paragraph at the caret or begins a new one at its end, and it needs
     * the caret's place in the text to do either — which no handler up here
     * has. Deliberately allowed to fire with the focus inside the text being
     * typed, because that is precisely where a person stands when they want
     * the next paragraph. An editor that cannot take one lets the key through
     * untouched rather than swallowing it.
     */
    case 'enter':
      if (activeInstance()?.canInsertParagraph?.()) {
        event.preventDefault();
        activeInstance()?.insertParagraph?.();
      }
      break;
    case 's':
      event.preventDefault();
      // Focus inside the panel below means it is what gets saved, not the tab above.
      if (target?.closest('.split')) void saveScratch(shell);
      else void saveActive(shell);
      break;
    case 'o':
      event.preventDefault();
      void openFiles(shell);
      break;
    case 'k':
      event.preventDefault();
      void openFolder(shell);
      break;
    case 'b':
      event.preventDefault();
      store.setSidebarVisible(!store.sidebarVisible);
      break;
    case 'w': {
      event.preventDefault();
      const id = activeTabId();
      if (id) void closeTab(shell, id);
      break;
    }
    case 'tab':
      event.preventDefault();
      cycleTab(1);
      break;
    case '\\': {
      event.preventDefault();
      const id = activeTabId();
      if (id) store.moveTabToOtherGroup(id);
      break;
    }
    case '`': {
      event.preventDefault();
      if (store.tabs.some((tab) => tab.group === 'right')) {
        store.focusGroup(store.focused === 'left' ? 'right' : 'left');
        activeInstance()?.focus();
      }
      break;
    }
    case ',':
      event.preventDefault();
      store.setPreferencesOpen(!store.preferencesOpen);
      break;
    case 'p':
      event.preventDefault();
      store.setQuickOpen(!store.quickOpen);
      break;
    case 'z':
      // The same route for every format: the editor decides what a step back is.
      // For code that lands in CodeMirror's history, for PDF in the annotation
      // stack.
      if (!inTextField && activeInstance()) {
        event.preventDefault();
        activeInstance()?.undo();
      }
      break;
    case 'y':
      if (!inTextField && activeInstance()) {
        event.preventDefault();
        activeInstance()?.redo();
      }
      break;
    default:
      break;
  }
}
