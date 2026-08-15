/**
 * Registar editora.
 *
 * Shell ne zna ništa o pojedinim formatima — zna samo pitati registar tko
 * može otvoriti dani dokument. Dodavanje formata je registracija providera,
 * bez ijedne izmjene u shellu. To je cijela poanta plugin ugovora.
 */

import type { DocumentHandle, EditorProvider, FormatId } from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { extensionOf } from './detect.js';

/** Formati koje ćemo podržavati, ali još nemaju providera. */
const PLANNED: Partial<Record<FormatId, string>> = {
  pptx: 'PowerPoint arrives in phase 5.',
  odf: 'OpenDocument arrives in phase 2, via LibreOffice conversion.',
  archive: 'Browsing archives is not planned — ulEditor opens documents, it does not pack them.',
};

export class EditorRegistry {
  #providers: EditorProvider[] = [];

  register(provider: EditorProvider): void {
    if (this.#providers.some((p) => p.id === provider.id)) {
      throw new Error(`Editor ${provider.id} je već registriran.`);
    }
    this.#providers.push(provider);
    // Veći priority prvi — `resolve` onda samo uzima prvi pogodak.
    this.#providers.sort((a, b) => b.priority - a.priority);
  }

  all(): readonly EditorProvider[] {
    return this.#providers;
  }

  /** Svi provideri koji mogu otvoriti dokument, najbolji prvi. */
  candidates(doc: DocumentHandle): EditorProvider[] {
    const ext = extensionOf(doc.name);
    return this.#providers.filter((p) => this.#matches(p, doc, ext));
  }

  resolve(doc: DocumentHandle): EditorProvider | null {
    return this.candidates(doc)[0] ?? null;
  }

  /** Objašnjenje zašto format nije podržan — bolje od praznog ekrana. */
  explainMissing(doc: DocumentHandle): string {
    const planned = PLANNED[doc.detection.format];
    if (planned) return t(planned);
    return t('No editor is registered for the "{format}" format yet.', {
      format: doc.detection.format,
    });
  }

  #matches(provider: EditorProvider, doc: DocumentHandle, ext: string): boolean {
    const { extensions, magic } = provider.matches;

    // `*` znači "uzmi sve što nitko drugi ne želi" — fallback tekstualni editor.
    if (extensions.includes('*')) return true;
    if (ext && extensions.includes(ext)) return true;

    if (magic?.length) {
      // Potpisi se provjeravaju tek kad ekstenzija ne odluči; sadržaj je već
      // pročitan pri otvaranju pa ovdje koristimo rezultat detekcije.
      if (magic.some((sig) => sig.length > 0) && doc.detection.via === 'magic') {
        return extensions.includes(doc.detection.format);
      }
    }

    return extensions.includes(doc.detection.format);
  }
}
