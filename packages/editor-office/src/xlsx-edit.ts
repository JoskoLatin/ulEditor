/**
 * Editing cells in a spreadsheet — surgically, one cell at a time.
 *
 * The same contract as [`docx-edit.ts`](./docx-edit.ts): the XML is never
 * re-serialised, the replacement is done by byte range, and everything outside
 * the touched element stays character for character identical. One `<c>` is
 * rebuilt whole — its value decides its type, so the attributes cannot fall out
 * of step with the content — while `r` and `s` are carried over: the reference
 * because it is the cell's identity, the style because the person changed a
 * value, not how the sheet chooses to show it.
 *
 * **A formula is refused, not overwritten.** A cell holding `=SUM(B2:B3)` shows
 * a number, but the number is a result; replacing it with a literal would keep
 * the sheet looking right until the first recalculation, which is the quietest
 * possible way to destroy a workbook. Editing the *inputs* of a formula is
 * allowed — and because their cached results then go stale, the workbook is
 * marked for a full recalculation on open (see `markRecalc`).
 */

import { strToU8, zipSync } from 'fflate';

import type { Archive } from './ooxml.js';
import { escapeXml, localName, scanTags } from './docx-edit.js';

/* ── references ──────────────────────────────────────────────────────── */

/** `B4` → row 3, column 1 (both 0-based); `null` when it is not a reference. */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)([0-9]+)$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/* ── reading the sheet's shape ───────────────────────────────────────── */

export interface CellSpan {
  ref: string;
  row: number;
  col: number;
  /** The whole `<c>…</c>` element. */
  start: number;
  end: number;
  /** The style index, carried over unchanged on a rewrite. */
  style: string | null;
  /** A formula cell is refused — see the module comment. */
  formula: boolean;
}

export interface RowSpan {
  /** The 1-based row number, as the file writes it. */
  r: number;
  start: number;
  end: number;
  /** Where a new cell may be inserted: just before the closing tag. */
  contentEnd: number;
  cells: CellSpan[];
}

export interface SheetSpans {
  rows: RowSpan[];
  /** Where a new row may be inserted; `null` when the sheet has no `sheetData`. */
  sheetDataEnd: number | null;
}

/** One attribute out of a tag's raw text, quotes of either kind. */
function attrIn(xml: string, tag: { start: number; end: number }, name: string): string | null {
  const body = xml.slice(tag.start, tag.end);
  const match = new RegExp(`\\b${name}=["']([^"']*)["']`).exec(body);
  return match ? match[1]! : null;
}

/** Maps every row and cell of a worksheet to its byte range. */
export function findCells(xml: string): SheetSpans {
  const rows: RowSpan[] = [];
  let sheetDataEnd: number | null = null;

  let openRow: RowSpan | null = null;
  let openCell: CellSpan | null = null;

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (local === 'sheetData' && tag.closing) sheetDataEnd = tag.start;

    if (local === 'row') {
      if (tag.closing) {
        if (openRow) {
          openRow.end = tag.end;
          openRow.contentEnd = tag.start;
        }
        openRow = null;
      } else {
        const r = Number(attrIn(xml, tag, 'r') ?? rows.length + 1);
        openRow = { r, start: tag.start, end: tag.end, contentEnd: tag.end, cells: [] };
        rows.push(openRow);
        if (tag.selfClosing) openRow = null;
      }
      continue;
    }

    if (local === 'c') {
      if (tag.closing) {
        if (openCell) openCell.end = tag.end;
        openCell = null;
        continue;
      }
      const ref = attrIn(xml, tag, 'r');
      const position = ref ? parseCellRef(ref) : null;
      if (!ref || !position || !openRow) continue;

      const span: CellSpan = {
        ref,
        row: position.row,
        col: position.col,
        start: tag.start,
        end: tag.end,
        style: attrIn(xml, tag, 's'),
        formula: false,
      };
      openRow.cells.push(span);
      if (!tag.selfClosing) openCell = span;
      continue;
    }

    if (openCell && local === 'f' && !tag.closing) openCell.formula = true;
  }

  return { rows, sheetDataEnd };
}

/* ── what a typed value becomes ──────────────────────────────────────── */

/**
 * `12,5` is what a Croatian keyboard writes for twelve and a half, so a single
 * comma counts as the decimal point. Anything that does not read whole as a
 * number is text.
 */
function numberOf(value: string): string | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return normalized;
}

/**
 * `15.6.2026.` → the Excel serial for that day, so a date typed the way a
 * person writes one lands in the file as a date and the cell's own format
 * keeps drawing it as one. Serial zero is 30 December 1899 — the well-known
 * compatibility bug the whole format carries.
 */
function dateSerialOf(value: string): string | null {
  const match = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\.?$/.exec(value.trim());
  if (!match) return null;
  const [, day, month, year] = match.map(Number) as unknown as [number, number, number, number];
  const time = Date.UTC(year, month - 1, day);
  if (Number.isNaN(time)) return null;
  const serial = (time - Date.UTC(1899, 11, 30)) / 86400000;
  return serial > 0 ? String(serial) : null;
}

/** What the grid should call the value it just accepted — the same decision `cellXml` makes. */
export function typedKind(value: string): 'number' | 'date' | 'text' {
  if (dateSerialOf(value)) return 'date';
  if (numberOf(value)) return 'number';
  return 'text';
}

/** The rebuilt element. The value decides the type; `r` and `s` are kept. */
export function cellXml(ref: string, style: string | null, value: string): string {
  const s = style ? ` s="${style}"` : '';
  if (value === '') return `<c r="${ref}"${s}/>`;

  const serial = dateSerialOf(value);
  if (serial) return `<c r="${ref}"${s}><v>${serial}</v></c>`;

  const number = numberOf(value);
  if (number) return `<c r="${ref}"${s}><v>${number}</v></c>`;

  /* Inline rather than a shared string: the shared table serves every cell
     that shows the same words, so editing it would edit cells the person
     never touched. An inline string touches exactly one. */
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/* ── writing ─────────────────────────────────────────────────────────── */

export interface CellEdit {
  ref: string;
  value: string;
}

/**
 * Writes the new values into the sheet, changing only their elements.
 *
 * From the end backwards, so the offsets do not shift underfoot. A cell that
 * does not exist yet is inserted where the file keeps its order — cells in
 * column order within the row, rows in number order within `sheetData` — since
 * Excel reads the file in that order and quietly misplaces what breaks it.
 */
export function applyCellEdits(xml: string, spans: SheetSpans, edits: CellEdit[]): string {
  interface Change {
    at: number;
    remove: number;
    insert: string;
  }
  const changes: Change[] = [];

  for (const edit of edits) {
    const position = parseCellRef(edit.ref);
    if (!position) continue;

    const row = spans.rows.find((r) => r.r === position.row + 1);
    const existing = row?.cells.find((c) => c.ref === edit.ref);

    if (existing) {
      if (existing.formula) continue; // Refused upstream; never overwritten here.
      changes.push({
        at: existing.start,
        remove: existing.end - existing.start,
        insert: cellXml(edit.ref, existing.style, edit.value),
      });
      continue;
    }

    // Clearing a cell the file does not have is already done.
    if (edit.value === '') continue;

    if (row) {
      const after = row.cells.find((c) => c.col > position.col);
      changes.push({
        at: after ? after.start : row.contentEnd,
        remove: 0,
        insert: cellXml(edit.ref, null, edit.value),
      });
      continue;
    }

    if (spans.sheetDataEnd === null) continue;
    const nextRow = spans.rows.find((r) => r.r > position.row + 1);
    changes.push({
      at: nextRow ? nextRow.start : spans.sheetDataEnd,
      remove: 0,
      insert: `<row r="${position.row + 1}">${cellXml(edit.ref, null, edit.value)}</row>`,
    });
  }

  let out = xml;
  for (const change of changes.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, change.at) + change.insert + out.slice(change.at + change.remove);
  }
  return out;
}

/**
 * Marks the workbook for a full recalculation when it is next opened.
 *
 * An edited input leaves every formula's cached result stale, and Excel
 * trusts the cache unless told otherwise — the file would show yesterday's
 * totals over today's numbers. One attribute says otherwise.
 */
export function markRecalc(workbookXml: string): string {
  if (/fullCalcOnLoad=/.test(workbookXml)) return workbookXml;
  if (/<calcPr\b/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  }
  return workbookXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/**
 * Assembles a new `.xlsx` with the edited sheets.
 *
 * Every part outside `parts` passes through untouched, exactly as
 * [`writeDocx`](./docx-edit.ts) passes a Word archive through. The workbook
 * part is patched for recalculation only when the workbook holds a formula at
 * all — a book of plain values has nothing to go stale.
 */
export function writeXlsx(archive: Archive, parts: Map<string, string>): Uint8Array {
  const next: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(archive)) next[path] = data;
  for (const [path, xml] of parts) next[path] = strToU8(xml);

  const hasFormulas = Object.keys(archive).some((path) => {
    if (!path.startsWith('xl/worksheets/')) return false;
    const xml = parts.get(path) ?? new TextDecoder().decode(archive[path]!);
    return xml.includes('<f>') || xml.includes('<f ');
  });
  if (hasFormulas) {
    const path = 'xl/workbook.xml';
    const workbook = parts.get(path) ?? new TextDecoder().decode(archive[path] ?? new Uint8Array());
    if (workbook) next[path] = strToU8(markRecalc(workbook));
  }

  return zipSync(next);
}
