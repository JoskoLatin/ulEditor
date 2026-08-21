/**
 * The scratch panel below — the split the program writes its own output into.
 *
 * The first user is OCR: text read off an image has no file on disk, so it cannot
 * be opened as a tab. It opens here, with a choice of the format it will be saved
 * into. Conversions and exports take the same route later on.
 *
 * The panel holds **one** document. That is deliberate: this is an output, not a
 * second workspace, so a tab bar of its own would be a frame with no content. A
 * full split with two tab groups remains an open item.
 */

import { create } from 'zustand';
import type { DocumentHandle, EditorInstance, FileStat } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { detectByName } from '../host/detect.js';

export type ScratchFormat = 'txt' | 'md' | 'docx' | 'pdf';

interface ScratchState {
  open: boolean;
  /** The panel height in pixels; remembered across the session. */
  height: number;
  /** The name without an extension — the chosen format decides the extension. */
  name: string;
  format: ScratchFormat;
  /** The editor has been created and is waiting to be mounted. */
  ready: boolean;
  dirty: boolean;
  status: string;

  setHeight(height: number): void;
  setFormat(format: ScratchFormat): void;
}

export const useScratch = create<ScratchState>((set) => ({
  open: false,
  height: 300,
  name: '',
  format: 'txt',
  ready: false,
  dirty: false,
  status: '',

  setHeight: (height) => set({ height: Math.min(900, Math.max(120, height)) }),
  setFormat: (format) => set({ format }),
}));

/* ── the imperative part ─────────────────────────────────────────────── */

let instance: EditorInstance | null = null;
let counter = 0;

export function scratchInstance(): EditorInstance | null {
  return instance;
}

/**
 * A document that lives only in memory.
 *
 * The `DocumentHandle` contract assumes no disk — it asks for bytes, text and a
 * `stat`. That is why the code editor opens this without a single change, which
 * is exactly what was expected of the plugin contract.
 */
function memoryDocument(name: string, text: string): DocumentHandle {
  const bytes = new TextEncoder().encode(text);
  const uri = `memory:/${++counter}/${name}`;

  const stat: FileStat = {
    uri,
    name,
    parent: null,
    kind: 'file',
    size: bytes.byteLength,
    modified: Date.now(),
    // Not `readonly`: the content may be changed, only the destination does not exist yet.
    readonly: false,
  };

  return {
    uri,
    name,
    stat,
    detection: detectByName(name),
    bytes: async () => bytes,
    text: async () => text,
    slice: async (start, end) => bytes.subarray(start, end),
  };
}

export interface OpenScratchOptions {
  /** The name without an extension, e.g. "Text from photo.png". */
  name: string;
  text: string;
  format?: ScratchFormat;
}

export async function openScratch(shell: Shell, options: OpenScratchOptions): Promise<void> {
  await closeScratch(shell);

  const format = options.format ?? 'txt';
  const doc = memoryDocument(`${options.name}.${format}`, options.text);
  const provider = shell.registry.resolve(doc);
  if (!provider) {
    shell.notify.show('error', t('No editor is registered for the "{format}" format yet.', { format }));
    return;
  }

  useScratch.setState({
    open: true,
    name: options.name,
    format,
    ready: false,
    dirty: false,
    status: '',
  });

  try {
    const created = await provider.createInstance(shell, doc);
    instance = created;
    created.onDirtyChange((dirty) => useScratch.setState({ dirty }));
    created.onStatusChange((status) => useScratch.setState({ status }));
    useScratch.setState({ ready: true });
  } catch (err) {
    useScratch.setState({ open: false });
    shell.notify.show(
      'error',
      t('Could not open the document: {reason}', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function closeScratch(shell: Shell): Promise<void> {
  if (!useScratch.getState().open) return;

  if (useScratch.getState().dirty) {
    const keep = await confirmDiscard(shell);
    if (keep) return;
  }

  instance?.unmount();
  instance = null;
  useScratch.setState({ open: false, ready: false, dirty: false, status: '', name: '' });
}

function confirmDiscard(shell: Shell): Promise<boolean> {
  return new Promise((resolve) => {
    const name = useScratch.getState().name;
    const handle = shell.notify.show('warning', t('{name} has unsaved changes.', { name }), [
      { label: t('Cancel'), run: () => (handle.dispose(), resolve(true)) },
      { label: t('Discard'), run: () => (handle.dispose(), resolve(false)) },
    ]);
  });
}

/**
 * Saving with a choice of format.
 *
 * The content is taken from the editor through the contract, not out of private
 * state — so it works for every editor the panel can host, not only the one that
 * fills it today.
 */
export async function saveScratch(shell: Shell): Promise<void> {
  const state = useScratch.getState();
  if (!state.open || !instance) return;

  const text = await scratchText();
  if (text === null) {
    shell.notify.show('warning', t('Nothing to save.'));
    return;
  }

  try {
    const { exportText, formatOf } = await import('@uleditor/text-export');
    const descriptor = formatOf(state.format);
    const target = await shell.fs.pickSaveTarget(`${state.name}.${descriptor.extension}`, [
      descriptor.extension,
    ]);
    if (!target) return;

    const { bytes, lost } = await exportText(text, state.format, state.name);

    if (lost.length > 0) {
      const answer = await shell.notify.fidelityWarning(target, lost.map((m) => t(m)));
      if (answer === 'cancel') return;
    }

    await shell.fs.writeBytes(target, bytes);
    useScratch.setState({ dirty: false });
    shell.notify.show('info', t('Saved: {name}', { name: target.split(/[\\/]/).pop() ?? target }));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    shell.notify.show(
      'error',
      t('Save failed: {reason}', { reason: err instanceof Error ? err.message : String(err) }),
    );
  }
}

/**
 * The text out of the editor in the panel — through `plainText()` from the
 * contract, not through private state. That way the panel can host any editor
 * that knows how to give up its text, not only the one that fills it today.
 */
async function scratchText(): Promise<string | null> {
  if (!instance?.plainText) return null;
  return instance.plainText();
}
