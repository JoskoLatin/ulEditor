/**
 * The old binary Excel — `.xls`, Excel 97–2003 — read into the same grid.
 *
 * Not a ZIP of XML but two older layers: an **OLE2 compound file** (a little
 * file system with its own FAT, sectors and directory) holding a `Workbook`
 * stream, and inside that stream **BIFF8 records** — tagged binary blocks for
 * cells, strings and formats. Both are read here, by hand, because the files
 * are everywhere: every export from an older accounting program, every
 * attachment from an office that never upgraded.
 *
 * **Read-only, deliberately.** The format is write-hostile in a way OOXML is
 * not — the shared string table is indexed from every sheet, the records carry
 * offsets into one another, and a byte-surgical edit in the spirit of
 * [`xlsx-edit.ts`](./xlsx-edit.ts) has no safe seam to cut along. Rather than
 * write it badly, the grid says plainly: save it as `.xlsx` and edit it here.
 *
 * What is read: cell values (numbers, shared and inline strings, booleans,
 * errors, cached formula results), number formats far enough to tell a date
 * from an amount, merged ranges and column widths. What is not: charts,
 * images, and everything about formatting beyond the number format — stated in
 * the notes above the grid rather than silently absent.
 */

import { t } from '@uleditor/i18n';

import {
  MAX_COLS,
  MAX_ROWS,
  formatDate,
  formatNumber,
  isDateFormat,
  type Cell,
  type Merge,
  type Sheet,
  type Workbook,
} from './xlsx.js';

export const XLS_READONLY =
  'An old binary Excel file (.xls) — shown read-only. Save it as .xlsx in Excel or LibreOffice to edit it here.';

/* ── the OLE2 compound file ──────────────────────────────────────────── */

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** Sector numbers from 0xFFFFFFFA up are markers, not sectors. */
const isSector = (n: number) => n < 0xfffffffa;

class Cfb {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #sectorSize: number;
  readonly #fat: Uint32Array;
  readonly #miniFat: Uint32Array;
  readonly #miniCutoff: number;
  readonly #miniStream: Uint8Array;
  readonly #directory: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    this.#sectorSize = 1 << this.#view.getUint16(30, true);
    this.#miniCutoff = this.#view.getUint32(56, true);

    /* The FAT: which sector follows which. Its own sectors are listed in the
       header's DIFAT, and past 109 of them in a chain of DIFAT sectors. */
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const sect = this.#view.getUint32(76 + i * 4, true);
      if (isSector(sect)) fatSectors.push(sect);
    }
    let difat = this.#view.getUint32(68, true);
    const perDifat = this.#sectorSize / 4 - 1;
    for (let guard = 0; isSector(difat) && guard < 4096; guard++) {
      const at = this.#sectorOffset(difat);
      for (let i = 0; i < perDifat; i++) {
        const sect = this.#view.getUint32(at + i * 4, true);
        if (isSector(sect)) fatSectors.push(sect);
      }
      difat = this.#view.getUint32(at + perDifat * 4, true);
    }

    const perSector = this.#sectorSize / 4;
    this.#fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((sect, index) => {
      const at = this.#sectorOffset(sect);
      for (let i = 0; i < perSector; i++) {
        this.#fat[index * perSector + i] = this.#view.getUint32(at + i * 4, true);
      }
    });

    this.#directory = this.#readChain(this.#view.getUint32(48, true));

    const miniFatBytes = this.#readChain(this.#view.getUint32(60, true));
    this.#miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
    const miniView = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i < this.#miniFat.length; i++) this.#miniFat[i] = miniView.getUint32(i * 4, true);

    /* The mini stream — where every stream smaller than the cutoff lives — is
       itself an ordinary stream owned by the root entry. */
    const root = this.#entry(0);
    this.#miniStream = root ? this.#readChain(root.start, root.size) : new Uint8Array(0);
  }

  #sectorOffset(sect: number): number {
    return (sect + 1) * this.#sectorSize;
  }

  #readChain(start: number, size?: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let sect = start;
    const visited = new Set<number>();
    while (isSector(sect) && !visited.has(sect)) {
      visited.add(sect);
      const at = this.#sectorOffset(sect);
      parts.push(this.#bytes.subarray(at, at + this.#sectorSize));
      sect = this.#fat[sect] ?? ENDOFCHAIN;
    }
    const whole = new Uint8Array(parts.length * this.#sectorSize);
    parts.forEach((part, index) => whole.set(part, index * this.#sectorSize));
    return size === undefined ? whole : whole.subarray(0, size);
  }

  #readMiniChain(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let sect = start;
    let written = 0;
    const visited = new Set<number>();
    while (isSector(sect) && written < size && !visited.has(sect)) {
      visited.add(sect);
      const chunk = this.#miniStream.subarray(sect * 64, sect * 64 + 64);
      out.set(chunk.subarray(0, Math.min(64, size - written)), written);
      written += 64;
      sect = this.#miniFat[sect] ?? ENDOFCHAIN;
    }
    return out;
  }

  #entry(index: number): { name: string; type: number; start: number; size: number } | null {
    const at = index * 128;
    if (at + 128 > this.#directory.length) return null;
    const view = new DataView(this.#directory.buffer, this.#directory.byteOffset + at, 128);
    const nameLen = view.getUint16(64, true);
    if (nameLen < 2 || nameLen > 64) return null;
    let name = '';
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(view.getUint16(i, true));
    return {
      name,
      type: view.getUint8(66),
      start: view.getUint32(116, true),
      size: view.getUint32(120, true),
    };
  }

  /** The named stream, or `null` — the caller decides what its absence means. */
  stream(...names: string[]): Uint8Array | null {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    for (let index = 0; index * 128 < this.#directory.length; index++) {
      const entry = this.#entry(index);
      if (!entry || entry.type !== 2 || !wanted.has(entry.name.toLowerCase())) continue;
      return entry.size < this.#miniCutoff
        ? this.#readMiniChain(entry.start, entry.size)
        : this.#readChain(entry.start, entry.size);
    }
    return null;
  }
}

/* ── BIFF8 records ───────────────────────────────────────────────────── */

interface Record_ {
  id: number;
  start: number;
  len: number;
}

/**
 * A cursor over one record and its CONTINUE followers.
 *
 * Strings in BIFF are the reason it exists: the shared string table routinely
 * outgrows a record's 8224-byte limit, and where the split lands **inside a
 * string's characters**, the continuation begins with a fresh flags byte that
 * may switch the same string between one and two bytes per character
 * mid-word. Reading it as one flat buffer garbles exactly the workbooks big
 * enough to matter.
 */
class Segments {
  // Not TS parameter properties: the byte checks run this file under Node's
  // type stripping, which refuses them.
  readonly #bytes: Uint8Array;
  #segments: { start: number; end: number }[];
  #seg = 0;
  #off: number;

  constructor(bytes: Uint8Array, segments: { start: number; end: number }[]) {
    this.#bytes = bytes;
    this.#segments = segments;
    this.#off = segments[0]?.start ?? 0;
  }

  #remainingInSegment(): number {
    return (this.#segments[this.#seg]?.end ?? 0) - this.#off;
  }

  /** Moves onto the next segment when this one is spent. Returns whether data remains. */
  #ensure(): boolean {
    while (this.#remainingInSegment() <= 0) {
      this.#seg += 1;
      const next = this.#segments[this.#seg];
      if (!next) return false;
      this.#off = next.start;
    }
    return true;
  }

  atEnd(): boolean {
    return !this.#ensure();
  }

  u8(): number {
    this.#ensure();
    return this.#bytes[this.#off++] ?? 0;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  f64(): number {
    /* Doubles never straddle a CONTINUE in files Excel writes; assembled
       byte-wise anyway, so a file someone else wrote cannot break the read. */
    const raw = new Uint8Array(8);
    for (let i = 0; i < 8; i++) raw[i] = this.u8();
    return new DataView(raw.buffer).getFloat64(0, true);
  }

  skip(count: number): void {
    let left = count;
    while (left > 0 && this.#ensure()) {
      const take = Math.min(left, this.#remainingInSegment());
      this.#off += take;
      left -= take;
    }
  }

  /**
   * `count` characters, starting at one or two bytes each; a segment boundary
   * inside the run re-reads the flags byte, as the format demands.
   */
  chars(count: number, wide: boolean): string {
    let out = '';
    let isWide = wide;
    let left = count;
    while (left > 0) {
      if (this.#remainingInSegment() <= 0) {
        if (!this.#ensure()) break;
        isWide = (this.u8() & 0x01) !== 0;
      }
      out += isWide ? String.fromCharCode(this.u16()) : String.fromCharCode(this.u8());
      left -= 1;
    }
    return out;
  }

  /** XLUnicodeString / XLUnicodeRichExtendedString, as the record variant needs. */
  string(lenBytes: 1 | 2): string {
    const cch = lenBytes === 1 ? this.u8() : this.u16();
    const flags = this.u8();
    const rich = (flags & 0x08) !== 0 ? this.u16() : 0;
    const ext = (flags & 0x04) !== 0 ? this.u32() : 0;
    const text = this.chars(cch, (flags & 0x01) !== 0);
    this.skip(rich * 4 + ext);
    return text;
  }
}

/** Excel's 30-bit packed number: an integer or a truncated double, optionally ÷100. */
function decodeRk(rk: number): number {
  let value: number;
  if ((rk & 0x02) !== 0) {
    // A signed 30-bit integer; the arithmetic shift keeps the sign.
    value = (rk | 0) >> 2;
  } else {
    // The high 30 bits are the top of an IEEE double; the rest is zeros.
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    value = buffer.getFloat64(0, true);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

const BIFF_ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
};

/** The built-in number formats the reader needs codes for; the rest only matter as date-or-not. */
const BUILTIN_CODES: Record<number, string> = {
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
};

/* ── the workbook stream ─────────────────────────────────────────────── */

export function readXls(bytes: Uint8Array): Workbook {
  if (bytes.length < 512) {
    throw new Error(t('This is not a valid Office file — it is probably damaged or incompletely downloaded.'));
  }

  /* A truncated container fails somewhere inside the sector arithmetic; what
     the person needs to hear is what happened to the file, not which offset. */
  let stream: Uint8Array | null;
  try {
    stream = new Cfb(bytes).stream('Workbook', 'Book');
  } catch {
    throw new Error(t('This is not a valid Office file — it is probably damaged or incompletely downloaded.'));
  }
  if (!stream) {
    throw new Error(t('The file has no Excel workbook inside — it may be an old Word or PowerPoint file.'));
  }

  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

  /* The record index: id, length, where the payload starts. */
  const records: Record_[] = [];
  const byOffset = new Map<number, number>();
  for (let at = 0; at + 4 <= stream.length; ) {
    const id = view.getUint16(at, true);
    const len = view.getUint16(at + 2, true);
    byOffset.set(at, records.length);
    records.push({ id, start: at + 4, len });
    at += 4 + len;
  }

  const segmentsOf = (index: number): Segments => {
    const own = [{ start: records[index]!.start, end: records[index]!.start + records[index]!.len }];
    for (let next = index + 1; records[next]?.id === 0x003c; next++) {
      own.push({ start: records[next]!.start, end: records[next]!.start + records[next]!.len });
    }
    return new Segments(stream, own);
  };

  const first = records[0];
  if (!first || first.id !== 0x0809) {
    throw new Error(t('This is not a valid Office file — it is probably damaged or incompletely downloaded.'));
  }
  const version = view.getUint16(first.start, true);
  if (version !== 0x0600) {
    throw new Error(
      t('This .xls was written by Excel 5.0/95 — open it there once and save it as .xlsx.'),
    );
  }

  /* ── the globals: strings, formats, sheet names ── */

  const shared: string[] = [];
  const formats = new Map<number, string>();
  const xfFormats: number[] = [];
  const bounds: { name: string; offset: number; worksheet: boolean }[] = [];
  let date1904 = false;

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.id === 0x000a) break; // EOF ends the globals substream.

    if (record.id === 0x00fc) {
      const cursor = segmentsOf(index);
      cursor.u32();
      const unique = cursor.u32();
      for (let i = 0; i < unique && !cursor.atEnd(); i++) shared.push(cursor.string(2));
    } else if (record.id === 0x041e) {
      const cursor = segmentsOf(index);
      const id = cursor.u16();
      formats.set(id, cursor.string(2));
    } else if (record.id === 0x00e0) {
      xfFormats.push(view.getUint16(record.start + 2, true));
    } else if (record.id === 0x0085) {
      const cursor = segmentsOf(index);
      const offset = cursor.u32();
      const kind = cursor.u16() >> 8;
      const cch = cursor.u8();
      const wide = (cursor.u8() & 0x01) !== 0;
      bounds.push({ name: cursor.chars(cch, wide), offset, worksheet: kind === 0 });
    } else if (record.id === 0x0022) {
      date1904 = view.getUint16(record.start, true) === 1;
    }
  }

  const codeOf = (ixfe: number): { id: number; code: string | undefined } => {
    const id = xfFormats[ixfe] ?? 0;
    return { id, code: formats.get(id) ?? BUILTIN_CODES[id] };
  };

  /* ── the sheets ── */

  const sheets: Sheet[] = [];
  const notes = new Set<string>();
  let truncated = false;

  for (const bound of bounds) {
    if (!bound.worksheet) continue;
    const from = byOffset.get(bound.offset);
    if (from === undefined) continue;

    const cells = new Map<string, Cell>();
    const merges: Merge[] = [];
    const widths = new Map<number, number>();
    let maxRow = 0;
    let maxCol = 0;
    /** The formula whose string result the next STRING record carries. */
    let pendingString: { row: number; col: number } | null = null;

    const put = (row: number, col: number, cell: Cell | null) => {
      if (!cell) return;
      if (row >= MAX_ROWS || col >= MAX_COLS) {
        truncated = true;
        return;
      }
      cells.set(`${row},${col}`, cell);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    };

    const numberCell = (value: number, ixfe: number): Cell => {
      const { id, code } = codeOf(ixfe);
      if (isDateFormat(id, code)) {
        return { text: formatDate(date1904 ? value + 1462 : value, code), kind: 'date' };
      }
      return { text: formatNumber(value, code), kind: 'number' };
    };

    let depth = 0;
    for (let index = from; index < records.length; index++) {
      const record = records[index]!;
      if (record.id === 0x0809) depth += 1;
      if (record.id === 0x000a) {
        depth -= 1;
        if (depth <= 0) break;
        continue;
      }

      switch (record.id) {
        case 0x0203: {
          // NUMBER
          const row = view.getUint16(record.start, true);
          const col = view.getUint16(record.start + 2, true);
          const ixfe = view.getUint16(record.start + 4, true);
          put(row, col, numberCell(view.getFloat64(record.start + 6, true), ixfe));
          break;
        }
        case 0x027e: {
          // RK
          const row = view.getUint16(record.start, true);
          const col = view.getUint16(record.start + 2, true);
          const ixfe = view.getUint16(record.start + 4, true);
          put(row, col, numberCell(decodeRk(view.getUint32(record.start + 6, true)), ixfe));
          break;
        }
        case 0x00bd: {
          // MULRK — one row, a run of columns.
          const row = view.getUint16(record.start, true);
          const colFirst = view.getUint16(record.start + 2, true);
          const runs = (record.len - 6) / 6;
          for (let i = 0; i < runs; i++) {
            const ixfe = view.getUint16(record.start + 4 + i * 6, true);
            const rk = view.getUint32(record.start + 6 + i * 6, true);
            put(row, colFirst + i, numberCell(decodeRk(rk), ixfe));
          }
          break;
        }
        case 0x00fd: {
          // LABELSST
          const row = view.getUint16(record.start, true);
          const col = view.getUint16(record.start + 2, true);
          const isst = view.getUint32(record.start + 6, true);
          const text = shared[isst] ?? '';
          if (text) put(row, col, { text, kind: 'text' });
          break;
        }
        case 0x0204: {
          // LABEL — an inline string, rare in BIFF8 but legal.
          const cursor = segmentsOf(index);
          const row = cursor.u16();
          const col = cursor.u16();
          cursor.u16();
          const text = cursor.string(2);
          if (text) put(row, col, { text, kind: 'text' });
          break;
        }
        case 0x0006: {
          // FORMULA — only its cached result is read; the token stream is not decompiled.
          const row = view.getUint16(record.start, true);
          const col = view.getUint16(record.start + 2, true);
          const ixfe = view.getUint16(record.start + 4, true);
          if (view.getUint16(record.start + 12, true) === 0xffff) {
            const kind = view.getUint8(record.start + 6);
            if (kind === 0) pendingString = { row, col };
            else if (kind === 1) {
              put(row, col, {
                text: view.getUint8(record.start + 8) ? t('TRUE') : t('FALSE'),
                kind: 'bool',
              });
            } else if (kind === 2) {
              put(row, col, { text: BIFF_ERRORS[view.getUint8(record.start + 8)] ?? '#ERR', kind: 'error' });
            }
          } else {
            put(row, col, numberCell(view.getFloat64(record.start + 6, true), ixfe));
          }
          break;
        }
        case 0x0207: {
          // STRING — the text result of the formula just seen.
          if (!pendingString) break;
          const text = segmentsOf(index).string(2);
          if (text) put(pendingString.row, pendingString.col, { text, kind: 'text' });
          pendingString = null;
          break;
        }
        case 0x0205: {
          // BOOLERR
          const row = view.getUint16(record.start, true);
          const col = view.getUint16(record.start + 2, true);
          const value = view.getUint8(record.start + 6);
          const isError = view.getUint8(record.start + 7) === 1;
          put(
            row,
            col,
            isError
              ? { text: BIFF_ERRORS[value] ?? '#ERR', kind: 'error' }
              : { text: value ? t('TRUE') : t('FALSE'), kind: 'bool' },
          );
          break;
        }
        case 0x00e5: {
          // MERGECELLS
          const count = view.getUint16(record.start, true);
          for (let i = 0; i < count; i++) {
            const at = record.start + 2 + i * 8;
            const rowFirst = view.getUint16(at, true);
            const rowLast = view.getUint16(at + 2, true);
            const colFirst = view.getUint16(at + 4, true);
            const colLast = view.getUint16(at + 6, true);
            merges.push({
              row: rowFirst,
              col: colFirst,
              rows: rowLast - rowFirst + 1,
              cols: colLast - colFirst + 1,
            });
          }
          break;
        }
        case 0x007d: {
          // COLINFO — width in 1/256 of a character.
          const colFirst = view.getUint16(record.start, true);
          const colLast = view.getUint16(record.start + 2, true);
          const width = view.getUint16(record.start + 4, true) / 256;
          for (let c = colFirst; c <= Math.min(colLast, MAX_COLS - 1); c++) {
            widths.set(c, Math.round(width * 7 + 8));
          }
          break;
        }
      }
    }

    sheets.push({
      name: bound.name || `List ${sheets.length + 1}`,
      path: '',
      rows: maxRow + 1,
      cols: maxCol + 1,
      cells,
      merges,
      widths,
    });
  }

  if (sheets.length === 0) throw new Error(t('The workbook has no readable sheet.'));

  if (truncated) {
    notes.add(`Only the first ${MAX_ROWS} rows and ${MAX_COLS} columns of each sheet are shown.`);
  }
  notes.add('Only cell values and number formats are read from the old format — charts, images and styling are not shown.');
  notes.add('Formulas are not recalculated — the value stored in the file is shown.');

  return { sheets, notes: [...notes], readonly: XLS_READONLY };
}
