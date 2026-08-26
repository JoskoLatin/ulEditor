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
  | 'doc'
  | 'rtf'
  | 'xlsx'
  | 'xls'
  | 'pptx'
  | 'odt'
  | 'ods'
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
  /**
   * Whether a person would call this a document.
   *
   * It decides what a library of somebody's files lists, and says nothing about
   * whether this program can open one: a `.pptx` in a folder is still theirs,
   * and the shell explains what it cannot do with it.
   *
   * It lives here, in a `Record` over every id, rather than in a list beside
   * the code that needs it. Three such lists existed, and every one fell out of
   * step the moment a format was given an id of its own — splitting the old
   * binary Word out of `docx` quietly emptied a library of fifty-one files.
   * Spelled this way, a new id will not compile until it has been decided.
   */
  document: boolean;
  /**
   * Whether the words sit inside a container rather than in the bytes.
   *
   * A byte scan finds nothing in these — the text is compressed, encoded, or
   * scattered through a piece table — so a search offers the file to be opened
   * rather than a line to jump to.
   */
  container: boolean;
}

export const FORMATS: Record<FormatId, FormatDescriptor> = {
  text: { id: 'text', family: 'code', label: 'Plain text', textual: true, document: false, container: false },
  code: { id: 'code', family: 'code', label: 'Code', textual: true, document: false, container: false },
  markdown: { id: 'markdown', family: 'document', label: 'Markdown', textual: true, document: true, container: false },
  pdf: { id: 'pdf', family: 'fixed', label: 'PDF', textual: false, document: true, container: true },
  epub: { id: 'epub', family: 'book', label: 'E-book (EPUB)', textual: false, document: true, container: true },
  docx: { id: 'docx', family: 'document', label: 'Word document', textual: false, document: true, container: true },
  /* The same reasoning that gave `.xls` its own id: the old binary Word shares
     nothing with a `.docx` but the name, and opens in a different editor. */
  doc: { id: 'doc', family: 'document', label: 'Word 97-2003 document', textual: false, document: true, container: true },
  /* Textual, and that is the point: an `.rtf` is markup a person can read, so a
     text editor opening one is a reasonable thing rather than a mistake. A
     container all the same, since it acquired a reader: searching the raw
     markup matches `\par` and misses every escaped Croatian letter. */
  rtf: { id: 'rtf', family: 'document', label: 'Rich Text', textual: true, document: true, container: true },
  xlsx: { id: 'xlsx', family: 'sheet', label: 'Excel spreadsheet', textual: false, document: true, container: true },
  /* Its own id, not a variant of xlsx: when content decides, the format is what
     routes a file to an editor — and the old binary format opens read-only. */
  xls: { id: 'xls', family: 'sheet', label: 'Excel 97-2003 spreadsheet', textual: false, document: true, container: true },
  pptx: { id: 'pptx', family: 'slides', label: 'PowerPoint presentation', textual: false, document: true, container: true },
  /* A text document and a spreadsheet are as different from each other as a
     `.docx` is from an `.xlsx`, and they open in different editors — so the
     same reasoning that gave `.xls` its own id gives these theirs. `odf` stays
     for the rest of the family: presentations, drawings, formulas. */
  odt: { id: 'odt', family: 'document', label: 'OpenDocument text', textual: false, document: true, container: true },
  ods: { id: 'ods', family: 'sheet', label: 'OpenDocument spreadsheet', textual: false, document: true, container: true },
  odf: { id: 'odf', family: 'document', label: 'OpenDocument', textual: false, document: true, container: true },
  image: { id: 'image', family: 'media', label: 'Image', textual: false, document: true, container: false },
  /* Textual, because an SVG is markup — the viewer shows the source beside the
     picture, and a text editor opening one is a reasonable thing rather than a
     mistake to be prevented. */
  vector: { id: 'vector', family: 'media', label: 'Vector graphics', textual: true, document: false, container: false },
  model: { id: 'model', family: 'media', label: '3D model', textual: false, document: false, container: false },
  archive: { id: 'archive', family: 'other', label: 'Archive', textual: false, document: false, container: false },
  binary: { id: 'binary', family: 'other', label: 'Binary file', textual: false, document: false, container: false },
  unknown: { id: 'unknown', family: 'other', label: 'Unknown', textual: false, document: false, container: false },
};

/** The detection result, with its confidence and how it was reached. */
export interface FormatDetection {
  format: FormatId;
  /** 'magic' = by content (reliable), 'extension' = by name (a hint). */
  via: 'magic' | 'extension' | 'fallback';
  /** The language for syntax highlighting, where applicable. */
  language?: string;
}
