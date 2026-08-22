/**
 * The built-in commands and the global keyboard shortcuts.
 *
 * Every action exists as a command before it gets a button — that way everything
 * is reachable from the palette, and the UI stays a thin layer over the same
 * entry point.
 */

import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { activeInstance, activeTabId, useWorkspace } from '../state/workspace.js';
import { closeTab, openFiles, openFolder, saveActive } from './actions.js';
import { canRead, exitReading, readerPage, toggleReading, useReading } from './reading.js';
import { closeScratch, openScratch, saveScratch, useScratch } from './scratch.js';
import { canZoom, resetZoom, stepZoom, watchZoomGesture } from './zoom.js';
import { clearRecent, hasRecent } from './recent.js';

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

    shell.commands.register({
      id: 'view.preferences',
      title: t('Preferences…'),
      category: t('View'),
      keybinding: ['Ctrl', ','],
      run: () => store().setPreferencesOpen(true),
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
