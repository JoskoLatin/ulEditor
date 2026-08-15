/**
 * Radna ploča ispod — split u koji program ispisuje ono što je sam proizveo.
 *
 * Prvi korisnik je OCR: tekst pročitan sa slike nema datoteku na disku, pa se
 * ne može otvoriti kao kartica. Otvara se ovdje, uz izbor formata u koji će
 * biti spremljen. Isti put kasnije koriste konverzije i izvoz.
 *
 * Ploča drži **jedan** dokument. To je namjerno: ovo nije drugi radni prostor
 * nego izlaz, pa bi vlastita traka kartica bila okvir bez sadržaja. Puni
 * split s dvije grupe kartica ostaje otvorena stavka.
 */

import { create } from 'zustand';
import type { DocumentHandle, EditorInstance, FileStat } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import type { Shell } from '../host/index.js';
import { detectByName } from '../host/detect.js';

export type ScratchFormat = 'txt' | 'md' | 'docx' | 'pdf';

interface ScratchState {
  open: boolean;
  /** Visina ploče u pikselima; pamti se kroz sesiju. */
  height: number;
  /** Ime bez ekstenzije — ekstenziju određuje odabrani format. */
  name: string;
  format: ScratchFormat;
  /** Editor je stvoren i čeka montažu. */
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

/* ── imperativni dio ─────────────────────────────────────────────────── */

let instance: EditorInstance | null = null;
let counter = 0;

export function scratchInstance(): EditorInstance | null {
  return instance;
}

/**
 * Dokument koji živi samo u memoriji.
 *
 * Ugovor `DocumentHandle` ne pretpostavlja disk — traži bajtove, tekst i
 * `stat`. Zato editor koda ovo otvara bez ijedne izmjene, što je upravo ono
 * što se od plugin ugovora očekivalo.
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
    // Nije `readonly`: sadržaj se smije mijenjati, samo odredište još ne postoji.
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
  /** Ime bez ekstenzije, npr. "Text from slika.png". */
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
 * Spremanje uz izbor formata.
 *
 * Sadržaj se uzima iz editora kroz međuspremnik ugovora, ne iz privatnog
 * stanja — tako radi za svaki editor koji ploča može ugostiti, ne samo za
 * onaj kojim je danas popunjena.
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
 * Tekst iz editora u ploči — kroz `plainText()` iz ugovora, ne kroz privatno
 * stanje. Tako ploča može ugostiti svaki editor koji zna dati svoj tekst, ne
 * samo onaj kojim je danas popunjena.
 */
async function scratchText(): Promise<string | null> {
  if (!instance?.plainText) return null;
  return instance.plainText();
}
