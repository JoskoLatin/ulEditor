/**
 * The editor registry.
 *
 * The shell knows nothing about individual formats — it only knows how to ask
 * the registry who can open a given document. Adding a format is registering a
 * provider, with not one change in the shell. That is the whole point of the
 * plugin contract.
 */

import type { DocumentHandle, EditorProvider, FormatId } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { extensionOf } from './detect.js';

/** Formats we will support, but which have no provider yet. */
const PLANNED: Partial<Record<FormatId, string>> = {
  pptx: 'PowerPoint arrives in phase 5.',
  odf: 'OpenDocument arrives in phase 2, via LibreOffice conversion.',
  archive: 'Browsing archives is not planned — ulEditor opens documents, it does not pack them.',
};

export class EditorRegistry {
  #providers: EditorProvider[] = [];

  register(provider: EditorProvider): void {
    if (this.#providers.some((p) => p.id === provider.id)) {
      throw new Error(`Editor ${provider.id} is already registered.`);
    }
    this.#providers.push(provider);
    // Higher priority first — `resolve` then simply takes the first match.
    this.#providers.sort((a, b) => b.priority - a.priority);
  }

  all(): readonly EditorProvider[] {
    return this.#providers;
  }

  /** Every provider that can open the document, best first. */
  candidates(doc: DocumentHandle): EditorProvider[] {
    const ext = extensionOf(doc.name);
    return this.#providers.filter((p) => this.#matches(p, doc, ext));
  }

  resolve(doc: DocumentHandle): EditorProvider | null {
    return this.candidates(doc)[0] ?? null;
  }

  /** An explanation of why a format is unsupported — better than a blank screen. */
  explainMissing(doc: DocumentHandle): string {
    const planned = PLANNED[doc.detection.format];
    if (planned) return t(planned);
    return t('No editor is registered for the "{format}" format yet.', {
      format: doc.detection.format,
    });
  }

  #matches(provider: EditorProvider, doc: DocumentHandle, ext: string): boolean {
    const { extensions } = provider.matches;

    // `*` means "take everything nobody else wants" — the fallback text editor.
    if (extensions.includes('*')) return true;

    /*
     * When the content decided, the content decides here too.
     *
     * The extension used to be tried first, which made this the one place in the
     * program where the file name outranked the bytes — the opposite of what
     * detection is for. It stayed invisible while no two providers disagreed
     * about an extension, and Illustrator made it visible: an `.ai` file has a
     * whole PDF inside it and is detected as one, and it still went to whichever
     * provider happened to list `ai`. The same fault sent a PDF renamed to
     * `.txt` to the code editor, under a detector with a test celebrating that
     * it had recognised the PDF.
     *
     * A provider's `magic` is not read here. Signatures are checked once,
     * centrally, in `detect` — the field stays in the contract as a declaration
     * of what a provider expects, for a host that does its own detection.
     */
    if (doc.detection.via === 'magic') return extensions.includes(doc.detection.format);

    if (ext && extensions.includes(ext)) return true;
    return extensions.includes(doc.detection.format);
  }
}
