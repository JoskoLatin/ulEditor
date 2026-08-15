/**
 * Cross-format clipboard.
 *
 * Ovo je razlog zašto ulEditor postoji kao jedna aplikacija umjesto pet.
 * Payload nosi VIŠE reprezentacija odjednom; editor primatelj bira najbogatiju
 * koju razumije. Raspon iz tablice zalijepljen u dokument tako postaje prava
 * tablica, a ne tab-razdvojeni tekst.
 *
 * Pravilo za autore editora: uvijek popuni `text/plain` kao zadnju liniju
 * obrane, čak i kad nudiš strukturirani oblik.
 */

export interface TableRepresentation {
  /** Redci → ćelije. Vrijednosti su već formatirane za prikaz. */
  rows: string[][];
  /** Je li prvi redak zaglavlje. */
  headerRow: boolean;
  /** Neobrađene vrijednosti kad postoje — čuva tipove kroz paste. */
  raw?: (string | number | boolean | null)[][];
}

export interface RichTextRepresentation {
  html: string;
  /** Izvorni format, da primatelj zna koliko vjerovati HTML-u. */
  origin: 'markdown' | 'docx' | 'html' | 'pdf';
}

export interface ClipboardPayload {
  /** Uvijek prisutno. */
  'text/plain': string;
  'text/html'?: RichTextRepresentation;
  'application/x-uleditor-table'?: TableRepresentation;
  'image/png'?: Uint8Array;
  /** Odakle dolazi — koristi se za telemetriju i za "undo paste as plain". */
  source?: { editorId: string; uri?: string };
}

export function plainPayload(text: string, source?: ClipboardPayload['source']): ClipboardPayload {
  return source ? { 'text/plain': text, source } : { 'text/plain': text };
}

/** Tablica → tab-razdvojeni tekst. Fallback koji svaki editor razumije. */
export function tableToPlain(table: TableRepresentation): string {
  return table.rows.map((row) => row.join('\t')).join('\n');
}
