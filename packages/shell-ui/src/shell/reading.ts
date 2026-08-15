/**
 * Čitaonica — način čitanja na razini shella.
 *
 * Stanje je namjerno u zasebnom storeu: napredak se javlja pri svakom
 * listanju, a to ne smije ponovno renderirati stablo, tabove i statusnu traku.
 *
 * Sama sesija (`ReadingSession`) je imperativni objekt editora i ne ide u
 * store — kao ni `EditorInstance`, iz istog razloga.
 */

import { create } from 'zustand';
import {
  DEFAULT_READING,
  type ReadingOptions,
  type ReadingOutlineItem,
  type ReadingProgress,
  type ReadingSession,
} from '@uleditor/plugin-sdk';

import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { activeInstance, activeTab, useWorkspace } from '../state/workspace.js';

export type ReaderPanel = 'none' | 'outline' | 'type';

interface ReadingState {
  active: boolean;
  /** Kartica u kojoj čitaonica radi — prebacivanje kartice je zatvara. */
  tabId: string | null;
  title: string;
  options: ReadingOptions;
  progress: ReadingProgress;
  panel: ReaderPanel;

  setPanel(panel: ReaderPanel): void;
  patchOptions(patch: Partial<ReadingOptions>): void;
}

const EMPTY_PROGRESS: ReadingProgress = { fraction: 0, label: '' };

export const useReading = create<ReadingState>((set) => ({
  active: false,
  tabId: null,
  title: '',
  options: DEFAULT_READING,
  progress: EMPTY_PROGRESS,
  panel: 'none',

  setPanel: (panel) => set((s) => ({ panel: s.panel === panel ? 'none' : panel })),

  patchOptions: (patch) =>
    set((s) => {
      const options = { ...s.options, ...patch };
      session?.apply(options);
      return { options };
    }),
}));

/* ── živa sesija ─────────────────────────────────────────────────────── */

let session: ReadingSession | null = null;
let unsubscribe: (() => void) | null = null;

/** Može li se ono što je otvoreno uopće čitati na ovaj način. */
export function canRead(): boolean {
  return typeof activeInstance()?.beginReading === 'function';
}

export function enterReading(shell: Shell): void {
  if (useReading.getState().active) return;

  const instance = activeInstance();
  const tab = activeTab();
  if (!instance?.beginReading || !tab) {
    shell.notify.show(
      'info',
      t('Reading mode works for e-books, PDF, Word and Markdown. This format does not support it yet.'),
    );
    return;
  }

  const options = {
    ...DEFAULT_READING,
    ...shell.settings.get<Partial<ReadingOptions>>('reading.options', {}),
  };

  session = instance.beginReading(options);
  const disposable = session.onProgress((progress) => useReading.setState({ progress }));
  unsubscribe = () => disposable.dispose();

  useReading.setState({
    active: true,
    tabId: tab.id,
    title: tab.name,
    options,
    progress: EMPTY_PROGRESS,
    panel: 'none',
  });

  // Pretraga i čitanje se ne isključuju, ali ploča pretrage zauzima prostor
  // koji je u čitaonici upravo ono što se htjelo maknuti.
  useWorkspace.getState().setFindOpen(false);
}

export function exitReading(): void {
  if (!useReading.getState().active) return;

  session?.end();
  unsubscribe?.();
  session = null;
  unsubscribe = null;

  useReading.setState({ active: false, tabId: null, panel: 'none' });
  activeInstance()?.focus();
}

export function toggleReading(shell: Shell): void {
  if (useReading.getState().active) exitReading();
  else enterReading(shell);
}

/* ── kretanje kroz sadržaj ───────────────────────────────────────────── */

export function readerPage(delta: number): void {
  session?.page(delta);
}

export function readerSeek(fraction: number): void {
  session?.seek(fraction);
}

/**
 * Sadržaj se dohvaća pri svakom otvaranju ploče, ne jednom pri ulasku:
 * PDF svoje oznake učitava asinkrono, pa bi snimka iz prve sekunde bila prazna.
 */
export function readerOutline(): ReadingOutlineItem[] {
  return session?.outline() ?? [];
}

export function readerGoTo(id: string): void {
  session?.goTo(id);
  useReading.setState({ panel: 'none' });
}

/** Postavke se pamte globalno — čitatelj ih namjesti jednom, ne po knjizi. */
export function persistReadingOptions(shell: Shell): void {
  shell.settings.set('reading.options', useReading.getState().options);
}
