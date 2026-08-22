/**
 * Format detection. The extension is only a hint — the content decides.
 * `ul-formats` (Rust) performs the same detection on the core side; these
 * identifiers must stay in step with it.
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
  | 'vector'
  | 'model'
  | 'archive'
  | 'binary'
  | 'unknown';

/** The family a format belongs to — it carries the colour and icon in the UI. */
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
  /**
   * A human-readable name in English, e.g. "Word document".
   *
   * The contract carries the English source, not a translated string:
   * `plugin-sdk` must not depend on the interface language. The shell translates
   * it at display time.
   */
  label: string;
  /** Whether the content is textual — decides if a text editor may open it. */
  textual: boolean;
}

export const FORMATS: Record<FormatId, FormatDescriptor> = {
  text: { id: 'text', family: 'code', label: 'Plain text', textual: true },
  code: { id: 'code', family: 'code', label: 'Code', textual: true },
  markdown: { id: 'markdown', family: 'document', label: 'Markdown', textual: true },
  pdf: { id: 'pdf', family: 'fixed', label: 'PDF', textual: false },
  epub: { id: 'epub', family: 'book', label: 'E-book (EPUB)', textual: false },
  docx: { id: 'docx', family: 'document', label: 'Word document', textual: false },
  xlsx: { id: 'xlsx', family: 'sheet', label: 'Excel spreadsheet', textual: false },
  pptx: { id: 'pptx', family: 'slides', label: 'PowerPoint presentation', textual: false },
  odf: { id: 'odf', family: 'document', label: 'OpenDocument', textual: false },
  image: { id: 'image', family: 'media', label: 'Image', textual: false },
  /* Textual, because an SVG is markup — the viewer shows the source beside the
     picture, and a text editor opening one is a reasonable thing rather than a
     mistake to be prevented. */
  vector: { id: 'vector', family: 'media', label: 'Vector graphics', textual: true },
  model: { id: 'model', family: 'media', label: '3D model', textual: false },
  archive: { id: 'archive', family: 'other', label: 'Archive', textual: false },
  binary: { id: 'binary', family: 'other', label: 'Binary file', textual: false },
  unknown: { id: 'unknown', family: 'other', label: 'Unknown', textual: false },
};

/** The detection result, with its confidence and how it was reached. */
export interface FormatDetection {
  format: FormatId;
  /** 'magic' = by content (reliable), 'extension' = by name (a hint). */
  via: 'magic' | 'extension' | 'fallback';
  /** The language for syntax highlighting, where applicable. */
  language?: string;
}
