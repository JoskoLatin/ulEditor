/**
 * Ugrađene naredbe i globalne tipkovne kratice.
 *
 * Svaka radnja postoji kao naredba prije nego dobije gumb — tako je sve
 * dostupno iz palete, a UI ostaje tanak sloj nad istim ulazom.
 */

import type { Shell } from '../host/index.js';
import { activeInstance, useWorkspace } from '../state/workspace.js';
import { closeTab, openFiles, openFolder, saveActive } from './actions.js';
import { canRead, exitReading, readerPage, toggleReading, useReading } from './reading.js';

export function registerCommands(shell: Shell): () => void {
  const store = () => useWorkspace.getState();

  const disposables = [
    shell.commands.register({
      id: 'file.openFolder',
      title: 'Otvori mapu…',
      category: 'Datoteka',
      keybinding: ['Ctrl', 'K'],
      run: () => openFolder(shell),
    }),
    shell.commands.register({
      id: 'file.openFiles',
      title: 'Otvori datoteke…',
      category: 'Datoteka',
      keybinding: ['Ctrl', 'O'],
      run: () => openFiles(shell),
    }),
    shell.commands.register({
      id: 'file.save',
      title: 'Spremi',
      category: 'Datoteka',
      keybinding: ['Ctrl', 'S'],
      when: () => store().activeTabId !== null,
      run: () => saveActive(shell),
    }),
    shell.commands.register({
      id: 'file.close',
      title: 'Zatvori karticu',
      category: 'Datoteka',
      keybinding: ['Ctrl', 'W'],
      when: () => store().activeTabId !== null,
      run: () => {
        const id = store().activeTabId;
        if (id) void closeTab(shell, id);
      },
    }),

    shell.commands.register({
      id: 'edit.undo',
      title: 'Poništi',
      category: 'Uređivanje',
      keybinding: ['Ctrl', 'Z'],
      when: () => !!activeInstance(),
      run: () => activeInstance()?.undo(),
    }),
    shell.commands.register({
      id: 'edit.redo',
      title: 'Ponovi',
      category: 'Uređivanje',
      keybinding: ['Ctrl', 'Shift', 'Z'],
      when: () => !!activeInstance(),
      run: () => activeInstance()?.redo(),
    }),

    shell.commands.register({
      id: 'find.inDocument',
      title: 'Traži u dokumentu',
      category: 'Uređivanje',
      keybinding: ['Ctrl', 'Shift', 'F'],
      when: () => !!activeInstance(),
      run: () => store().setFindOpen(true),
    }),

    shell.commands.register({
      id: 'view.toggleSidebar',
      title: 'Prikaži/sakrij bočnu ploču',
      category: 'Prikaz',
      keybinding: ['Ctrl', 'B'],
      run: () => store().setSidebarVisible(!store().sidebarVisible),
    }),
    shell.commands.register({
      id: 'view.explorer',
      title: 'Prikaži istraživač datoteka',
      category: 'Prikaz',
      run: () => store().setSidebarView('explorer'),
    }),
    shell.commands.register({
      id: 'view.formats',
      title: 'Prikaži podržane formate',
      category: 'Prikaz',
      run: () => store().setSidebarView('formats'),
    }),
    shell.commands.register({
      id: 'view.cycleTheme',
      title: 'Promijeni temu (svijetla / tamna / sistemska)',
      category: 'Prikaz',
      run: () => {
        const next = shell.theme.cycle();
        shell.settings.set('theme', next);
      },
    }),

    shell.commands.register({
      id: 'view.reading',
      title: 'Način čitanja',
      category: 'Prikaz',
      keybinding: ['Ctrl', 'Shift', 'R'],
      when: () => canRead() || useReading.getState().active,
      run: () => toggleReading(shell),
    }),

    shell.commands.register({
      id: 'nav.nextTab',
      title: 'Sljedeća kartica',
      category: 'Navigacija',
      keybinding: ['Ctrl', 'Tab'],
      when: () => store().tabs.length > 1,
      run: () => cycleTab(1),
    }),
    shell.commands.register({
      id: 'nav.prevTab',
      title: 'Prethodna kartica',
      category: 'Navigacija',
      keybinding: ['Ctrl', 'Shift', 'Tab'],
      when: () => store().tabs.length > 1,
      run: () => cycleTab(-1),
    }),
  ];

  const onKeyDown = (event: KeyboardEvent) => handleKey(shell, event);
  window.addEventListener('keydown', onKeyDown, { capture: true });

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    for (const d of disposables) d.dispose();
  };
}

function cycleTab(direction: number): void {
  const { tabs, activeTabId, activateTab } = useWorkspace.getState();
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  if (next) activateTab(next.id);
}

/**
 * Globalne kratice. Namjerno kratak popis: sve što editor sam veže
 * (Ctrl+F u CodeMirroru, Ctrl+Z unutar teksta) ovdje se ne presreće.
 */
function handleKey(shell: Shell, event: KeyboardEvent): void {
  const store = useWorkspace.getState();
  const key = event.key.toLowerCase();

  const target = event.target as HTMLElement | null;
  const inTextField =
    target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

  // Escape zatvara pretragu odakle god da je fokus — ploča, editor ili tab.
  // Vezanje samo na ploču znači da Escape iz editora ne radi, što je upravo
  // mjesto s kojeg ga se najčešće pritisne.
  if (event.key === 'Escape' && store.findOpen && !store.paletteOpen) {
    event.preventDefault();
    store.setFindOpen(false);
    activeInstance()?.focus();
    return;
  }

  // Iz čitanja se izlazi istom tipkom kojom se izlazi iz svega ostalog.
  if (event.key === 'Escape' && useReading.getState().active && !store.paletteOpen) {
    event.preventDefault();
    exitReading();
    return;
  }

  const mod = event.ctrlKey || event.metaKey;

  // Listanje bez modifikatora radi i kad je fokus na traci čitaonice, ne samo
  // na tekstu — inače nakon svakog klika na gumb treba vratiti fokus rukom.
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

  // Ctrl+Shift+P — paleta. Radi i kad je fokus unutar editora.
  if (event.shiftKey && key === 'p') {
    event.preventDefault();
    store.setPaletteOpen(!store.paletteOpen);
    return;
  }

  // Unutar polja za unos (npr. tekst bilješke u PDF-u) Ctrl+Z mora ostati
  // preglednikovo poništavanje teksta, ne poništavanje u editoru.
  if (event.shiftKey) {
    if (key === 'r') {
      event.preventDefault();
      toggleReading(shell);
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
    // Ctrl+Shift+F — pretraga koja radi nad svim formatima, uključujući PDF.
    // Ctrl+F ostaje CodeMirroru, koji uz pretragu nudi i zamjenu.
    if (key === 'f' && activeInstance()) {
      event.preventDefault();
      store.setFindOpen(true);
    }
    return;
  }

  switch (key) {
    case 's':
      event.preventDefault();
      void saveActive(shell);
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
      const id = store.activeTabId;
      if (id) void closeTab(shell, id);
      break;
    }
    case 'tab':
      event.preventDefault();
      cycleTab(1);
      break;
    case 'z':
      // Isti put za sve formate: editor sam odlučuje što je korak natrag.
      // Za kod to završi u CodeMirrorovoj povijesti, za PDF u stogu anotacija.
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
