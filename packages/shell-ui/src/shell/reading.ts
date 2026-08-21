/**
 * The reading room — reading mode at the shell level.
 *
 * The state deliberately lives in a store of its own: progress is reported on
 * every page turn, and that must not re-render the tree, the tabs and the status
 * bar.
 *
 * The session itself (`ReadingSession`) is the editor's imperative object and does
 * not go into the store — no more than `EditorInstance` does, for the same reason.
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
  /** The tab the reading room runs in — switching tabs closes it. */
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

/* ── the live session ────────────────────────────────────────────────── */

let session: ReadingSession | null = null;
let unsubscribe: (() => void) | null = null;

/** Whether what is open can be read this way at all. */
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

  // Search and reading are not mutually exclusive, but the search panel takes up
  // the very space the reading room set out to clear.
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

/* ── navigating the contents ─────────────────────────────────────────── */

export function readerPage(delta: number): void {
  session?.page(delta);
}

export function readerSeek(fraction: number): void {
  session?.seek(fraction);
}

/**
 * The table of contents is fetched every time the panel opens, not once on entry:
 * a PDF loads its outline asynchronously, so a snapshot from the first second
 * would be empty.
 */
export function readerOutline(): ReadingOutlineItem[] {
  return session?.outline() ?? [];
}

export function readerGoTo(id: string): void {
  session?.goTo(id);
  useReading.setState({ panel: 'none' });
}

/** The settings are remembered globally — a reader sets them once, not per book. */
export function persistReadingOptions(shell: Shell): void {
  shell.settings.set('reading.options', useReading.getState().options);
}
