/**
 * Prepoznavanje formata. Ekstenzija je samo nagovještaj — mjerodavan je
 * sadržaj. `ul-formats` (Rust) radi istu detekciju na core strani; ovi
 * identifikatori moraju ostati usklađeni s njom.
 */

export type FormatId =
  | 'text'
  | 'code'
  | 'markdown'
  | 'pdf'
  | 'epub'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'odf'
  | 'image'
  | 'archive'
  | 'binary'
  | 'unknown';

/** Obitelj kojoj format pripada — nosi boju i ikonu u UI-u. */
export type FormatFamily =
  | 'code'
  | 'document'
  | 'sheet'
  | 'slides'
  | 'fixed'
  | 'book'
  | 'media'
  | 'other';

export interface FormatDescriptor {
  id: FormatId;
  family: FormatFamily;
  /** Ljudski čitljiv naziv, npr. "Word dokument". */
  label: string;
  /** Je li sadržaj tekstualan — određuje smije li ga tekstualni editor otvoriti. */
  textual: boolean;
}

export const FORMATS: Record<FormatId, FormatDescriptor> = {
  text: { id: 'text', family: 'code', label: 'Tekst', textual: true },
  code: { id: 'code', family: 'code', label: 'Kod', textual: true },
  markdown: { id: 'markdown', family: 'document', label: 'Markdown', textual: true },
  pdf: { id: 'pdf', family: 'fixed', label: 'PDF', textual: false },
  epub: { id: 'epub', family: 'book', label: 'E-knjiga (EPUB)', textual: false },
  docx: { id: 'docx', family: 'document', label: 'Word dokument', textual: false },
  xlsx: { id: 'xlsx', family: 'sheet', label: 'Excel tablica', textual: false },
  pptx: { id: 'pptx', family: 'slides', label: 'PowerPoint prezentacija', textual: false },
  odf: { id: 'odf', family: 'document', label: 'OpenDocument', textual: false },
  image: { id: 'image', family: 'media', label: 'Slika', textual: false },
  archive: { id: 'archive', family: 'other', label: 'Arhiva', textual: false },
  binary: { id: 'binary', family: 'other', label: 'Binarna datoteka', textual: false },
  unknown: { id: 'unknown', family: 'other', label: 'Nepoznato', textual: false },
};

/** Rezultat detekcije, uz razinu pouzdanosti i kako je donesena. */
export interface FormatDetection {
  format: FormatId;
  /** 'magic' = po sadržaju (pouzdano), 'extension' = po imenu (nagovještaj). */
  via: 'magic' | 'extension' | 'fallback';
  /** Jezik za syntax highlighting, kad je primjenjiv. */
  language?: string;
}
