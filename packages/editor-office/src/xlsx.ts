/**
 * XLSX → a grid (read-only).
 *
 * A spreadsheet is not shown as "text out of cells" but as a grid with column
 * and row labels, because a spreadsheet is read by position as much as by
 * content. Formulas are not evaluated — the value Excel saved is displayed, and
 * the formula itself sits in the cell's description.
 */

import { unescapeXml } from './docx-edit.js';
import { attr, attrNum, openArchive, readRelationships, readText, readXml, tags, type Archive } from './ooxml.js';
import { t } from '@uleditor/i18n';

export type CellKind = 'number' | 'text' | 'bool' | 'error' | 'date';

export interface Cell {
  text: string;
  kind: CellKind;
  formula?: string;
  /** The value as the file stores it — kept where the grid may be written out
   *  again as a fresh file (the `.xls` conversion). */
  raw?: number | string | boolean;
  /** The number format behind `text`: a built-in id, or the custom code. */
  fmt?: number | string;
  /** The value is a formula's cached result — a conversion loses the formula. */
  fromFormula?: boolean;
}

export interface Merge {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface Sheet {
  name: string;
  /** Where the sheet lives in the archive — editing rewrites that part. */
  path: string;
  rows: number;
  cols: number;
  /** The key is `row,column`, both 0-based. Sparse sheets cost no memory. */
  cells: Map<string, Cell>;
  merges: Merge[];
  widths: Map<number, number>;
}

export interface Workbook {
  sheets: Sheet[];
  notes: string[];
  /** The opened archive, kept for the save — see `xlsx-edit.ts`. Absent for the
   *  old binary format, which is never written back. */
  archive?: Archive;
  /**
   * Which dialect the archive is written back in.
   *
   * Both are a ZIP of XML edited by byte range, and both keep every part the
   * person did not touch — but the cells are named differently enough that the
   * writer cannot be shared. Absent means OOXML, which is what a `Workbook`
   * meant before there was a second kind.
   */
  kind?: 'ooxml' | 'odf';
  /**
   * Saving means writing a fresh `.xlsx` from the grid, not touching the
   * original — the old binary format has no safe seam to write into. Set for
   * `.xls`; `losses` is what the conversion cannot carry, said before it
   * happens, and `target` is where the converted file went once it has.
   */
  convert?: { losses: string[]; target?: string };
}

/**
 * Excel's own limit, which is to say no limit of this program's.
 *
 * It was 5 000, on the grounds that above it "the viewer stops being usable" —
 * which was true of a grid that put every cell in the page. It also meant that
 * a till's six-month receipt analysis, 10 831 rows, opened showing the first
 * 5 000 and could not be searched past them: the most recent months were not
 * in the program at all. The grid draws only the rows in view now, so the
 * number of rows is the file's business.
 */
export const MAX_ROWS = 1_048_576;
/** Columns are still all drawn, so they are still bounded. */
export const MAX_COLS = 256;

/** The note for a sheet that reached past what is shown — one sentence for every reader. */
export function truncationNote(): string {
  return t('Only the first {cols} columns of each sheet are shown.', { cols: MAX_COLS });
}

/* ── cell references ─────────────────────────────────────────────────── */

export function columnName(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function parseRef(ref: string): { row: number; col: number } | null {
  let at = 0;
  let col = 0;
  for (; at < ref.length; at++) {
    const ch = ref.charCodeAt(at);
    if (ch < 65 || ch > 90) break;
    col = col * 26 + (ch - 64);
  }
  if (at === 0 || at === ref.length) return null;
  let row = 0;
  for (; at < ref.length; at++) {
    const ch = ref.charCodeAt(at);
    if (ch < 48 || ch > 57) return null;
    row = row * 10 + (ch - 48);
  }
  return { row: row - 1, col: col - 1 };
}

/* ── number formats ──────────────────────────────────────────────────── */

/** Excel's built-in formats that are dates or times. */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/*
 * Everything below is worked out once per format code and kept.
 *
 * A sheet has a few dozen distinct formats and can have millions of cells, and
 * the first version of this worked every one of them out afresh for every cell
 * — the skeleton by regex, the decimals by regex, and a new `Intl.NumberFormat`
 * each time, which is the slowest object in the language to construct. Over
 * 2.7 million cells that was most of the reading.
 */
const skeletons = new Map<string, string>();

/** Strips literal parts out of a format code, so `[Red]"kn"` does not look like a date. */
function formatSkeleton(code: string): string {
  let skeleton = skeletons.get(code);
  if (skeleton === undefined) {
    skeleton = code
      .replace(/\[[^\]]*\]/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/\\./g, '');
    skeletons.set(code, skeleton);
  }
  return skeleton;
}

export function isDateFormat(id: number, code: string | undefined): boolean {
  if (BUILTIN_DATE.has(id)) return true;
  if (!code) return false;
  return /[ymdhs]/i.test(formatSkeleton(code));
}

function decimalsOf(code: string | undefined): number {
  if (!code) return -1;
  const dot = formatSkeleton(code).split('.')[1];
  if (!dot) return 0;
  const zeros = /^0+/.exec(dot);
  return zeros ? zeros[0].length : 0;
}

/**
 * An Excel serial number → a date. Zero is 30 December 1899 because of the
 * well-known compatibility bug (Excel believes 1900 was a leap year).
 */
function serialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
}

const dateShapes = new Map<string, 'date' | 'time' | 'both'>();

export function formatDate(serial: number, code: string | undefined): string {
  const key = code ?? '';
  let shape = dateShapes.get(key);
  if (shape === undefined) {
    const skeleton = formatSkeleton(key);
    const hasTime = /[hs]/i.test(skeleton);
    const hasDate = /[ymd]/i.test(skeleton) || !hasTime;
    shape = hasDate && hasTime ? 'both' : hasTime ? 'time' : 'date';
    dateShapes.set(key, shape);
  }

  const date = serialToDate(serial);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}.`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

  if (shape === 'both') return `${day} ${time}`;
  if (shape === 'time') return time;
  return day;
}

const numberFormats = new Map<string, { format: Intl.NumberFormat; percent: boolean }>();

export function formatNumber(value: number, code: string | undefined): string {
  const key = code ?? '';
  let found = numberFormats.get(key);
  if (!found) {
    const skeleton = formatSkeleton(key);
    const percent = skeleton.includes('%');
    const grouped = skeleton.includes('#,#') || skeleton.includes('0,0');
    const decimals = decimalsOf(code);

    const options: Intl.NumberFormatOptions = { useGrouping: grouped };
    if (decimals >= 0) {
      options.minimumFractionDigits = decimals;
      options.maximumFractionDigits = decimals;
    } else {
      options.maximumFractionDigits = 10;
    }
    found = { format: new Intl.NumberFormat('hr-HR', options), percent };
    numberFormats.set(key, found);
  }

  const scaled = found.percent ? value * 100 : value;
  return `${found.format.format(scaled)}${found.percent ? ' %' : ''}`;
}

/* ── reading a part without building a DOM of it ─────────────────────── */

/**
 * The tags of a part, one at a time, with nothing built that is not asked for.
 *
 * `DOMParser` is what this module read worksheets with, and it is the wrong
 * tool for a worksheet: it builds every element of the part as an object before
 * the first cell can be looked at, and then this code threw most of them away.
 * Measured on a 100 000-row sheet — 11 MB zipped, not an exotic size for a
 * till's six-month export — it took **13.7 seconds and 579 MB** to read, and
 * kept 5 000 rows of the result. This walks the text once and allocates only
 * what a cell turns into.
 *
 * Namespace prefixes are ignored the way the DOM readers ignore them, by local
 * name; comments and processing instructions are stepped over; CDATA is text.
 */
class TagReader {
  private readonly xml: string;
  pos = 0;
  start = 0;
  end = 0;
  name = '';
  closing = false;
  selfClosing = false;

  constructor(xml: string) {
    this.xml = xml;
  }

  next(): boolean {
    const xml = this.xml;
    const length = xml.length;
    for (;;) {
      const lt = xml.indexOf('<', this.pos);
      if (lt === -1) return false;
      const first = xml.charCodeAt(lt + 1);

      if (first === 33 /* ! */) {
        const close = xml.startsWith('<!--', lt)
          ? xml.indexOf('-->', lt + 4) + 3
          : xml.startsWith('<![CDATA[', lt)
            ? xml.indexOf(']]>', lt + 9) + 3
            : xml.indexOf('>', lt) + 1;
        this.pos = close <= lt ? length : close;
        continue;
      }
      if (first === 63 /* ? */) {
        const close = xml.indexOf('?>', lt);
        this.pos = close === -1 ? length : close + 2;
        continue;
      }

      const closing = first === 47; /* / */
      let at = closing ? lt + 2 : lt + 1;
      const nameStart = at;
      let colon = -1;
      for (; at < length; at++) {
        const ch = xml.charCodeAt(at);
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47 || ch === 62) break;
        if (ch === 58) colon = at;
      }
      this.name = xml.slice(colon === -1 ? nameStart : colon + 1, at);

      // An attribute value may hold a `>`, so the end is found outside quotes.
      let quote = 0;
      for (; at < length; at++) {
        const ch = xml.charCodeAt(at);
        if (quote) {
          if (ch === quote) quote = 0;
        } else if (ch === 34 || ch === 39) {
          quote = ch;
        } else if (ch === 62) {
          break;
        }
      }
      if (at >= length) return false;

      this.start = lt;
      this.end = at + 1;
      this.closing = closing;
      this.selfClosing = xml.charCodeAt(at - 1) === 47;
      this.pos = at + 1;
      return true;
    }
  }

  /** The raw text of the last tag, for its attributes. */
  tag(): string {
    return this.xml.slice(this.start, this.end);
  }

  /**
   * The character data after the last tag, up to the next one — as a parser
   * would hand it over: entities resolved, CDATA taken as it is, and line ends
   * normalised the way XML requires, so a `\r\n` in a cell is the `\n` the DOM
   * readers always gave.
   */
  text(): string {
    const xml = this.xml;
    let out = '';
    let at = this.end;
    for (;;) {
      const lt = xml.indexOf('<', at);
      const stop = lt === -1 ? xml.length : lt;
      if (stop > at) {
        let raw = xml.slice(at, stop);
        if (raw.indexOf('\r') !== -1) raw = raw.replace(/\r\n?/g, '\n');
        out += raw.indexOf('&') === -1 ? raw : unescapeXml(raw);
      }
      if (lt !== -1 && xml.startsWith('<![CDATA[', lt)) {
        const close = xml.indexOf(']]>', lt + 9);
        out += xml.slice(lt + 9, close === -1 ? xml.length : close);
        at = close === -1 ? xml.length : close + 3;
        continue;
      }
      if (lt !== -1 && xml.startsWith('<!--', lt)) {
        const close = xml.indexOf('-->', lt + 4);
        at = close === -1 ? xml.length : close + 3;
        continue;
      }
      this.pos = stop;
      return out;
    }
  }
}

const ATTR = new Map<string, RegExp>();

/** One attribute of a tag's raw text, by local name. */
function attrOf(tag: string, name: string): string | null {
  let pattern = ATTR.get(name);
  if (!pattern) {
    pattern = new RegExp(`\\s(?:[A-Za-z_][\\w.-]*:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    ATTR.set(name, pattern);
  }
  const match = pattern.exec(tag);
  return match ? unescapeXml(match[1] ?? match[2] ?? '') : null;
}

/**
 * The three attributes of a `<c>` a cell needs, read in one pass.
 *
 * `attrOf` is a regular expression per attribute, which is nothing for a
 * `<mergeCell>` and most of the reading for a sheet of millions of cells —
 * three of them for every `<c>`. This reads `r`, `s` and `t` by character
 * code and allocates only their values.
 */
function cellAttributes(xml: string, start: number, end: number): { r: string; s: number; t: string } {
  let r = '';
  let s = 0;
  let t = 'n';
  let at = start + 1;
  // Past the element name.
  while (at < end) {
    const ch = xml.charCodeAt(at);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) break;
    at++;
  }
  while (at < end) {
    // Skip whitespace to the next attribute name.
    let ch = xml.charCodeAt(at);
    while (at < end && (ch === 32 || ch === 9 || ch === 10 || ch === 13)) ch = xml.charCodeAt(++at);
    const nameStart = at;
    while (at < end && ch !== 61 /* = */ && ch !== 62 && ch !== 47 && ch !== 32) ch = xml.charCodeAt(++at);
    const nameEnd = at;
    while (at < end && xml.charCodeAt(at) !== 34 && xml.charCodeAt(at) !== 39) {
      if (xml.charCodeAt(at) === 62) return { r, s, t };
      at++;
    }
    if (at >= end) break;
    const quote = xml.charCodeAt(at);
    const valueStart = at + 1;
    const valueEnd = xml.indexOf(quote === 34 ? '"' : "'", valueStart);
    if (valueEnd === -1 || valueEnd > end) break;
    // By local name: a prefixed attribute is the same attribute.
    let local = nameStart;
    for (let i = nameStart; i < nameEnd; i++) if (xml.charCodeAt(i) === 58) local = i + 1;
    if (nameEnd - local === 1) {
      const name = xml.charCodeAt(local);
      if (name === 114 /* r */) r = xml.slice(valueStart, valueEnd);
      else if (name === 115 /* s */) s = Number(xml.slice(valueStart, valueEnd)) || 0;
      else if (name === 116 /* t */) t = xml.slice(valueStart, valueEnd);
    }
    at = valueEnd + 1;
  }
  return { r, s, t };
}

/* ── shared formulas ─────────────────────────────────────────────────── */

/**
 * A shared formula as the cell that depends on it holds it.
 *
 * Excel writes a column of identical formulas once: the first cell carries the
 * text and every cell after it says only `<f t="shared" si="1"/>`. The reader
 * before this one took a formula from its text and found none there — so those
 * cells were offered for retyping, the writer refused them without a word, and
 * the view went on showing the typed value after a save that had not written
 * it. A real membership list does exactly this: `=ROW()-1` down column B, one
 * cell with the text and 27 without.
 *
 * Only A1 references outside string literals move, and a `$` holds its part in
 * place. A name that happens to look like a reference would be moved too; that
 * is the one thing this gets wrong, and it can only be wrong about what the
 * tooltip says — the cell is refused either way.
 */
export function shiftFormula(text: string, rows: number, cols: number): string {
  if (rows === 0 && cols === 0) return text;
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            /(^|[^A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)([0-9]{1,7})(?![A-Za-z0-9_(])/g,
            (whole, before: string, colFixed: string, letters: string, rowFixed: string, digits: string) => {
              let col = 0;
              for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
              col -= 1;
              let row = Number(digits) - 1;
              if (!colFixed) col += cols;
              if (!rowFixed) row += rows;
              if (col < 0 || row < 0 || col >= 16384 || row >= 1048576) return `${before}#REF!`;
              return `${before}${colFixed}${columnName(col)}${rowFixed}${row + 1}`;
            },
          ),
    )
    .join('');
}

/* ── reading ─────────────────────────────────────────────────────────── */

/**
 * Every string the sheets point at by index.
 *
 * Read with the same walker as the sheets, because a large export keeps its
 * text here — ten thousand receipts with ten thousand different descriptions
 * is a shared-string table of that length. Phonetic guides (`rPh`) are not
 * part of what a cell says and are left out; the DOM reader had included them,
 * and no workbook here has any.
 */
function readSharedStrings(archive: Archive): string[] {
  const xml = readText(archive, 'xl/sharedStrings.xml');
  if (!xml) return [];

  const reader = new TagReader(xml);
  const out: string[] = [];
  let open = false;
  let phonetic = 0;
  let text = '';

  while (reader.next()) {
    const name = reader.name;
    if (reader.closing) {
      if (name === 'si' && open) {
        out.push(text);
        open = false;
      } else if (name === 'rPh') {
        phonetic--;
      }
      continue;
    }
    if (name === 'si') {
      if (reader.selfClosing) out.push('');
      else {
        open = true;
        text = '';
      }
    } else if (name === 'rPh') {
      if (!reader.selfClosing) phonetic++;
    } else if (name === 't' && open && phonetic === 0 && !reader.selfClosing) {
      text += reader.text();
    }
  }
  return out;
}

/** What each style index means for the value it styles, worked out once per index. */
interface StyleBook {
  formats: (string | undefined)[];
  ids: number[];
  dates: (boolean | undefined)[];
}

/** Style index → number format code. */
function readStyles(archive: Archive): StyleBook {
  const doc = readXml(archive, 'xl/styles.xml');
  if (!doc) return { formats: [], ids: [], dates: [] };

  const custom = new Map<number, string>();
  for (const node of tags(doc, 'numFmt')) {
    const id = attrNum(node, 'numFmtId');
    const code = attr(node, 'formatCode');
    if (id !== null && code) custom.set(id, code);
  }

  const container = tags(doc, 'cellXfs')[0];
  const ids: number[] = [];
  const formats: (string | undefined)[] = [];
  for (const xf of container ? [...container.children] : []) {
    const id = attrNum(xf, 'numFmtId') ?? 0;
    ids.push(id);
    formats.push(custom.get(id));
  }
  return { formats, ids, dates: [] };
}

function isDateStyle(styles: StyleBook, index: number): boolean {
  let known = styles.dates[index];
  if (known === undefined) {
    known = isDateFormat(styles.ids[index] ?? 0, styles.formats[index]);
    styles.dates[index] = known;
  }
  return known;
}

/** The value a cell shows, from what its `<c>` held. `null` for a cell with nothing in it. */
function cellOf(
  type: string,
  value: string | null,
  inline: string | null,
  styleIndex: number,
  shared: string[],
  styles: StyleBook,
): Cell | null {
  if (type === 'inlineStr') return inline ? { text: inline, kind: 'text' } : null;
  if (value === null || value === '') return null;

  switch (type) {
    case 's': {
      const text = shared[Number(value)] ?? '';
      return text ? { text, kind: 'text' } : null;
    }
    case 'str':
      return { text: value, kind: 'text' };
    case 'b':
      return { text: value === '1' ? t('TRUE') : t('FALSE'), kind: 'bool' };
    case 'e':
      return { text: value, kind: 'error' };
    default: {
      const number = Number(value);
      if (!Number.isFinite(number)) return { text: value, kind: 'text' };
      const code = styles.formats[styleIndex];
      if (isDateStyle(styles, styleIndex)) return { text: formatDate(number, code), kind: 'date' };
      return { text: formatNumber(number, code), kind: 'number' };
    }
  }
}

interface ReadSheet {
  cells: Map<string, Cell>;
  rows: number;
  cols: number;
  merges: Merge[];
  widths: Map<number, number>;
  truncated: boolean;
}

/**
 * One worksheet, read by walking its text.
 *
 * Two things are read differently from the DOM reader it replaces, both on
 * purpose. **A cell with a formula is a formula cell whatever else it holds** —
 * a shared formula's dependents have no text of their own, an array formula's
 * other cells have no `<f>` at all, and a formula whose result is empty has no
 * value; each of those was offered for retyping and refused by the writer
 * without a word. And **a cell without an `r`** is skipped, as the writer
 * skips it, rather than placed where it probably is: a value the writer cannot
 * find is a value that can be typed over and never saved.
 */
function readSheet(xml: string, shared: string[], styles: StyleBook): ReadSheet {
  const reader = new TagReader(xml);
  const cells = new Map<string, Cell>();
  const merges: Merge[] = [];
  const widths = new Map<number, number>();
  const masters = new Map<string, { text: string; row: number; col: number }>();
  const arrays: { row: number; col: number; rows: number; cols: number; text: string }[] = [];
  /* Zero, not minus one: an empty sheet is still drawn as one cell, which is
     where somebody types the first value into it. */
  let maxRow = 0;
  let maxCol = 0;
  let truncated = false;

  let inData = false;
  let inCell = false;
  let inInline = false;
  let phonetic = 0;
  let row = 0;
  let col = 0;
  let type = 'n';
  let styleIndex = 0;
  let value: string | null = null;
  let inline: string | null = null;
  let formula: string | undefined;

  const finish = () => {
    inCell = false;
    if (row >= MAX_ROWS || col >= MAX_COLS) {
      truncated = true;
      return;
    }
    let cell = cellOf(type, value, inline, styleIndex, shared, styles);
    if (formula !== undefined) {
      /* A formula whose result is empty still belongs in the grid, or the
         empty space it leaves is an invitation to type over it. */
      cell = cell ? { ...cell, formula } : { text: '', kind: 'text', formula };
    }
    if (!cell) return;
    cells.set(`${row},${col}`, cell);
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  };

  while (reader.next()) {
    const name = reader.name;

    if (reader.closing) {
      if (name === 'c') {
        if (inCell) finish();
      } else if (name === 'is') {
        inInline = false;
      } else if (name === 'rPh') {
        phonetic--;
      } else if (name === 'sheetData') {
        inData = false;
      }
      continue;
    }

    switch (name) {
      case 'sheetData':
        inData = !reader.selfClosing;
        break;

      case 'c': {
        if (!inData) break;
        if (reader.selfClosing) break;
        const attributes = cellAttributes(xml, reader.start, reader.end);
        const position = parseRef(attributes.r);
        if (!position) break;
        inCell = true;
        row = position.row;
        col = position.col;
        type = attributes.t;
        styleIndex = attributes.s;
        value = null;
        inline = null;
        formula = undefined;
        break;
      }

      case 'v':
        if (inCell && !reader.selfClosing) value = reader.text();
        break;

      case 'f': {
        if (!inCell) break;
        const tag = reader.tag();
        const text = reader.selfClosing ? '' : reader.text().trim();
        const kind = attrOf(tag, 't');
        const si = attrOf(tag, 'si');
        if (kind === 'shared' && si !== null) {
          if (text) {
            masters.set(si, { text, row, col });
            formula = text;
          } else {
            const master = masters.get(si);
            /* A dependent whose master was never written is malformed, and is
               still a formula: refused, with nothing better to show. */
            formula = master ? shiftFormula(master.text, row - master.row, col - master.col) : '…';
          }
        } else {
          formula = text || '…';
          if (kind === 'array') {
            const [from, to] = (attrOf(tag, 'ref') ?? '').split(':');
            const a = from ? parseRef(from) : null;
            const b = to ? parseRef(to) : a;
            if (a && b && (b.row > a.row || b.col > a.col)) {
              arrays.push({ row: a.row, col: a.col, rows: b.row - a.row + 1, cols: b.col - a.col + 1, text: formula });
            }
          }
        }
        break;
      }

      case 'is':
        if (inCell && !reader.selfClosing) {
          inInline = true;
          inline = '';
        }
        break;

      case 'rPh':
        if (!reader.selfClosing) phonetic++;
        break;

      case 't':
        if (inInline && phonetic === 0 && !reader.selfClosing) inline += reader.text();
        break;

      case 'mergeCell': {
        const [from, to] = (attrOf(reader.tag(), 'ref') ?? '').split(':');
        const start = from ? parseRef(from) : null;
        const end = to ? parseRef(to) : null;
        if (!start || !end) break;
        merges.push({ row: start.row, col: start.col, rows: end.row - start.row + 1, cols: end.col - start.col + 1 });
        break;
      }

      case 'col': {
        const tag = reader.tag();
        const [min, max, width] = ['min', 'max', 'width'].map((key) => {
          const raw = attrOf(tag, key);
          return raw === null ? NaN : Number(raw);
        }) as [number, number, number];
        if (!(min >= 1) || !(max >= min) || !Number.isFinite(width)) break;
        for (let i = min - 1; i < Math.min(max, MAX_COLS); i++) widths.set(i, Math.round(width * 7 + 8));
        break;
      }
    }
  }

  /*
   * The other cells of an array formula carry its results and no `<f>` of their
   * own; Excel will not let one of them be changed on its own, and neither may
   * this. Walked by range when the range is small, by the cells when it is not
   * — an array over a whole column is legal.
   */
  for (const array of arrays) {
    const inside = (r: number, c: number) =>
      r >= array.row && r < array.row + array.rows && c >= array.col && c < array.col + array.cols;
    if (array.rows * array.cols <= 100_000) {
      for (let r = array.row; r < array.row + array.rows; r++) {
        for (let c = array.col; c < array.col + array.cols; c++) {
          if (r >= MAX_ROWS || c >= MAX_COLS) continue;
          const key = `${r},${c}`;
          const cell = cells.get(key);
          cells.set(key, cell ? { ...cell, formula: array.text } : { text: '', kind: 'text', formula: array.text });
          if (r > maxRow) maxRow = r;
          if (c > maxCol) maxCol = c;
        }
      }
    } else {
      for (const [key, cell] of cells) {
        const [r, c] = key.split(',').map(Number) as [number, number];
        if (inside(r, c)) cells.set(key, { ...cell, formula: array.text });
      }
    }
  }

  return { cells, rows: maxRow + 1, cols: maxCol + 1, merges, widths, truncated };
}

export function readXlsx(bytes: Uint8Array): Workbook {
  const archive = openArchive(bytes);
  const workbook = readXml(archive, 'xl/workbook.xml');
  if (!workbook) {
    throw new Error(
      t('The file has no `xl/workbook.xml`. The older binary `.xls` is not supported — save it as .xlsx.'),
    );
  }

  const rels = readRelationships(archive, 'xl/workbook.xml');
  const shared = readSharedStrings(archive);
  const styles = readStyles(archive);
  const notes = new Set<string>();

  const sheets: Sheet[] = [];

  for (const node of tags(workbook, 'sheet')) {
    const name = attr(node, 'name') ?? `List ${sheets.length + 1}`;
    const relId = attr(node, 'id');
    const path = relId ? rels.get(relId)?.target : undefined;
    const xml = path ? readText(archive, path) : null;
    if (!path || xml === null) continue;

    const read = readSheet(xml, shared, styles);
    if (read.truncated) notes.add(truncationNote());

    sheets.push({
      name,
      path,
      rows: read.rows,
      cols: read.cols,
      cells: read.cells,
      merges: read.merges,
      widths: read.widths,
    });
  }

  if (sheets.length === 0) throw new Error(t('The workbook has no readable sheet.'));

  if (Object.keys(archive).some((n) => n.startsWith('xl/charts/'))) {
    notes.add('Charts are not shown.');
  }
  if (Object.keys(archive).some((n) => n.startsWith('xl/media/'))) {
    notes.add('Images inside sheets are not shown.');
  }
  if (tags(workbook, 'definedName').some((n) => (attr(n, 'name') ?? '').startsWith('_xlnm.'))) {
    notes.add('Filters and frozen panes are not applied.');
  }
  notes.add('Formulas are not recalculated — the value stored in the file is shown.');

  return { sheets, notes: [...notes], archive };
}

/* The grid a sheet is drawn in lives in `sheet-grid.ts` — it draws only the rows in view. */
