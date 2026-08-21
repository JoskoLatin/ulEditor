/**
 * The cross-format clipboard.
 *
 * This is why ulEditor exists as one application instead of five. A payload
 * carries SEVERAL representations at once; the receiving editor picks the
 * richest one it understands. A range from a spreadsheet pasted into a document
 * therefore becomes a real table, not tab-separated text.
 *
 * The rule for editor authors: always fill in `text/plain` as the last line of
 * defence, even when you offer a structured form.
 */

export interface TableRepresentation {
  /** Rows → cells. The values are already formatted for display. */
  rows: string[][];
  /** Whether the first row is a header. */
  headerRow: boolean;
  /** Raw values where available — preserves types across a paste. */
  raw?: (string | number | boolean | null)[][];
}

export interface RichTextRepresentation {
  html: string;
  /** The source format, so the receiver knows how far to trust the HTML. */
  origin: 'markdown' | 'docx' | 'html' | 'pdf';
}

export interface ClipboardPayload {
  /** Always present. */
  'text/plain': string;
  'text/html'?: RichTextRepresentation;
  'application/x-uleditor-table'?: TableRepresentation;
  'image/png'?: Uint8Array;
  /** Where it came from — used for telemetry and for "undo paste as plain". */
  source?: { editorId: string; uri?: string };
}

export function plainPayload(text: string, source?: ClipboardPayload['source']): ClipboardPayload {
  return source ? { 'text/plain': text, source } : { 'text/plain': text };
}

/** Table → tab-separated text. The fallback every editor understands. */
export function tableToPlain(table: TableRepresentation): string {
  return table.rows.map((row) => row.join('\t')).join('\n');
}
