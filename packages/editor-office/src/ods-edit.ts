/**
 * Editing cells in an OpenDocument spreadsheet — in the file it came from.
 *
 * The same contract as [`xlsx-edit.ts`](./xlsx-edit.ts) and
 * [`docx-edit.ts`](./docx-edit.ts): the XML is never re-serialised, the
 * replacement is done by byte range, and every part of the archive outside the
 * edited cells passes through character for character identical. Saving an
 * `.ods` therefore produces an `.ods` — not a converted copy in somebody else's
 * format, which is what this replaced.
 *
 * **The hard part is that a cell has no address.** A worksheet in OOXML says
 * `<c r="B4">` and can be found by name; here a cell's position is wherever the
 * counting has reached, and the counting is done in repeat attributes:
 * `table:number-columns-repeated="1021"` stands for a thousand cells nobody
 * wrote. Editing one cell inside such a group means **splitting it** — the run
 * before it, the cell itself, the run after — because there is no other way to
 * give one of a thousand identical cells a value of its own.
 *
 * Only rows holding an edit are rebuilt, and inside a rebuilt row every cell
 * the person did not touch is copied across as its original bytes.
 */

import { strToU8, zipSync } from 'fflate';

import type { Archive } from './ooxml.js';
import { escapeXml, localName, scanTags } from './docx-edit.js';

/* ── reading the sheet's shape ───────────────────────────────────────── */

export interface OdsCellSpan {
  /** The first column this cell stands for, 0-based. */
  col: number;
  /** How many columns it stands for — `table:number-columns-repeated`. */
  repeat: number;
  /** The whole `<table:table-cell …>…</table:table-cell>`, or its empty form. */
  start: number;
  end: number;
  /** Kept on a rewrite: the number format, and the reach of a merge. */
  style: string | null;
  spanCols: string | null;
  spanRows: string | null;
  /** A formula cell is refused, never overwritten — see `xlsx-edit.ts`. */
  formula: boolean;
  /** A covered cell belongs to the merge above or to the left of it. */
  covered: boolean;
}

export interface OdsRowSpan {
  /** The first row this element stands for, 0-based. */
  row: number;
  repeat: number;
  start: number;
  end: number;
  /** The opening tag alone — where the repeat attribute is rewritten. */
  openEnd: number;
  /** Just before `</table:table-row>`, where a new cell may be appended. */
  contentEnd: number;
  cells: OdsCellSpan[];
}

export interface OdsTableSpans {
  name: string;
  rows: OdsRowSpan[];
}

function attrIn(xml: string, tag: { start: number; end: number }, name: string): string | null {
  const body = xml.slice(tag.start, tag.end);
  const match = new RegExp(`\\b${name}=["']([^"']*)["']`).exec(body);
  return match ? match[1]! : null;
}

function repeatOf(xml: string, tag: { start: number; end: number }, name: string): number {
  const raw = attrIn(xml, tag, name);
  const value = raw === null ? 1 : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Maps every sheet, row and cell of a `content.xml` to its byte range.
 *
 * Only tables at the top of the spreadsheet body count as sheets; a table
 * nested inside a cell is part of that cell, not a sheet of its own.
 */
export function findOdsCells(xml: string): OdsTableSpans[] {
  const tables: OdsTableSpans[] = [];

  let depth = 0;
  let table: OdsTableSpans | null = null;
  let openRow: OdsRowSpan | null = null;
  let openCell: OdsCellSpan | null = null;
  let row = 0;
  let col = 0;

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (local === 'table') {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) table = null;
        continue;
      }
      depth += 1;
      if (depth === 1 && !tag.selfClosing) {
        table = { name: attrIn(xml, tag, 'table:name') ?? '', rows: [] };
        tables.push(table);
        row = 0;
      }
      if (tag.selfClosing) depth -= 1;
      continue;
    }

    if (depth !== 1 || !table) continue;

    if (local === 'table-row') {
      if (tag.closing) {
        if (openRow) {
          openRow.end = tag.end;
          openRow.contentEnd = tag.start;
        }
        openRow = null;
        continue;
      }
      const repeat = repeatOf(xml, tag, 'table:number-rows-repeated');
      const span: OdsRowSpan = {
        row,
        repeat,
        start: tag.start,
        end: tag.end,
        openEnd: tag.end,
        contentEnd: tag.end,
        cells: [],
      };
      table.rows.push(span);
      row += repeat;
      col = 0;
      openRow = tag.selfClosing ? null : span;
      continue;
    }

    if (local === 'table-cell' || local === 'covered-table-cell') {
      if (tag.closing) {
        if (openCell) openCell.end = tag.end;
        openCell = null;
        continue;
      }
      if (!openRow) continue;

      const repeat = repeatOf(xml, tag, 'table:number-columns-repeated');
      const span: OdsCellSpan = {
        col,
        repeat,
        start: tag.start,
        end: tag.end,
        style: attrIn(xml, tag, 'table:style-name'),
        spanCols: attrIn(xml, tag, 'table:number-columns-spanned'),
        spanRows: attrIn(xml, tag, 'table:number-rows-spanned'),
        formula: attrIn(xml, tag, 'table:formula') !== null,
        covered: local === 'covered-table-cell',
      };
      openRow.cells.push(span);
      col += repeat;
      openCell = tag.selfClosing ? null : span;
    }
  }

  return tables;
}

/* ── what a typed value becomes ──────────────────────────────────────── */

/** `12,5` is what a Croatian keyboard writes for twelve and a half. */
function numberOf(value: string): string | null {
  const normalized = value.trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

/**
 * `15.6.2026.` → `2026-06-15`, which is how OpenDocument stores a date.
 *
 * No serial number and no epoch bug: the format writes the date as a date, and
 * the cell's own style keeps drawing it the way the sheet already drew it.
 */
function isoDateOf(value: string): string | null {
  const match = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\.?$/.exec(value.trim());
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The rebuilt element. The value decides the type; style and merge are kept. */
export function odsCellXml(cell: OdsCellSpan, value: string, repeat = 1): string {
  const attrs =
    (cell.style ? ` table:style-name="${cell.style}"` : '') +
    (repeat > 1 ? ` table:number-columns-repeated="${repeat}"` : '') +
    (cell.spanCols ? ` table:number-columns-spanned="${cell.spanCols}"` : '') +
    (cell.spanRows ? ` table:number-rows-spanned="${cell.spanRows}"` : '');

  if (value === '') return `<table:table-cell${attrs}/>`;

  const shown = `<text:p>${escapeXml(value)}</text:p>`;

  const iso = isoDateOf(value);
  if (iso) {
    return `<table:table-cell${attrs} office:value-type="date" office:date-value="${iso}">${shown}</table:table-cell>`;
  }

  const number = numberOf(value);
  if (number) {
    return `<table:table-cell${attrs} office:value-type="float" office:value="${number}">${shown}</table:table-cell>`;
  }

  return `<table:table-cell${attrs} office:value-type="string">${shown}</table:table-cell>`;
}

/** The same cell as it stands, with a different repeat count on it. */
function withRepeat(xml: string, cell: OdsCellSpan, repeat: number): string {
  const text = xml.slice(cell.start, cell.end);
  const stripped = text.replace(/\s+table:number-columns-repeated=["'][^"']*["']/, '');
  if (repeat <= 1) return stripped;
  return stripped.replace(/^(<[^\s/>]+)/, `$1 table:number-columns-repeated="${repeat}"`);
}

/** The same row as it stands, with a different repeat count on it. */
function rowWithRepeat(xml: string, row: OdsRowSpan, repeat: number): string {
  const text = xml.slice(row.start, row.end);
  const stripped = text.replace(/\s+table:number-rows-repeated=["'][^"']*["']/, '');
  if (repeat <= 1) return stripped;
  return stripped.replace(/^(<[^\s/>]+)/, `$1 table:number-rows-repeated="${repeat}"`);
}

/* ── writing ─────────────────────────────────────────────────────────── */

export interface OdsEdit {
  /** The sheet's ordinal — a table in this file has a name, not an address. */
  sheet: number;
  row: number;
  col: number;
  value: string;
}

/**
 * An empty cell wide enough to reach the column being written.
 *
 * A row that stops at column C cannot have a value put in column F without
 * saying what stands between them, and "nothing, three times" is how the format
 * says it.
 */
function padding(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '<table:table-cell/>'
    : `<table:table-cell table:number-columns-repeated="${count}"/>`;
}

/**
 * Writes one value into `content.xml`, changing only the row that holds it.
 *
 * A repeated row or cell is split around the edit, because one of a thousand
 * identical cells cannot be given a value while it is still one of a thousand.
 * The parts either side keep their original bytes and carry the counts that are
 * left over.
 */
export function applyOdsEdit(xml: string, spans: OdsTableSpans[], edit: OdsEdit): string {
  const table = spans[edit.sheet];
  if (!table) return xml;

  const row = table.rows.find((r) => edit.row >= r.row && edit.row < r.row + r.repeat);
  if (!row) return xml;

  const cell = row.cells.find((c) => edit.col >= c.col && edit.col < c.col + c.repeat);
  /* Refused upstream and refused again here: a formula's cached number is a
     result, and a literal in its place is the quietest way to break a sheet. */
  if (cell?.formula) return xml;
  if (!cell && edit.value === '') return xml;

  /* The row's own content, rebuilt: untouched cells keep their bytes, the
     edited one is replaced, and a repeated group around it is split. */
  let body = '';
  let written = 0;

  for (const c of row.cells) {
    if (edit.col < c.col || edit.col >= c.col + c.repeat) {
      body += xml.slice(c.start, c.end);
      written = c.col + c.repeat;
      continue;
    }
    const before = edit.col - c.col;
    const after = c.col + c.repeat - edit.col - 1;
    if (before > 0) body += withRepeat(xml, c, before);
    body += odsCellXml(c, edit.value);
    if (after > 0) body += withRepeat(xml, c, after);
    written = c.col + c.repeat;
  }

  if (!cell) {
    body += padding(edit.col - written);
    body += odsCellXml(
      { col: edit.col, repeat: 1, start: 0, end: 0, style: null, spanCols: null, spanRows: null, formula: false, covered: false },
      edit.value,
    );
  }

  const opening = xml.slice(row.start, row.openEnd).replace(
    /\s+table:number-rows-repeated=["'][^"']*["']/,
    '',
  );
  const edited = `${opening}${body}</table:table-row>`;

  const before = edit.row - row.row;
  const after = row.row + row.repeat - edit.row - 1;
  const replacement =
    (before > 0 ? rowWithRepeat(xml, row, before) : '') +
    edited +
    (after > 0 ? rowWithRepeat(xml, row, after) : '');

  return xml.slice(0, row.start) + replacement + xml.slice(row.end);
}

/**
 * Writes every edit, one at a time.
 *
 * The file is re-scanned between them on purpose. Splitting a repeated row
 * moves everything after it and can turn one row element into three, so offsets
 * gathered before an edit mean nothing after it — and two edits inside the same
 * repeated group interact in a way no single pass would get right. The cost is
 * a scan per edited cell, which is nothing beside a save.
 */
export function applyOdsEdits(xml: string, edits: OdsEdit[]): string {
  let out = xml;
  for (const edit of edits) out = applyOdsEdit(out, findOdsCells(out), edit);
  return out;
}

/**
 * Assembles the `.ods` back, with the edited `content.xml` in it.
 *
 * `mimetype` goes back **first and uncompressed**. It is not a formality: that
 * is what lets a program tell what the file is from its first bytes without
 * unpacking it, which is how this program's own detection recognises one. A
 * rebuilt archive that deflates it, or writes it second, is a file every other
 * office suite opens and ours does not.
 */
export function writeOds(archive: Archive, contentXml: string): Uint8Array {
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};

  const mimetype = archive['mimetype'];
  if (mimetype) files['mimetype'] = [mimetype, { level: 0 }];

  for (const [path, data] of Object.entries(archive)) {
    if (path === 'mimetype') continue;
    files[path] = data;
  }
  files['content.xml'] = strToU8(contentXml);

  return zipSync(files as Parameters<typeof zipSync>[0]);
}
