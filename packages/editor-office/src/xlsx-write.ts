/**
 * Writing a whole `.xlsx` from a grid, rather than editing one in place.
 *
 * [`xlsx-edit.ts`](./xlsx-edit.ts) is the surgeon: it changes the elements the
 * person touched and leaves every other byte of the archive alone. That is the
 * right instrument when the file is already OOXML. It has nothing to cut into
 * when the original is an old binary `.xls` — so the grid is written out fresh
 * here, into a new file beside the original.
 *
 * The original `.xls` is never touched. What comes out is a plain, valid
 * workbook: values, the number formats that decide what a date and an amount
 * look like, merged ranges and column widths. What it deliberately does not
 * carry is stated before the save happens, not discovered afterwards — the
 * formulas (their last calculated values go instead) and the old file's
 * styling. That is the fidelity rule as this project states it: never quietly.
 */

import { strToU8, zipSync } from 'fflate';

import { escapeXml } from './docx-edit.js';
import { columnName, type Sheet } from './xlsx.js';

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/**
 * Text going into an attribute value, quotes included.
 *
 * A separate function from `escapeXml`, which is for element content and
 * rightly leaves quotes alone. Attributes here carry two things that routinely
 * contain them: a number format such as `#,##0.00 "EUR"` — every Croatian
 * price list has one — and a sheet name somebody typed a quote into. Either
 * one closes the attribute early and the workbook will not open at all.
 */
function attrValue(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;');
}

/**
 * The number formats the written file needs, gathered from the cells.
 *
 * A format reaches the new file only if a cell uses it, and each one lands
 * once. Built-in ids (14 for a date, 4 for an amount) travel as ids — every
 * spreadsheet program knows them — while a custom code travels as its own
 * `numFmt` above 164, which is where the format reserves room for them.
 */
class Formats {
  /** The style index for each distinct format, in the order they were met. */
  readonly #index = new Map<string, number>();
  readonly #entries: { id: number; code?: string }[] = [];
  #nextCustom = 164;

  constructor() {
    // Style 0 is the default — no format at all, which is what plain text uses.
    this.#entries.push({ id: 0 });
    this.#index.set('', 0);
  }

  /** The style index a cell with this format should carry. */
  styleFor(fmt: number | string | undefined): number {
    if (fmt === undefined || fmt === '') return 0;
    const key = String(fmt);
    const existing = this.#index.get(key);
    if (existing !== undefined) return existing;

    const style = this.#entries.length;
    this.#entries.push(
      typeof fmt === 'number' ? { id: fmt } : { id: this.#nextCustom++, code: fmt },
    );
    this.#index.set(key, style);
    return style;
  }

  xml(): string {
    const custom = this.#entries.filter((entry) => entry.code !== undefined);
    const numFmts = custom.length
      ? `<numFmts count="${custom.length}">${custom
          .map((entry) => `<numFmt numFmtId="${entry.id}" formatCode="${attrValue(entry.code!)}"/>`)
          .join('')}</numFmts>`
      : '';
    const xfs = this.#entries
      .map((entry) => `<xf numFmtId="${entry.id}" applyNumberFormat="${entry.id ? 1 : 0}"/>`)
      .join('');

    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="${SHEET_NS}">${numFmts}` +
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
      `<borders count="1"><border/></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.#entries.length}">${xfs}</cellXfs>` +
      `</styleSheet>`
    );
  }
}

function sheetXml(sheet: Sheet, formats: Formats): string {
  /* The cells, gathered per row and each row in order: Excel reads the file in
     that order and quietly misplaces what breaks it. */
  const rows = new Map<number, { col: number; xml: string }[]>();

  for (const [key, cell] of sheet.cells) {
    const [row, col] = key.split(',').map(Number) as [number, number];
    const ref = `${columnName(col)}${row + 1}`;
    const style = formats.styleFor(cell.fmt);
    const s = style ? ` s="${style}"` : '';

    let xml: string;
    if (typeof cell.raw === 'number') {
      xml = `<c r="${ref}"${s}><v>${cell.raw}</v></c>`;
    } else if (typeof cell.raw === 'boolean') {
      xml = `<c r="${ref}"${s} t="b"><v>${cell.raw ? 1 : 0}</v></c>`;
    } else if (cell.kind === 'error') {
      xml = `<c r="${ref}"${s} t="e"><v>${escapeXml(String(cell.raw ?? cell.text))}</v></c>`;
    } else {
      /* Inline rather than shared: one string table for the whole workbook
         would make every identical value one entry, and a later edit of one
         cell would then reach every cell showing the same words. */
      const text = String(cell.raw ?? cell.text);
      xml = `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }

    const list = rows.get(row) ?? [];
    list.push({ col, xml });
    rows.set(row, list);
  }

  const body = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([row, cells]) => {
      const inner = cells.sort((a, b) => a.col - b.col).map((c) => c.xml).join('');
      return `<row r="${row + 1}">${inner}</row>`;
    })
    .join('');

  const cols = [...sheet.widths.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([col, px]) => {
      // The inverse of the reader's `width * 7 + 8`.
      const width = Math.max(1, (px - 8) / 7);
      return `<col min="${col + 1}" max="${col + 1}" width="${width.toFixed(2)}" customWidth="1"/>`;
    })
    .join('');

  const merges = sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges
        .map((merge) => {
          const from = `${columnName(merge.col)}${merge.row + 1}`;
          const to = `${columnName(merge.col + merge.cols - 1)}${merge.row + merge.rows - 1 + 1}`;
          return `<mergeCell ref="${from}:${to}"/>`;
        })
        .join('')}</mergeCells>`
    : '';

  const last = `${columnName(Math.max(0, sheet.cols - 1))}${Math.max(1, sheet.rows)}`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${SHEET_NS}"><dimension ref="A1:${last}"/>` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${body}</sheetData>${merges}</worksheet>`
  );
}

/**
 * A whole workbook, written from the sheets as they stand on screen.
 *
 * Sheet names are given the same treatment Excel gives them, because a name it
 * refuses makes the file unopenable rather than imperfect: the characters it
 * forbids become spaces, the length is capped at 31, and a name that ends up
 * empty or duplicated is numbered.
 */
export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const formats = new Formats();

  const used = new Set<string>();
  const names = sheets.map((sheet, index) => {
    let name = (sheet.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim();
    if (!name) name = `Sheet${index + 1}`;
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) {
      unique = `${name.slice(0, 28)} ${n}`;
    }
    used.add(unique.toLowerCase());
    return unique;
  });

  const files: Record<string, Uint8Array> = {};
  const sheetXmls = sheets.map((sheet) => sheetXml(sheet, formats));
  sheetXmls.forEach((xml, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(xml);
  });

  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      `</Types>`,
  );

  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );

  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>` +
      names
        .map(
          (name, index) =>
            `<sheet name="${attrValue(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join('') +
      `</sheets></workbook>`,
  );

  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${PKG_REL_NS}">` +
      sheets
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );

  // Written last: the styles are only known once every cell has been through.
  files['xl/styles.xml'] = strToU8(formats.xml());

  return zipSync(files);
}

/** `report.xls` → `report.xlsx`, whatever the case of the extension. */
export function convertedName(name: string): string {
  return /\.xls$/i.test(name) ? `${name.slice(0, -4)}.xlsx` : `${name}.xlsx`;
}
