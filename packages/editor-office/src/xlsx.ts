/**
 * XLSX → mreža (samo čitanje).
 *
 * Tablica se ne prikazuje kao "tekst iz ćelija" nego kao mreža s oznakama
 * stupaca i redaka, jer se proračunska tablica čita položajem koliko i
 * sadržajem. Formule se ne računaju — prikazuje se vrijednost koju je
 * spremio Excel, a sama formula stoji u opisu ćelije.
 */

import { attr, attrNum, openArchive, readRelationships, readXml, tag, tags, type Archive } from './ooxml.js';
import { t } from '@uleditor/i18n';

export type CellKind = 'number' | 'text' | 'bool' | 'error' | 'date';

export interface Cell {
  text: string;
  kind: CellKind;
  formula?: string;
}

export interface Merge {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface Sheet {
  name: string;
  rows: number;
  cols: number;
  /** Ključ je `red,stupac`, oba 0-bazirana. Rijetke tablice ne troše memoriju. */
  cells: Map<string, Cell>;
  merges: Merge[];
  widths: Map<number, number>;
}

export interface Workbook {
  sheets: Sheet[];
  notes: string[];
}

/** Iznad ovoga preglednik prestaje biti upotrebljiv, a rijetko tko toliko gleda odjednom. */
const MAX_ROWS = 5000;
const MAX_COLS = 256;

/* ── reference ćelija ────────────────────────────────────────────────── */

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
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/* ── formati brojeva ─────────────────────────────────────────────────── */

/** Ugrađeni Excelovi formati koji su datumi ili vrijeme. */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Iz koda formata miče doslovne dijelove, pa `[Red]"kn"` ne izgleda kao datum. */
function formatSkeleton(code: string): string {
  return code
    .replace(/\[[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '');
}

function isDateFormat(id: number, code: string | undefined): boolean {
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
 * Excelov serijski broj → datum. Nula je 30. 12. 1899. zbog poznate greške
 * kompatibilnosti (Excel misli da je 1900. bila prijestupna).
 */
function serialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
}

function formatDate(serial: number, code: string | undefined): string {
  const date = serialToDate(serial);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}.`;

  const skeleton = formatSkeleton(code ?? '');
  const hasTime = /[hs]/i.test(skeleton);
  const hasDate = /[ymd]/i.test(skeleton) || !hasTime;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

  if (hasDate && hasTime) return `${day} ${time}`;
  if (hasTime) return time;
  return day;
}

function formatNumber(value: number, code: string | undefined): string {
  const skeleton = formatSkeleton(code ?? '');
  const percent = skeleton.includes('%');
  const grouped = skeleton.includes('#,#') || skeleton.includes('0,0');
  const decimals = decimalsOf(code);

  const scaled = percent ? value * 100 : value;
  const options: Intl.NumberFormatOptions = { useGrouping: grouped };
  if (decimals >= 0) {
    options.minimumFractionDigits = decimals;
    options.maximumFractionDigits = decimals;
  } else {
    options.maximumFractionDigits = 10;
  }

  return `${new Intl.NumberFormat('hr-HR', options).format(scaled)}${percent ? ' %' : ''}`;
}

/* ── čitanje ─────────────────────────────────────────────────────────── */

function readSharedStrings(archive: Archive): string[] {
  const doc = readXml(archive, 'xl/sharedStrings.xml');
  if (!doc) return [];
  return tags(doc, 'si').map((si) =>
    tags(si, 't')
      .map((t) => t.textContent ?? '')
      .join(''),
  );
}

/** Indeks stila → kod formata broja. */
function readStyles(archive: Archive): { formats: (string | undefined)[]; ids: number[] } {
  const doc = readXml(archive, 'xl/styles.xml');
  if (!doc) return { formats: [], ids: [] };

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
  return { formats, ids };
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
  const { formats, ids } = readStyles(archive);
  const notes = new Set<string>();

  const sheets: Sheet[] = [];

  for (const node of tags(workbook, 'sheet')) {
    const name = attr(node, 'name') ?? `List ${sheets.length + 1}`;
    const relId = attr(node, 'id');
    const path = relId ? rels.get(relId)?.target : undefined;
    const doc = path ? readXml(archive, path) : null;
    if (!doc) continue;

    const cells = new Map<string, Cell>();
    let maxRow = 0;
    let maxCol = 0;
    let truncated = false;

    for (const rowNode of tags(doc, 'row')) {
      for (const cellNode of [...rowNode.children]) {
        if (cellNode.localName !== 'c') continue;

        const ref = attr(cellNode, 'r');
        const position = ref ? parseRef(ref) : null;
        if (!position) continue;
        if (position.row >= MAX_ROWS || position.col >= MAX_COLS) {
          truncated = true;
          continue;
        }

        const cell = readCell(cellNode, shared, formats, ids);
        if (!cell) continue;

        cells.set(`${position.row},${position.col}`, cell);
        if (position.row > maxRow) maxRow = position.row;
        if (position.col > maxCol) maxCol = position.col;
      }
    }

    if (truncated) {
      notes.add(`Only the first ${MAX_ROWS} rows and ${MAX_COLS} columns of each sheet are shown.`);
    }

    const merges: Merge[] = [];
    for (const mergeNode of tags(doc, 'mergeCell')) {
      const ref = attr(mergeNode, 'ref') ?? '';
      const [from, to] = ref.split(':');
      const start = from ? parseRef(from) : null;
      const end = to ? parseRef(to) : null;
      if (!start || !end) continue;
      merges.push({
        row: start.row,
        col: start.col,
        rows: end.row - start.row + 1,
        cols: end.col - start.col + 1,
      });
    }

    const widths = new Map<number, number>();
    for (const colNode of tags(doc, 'col')) {
      const min = attrNum(colNode, 'min');
      const max = attrNum(colNode, 'max');
      const width = attrNum(colNode, 'width');
      if (min === null || max === null || width === null) continue;
      for (let i = min - 1; i < Math.min(max, MAX_COLS); i++) {
        widths.set(i, Math.round(width * 7 + 8));
      }
    }

    sheets.push({
      name,
      rows: maxRow + 1,
      cols: maxCol + 1,
      cells,
      merges,
      widths,
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

  return { sheets, notes: [...notes] };
}

function readCell(
  node: Element,
  shared: string[],
  formats: (string | undefined)[],
  ids: number[],
): Cell | null {
  const type = attr(node, 't') ?? 'n';
  const styleIndex = attrNum(node, 's') ?? 0;
  const code = formats[styleIndex];
  const numFmtId = ids[styleIndex] ?? 0;

  const formulaNode = [...node.children].find((el) => el.localName === 'f');
  const formula = formulaNode?.textContent?.trim() || undefined;

  if (type === 'inlineStr') {
    const text = tags(node, 't')
      .map((t) => t.textContent ?? '')
      .join('');
    return text ? { text, kind: 'text', ...(formula ? { formula } : {}) } : null;
  }

  const valueNode = [...node.children].find((el) => el.localName === 'v');
  const raw = valueNode?.textContent ?? '';
  if (!raw) return null;

  switch (type) {
    case 's': {
      const text = shared[Number(raw)] ?? '';
      return text ? { text, kind: 'text', ...(formula ? { formula } : {}) } : null;
    }
    case 'str':
      return { text: raw, kind: 'text', ...(formula ? { formula } : {}) };
    case 'b':
      return { text: raw === '1' ? t('TRUE') : t('FALSE'), kind: 'bool', ...(formula ? { formula } : {}) };
    case 'e':
      return { text: raw, kind: 'error', ...(formula ? { formula } : {}) };
    default: {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { text: raw, kind: 'text' };
      if (isDateFormat(numFmtId, code)) {
        return { text: formatDate(value, code), kind: 'date', ...(formula ? { formula } : {}) };
      }
      return { text: formatNumber(value, code), kind: 'number', ...(formula ? { formula } : {}) };
    }
  }
}

/* ── prikaz ──────────────────────────────────────────────────────────── */

/** Mreža jednog lista. Gradi se tek kad se list otvori — knjige znaju biti velike. */
export function renderSheet(sheet: Sheet): HTMLElement {
  const table = document.createElement('table');
  table.className = 'ul-sheet';

  /* Ćelije prekrivene spajanjem preskačemo, a nosiocu dajemo raspon. */
  const covered = new Set<string>();
  const spans = new Map<string, Merge>();
  for (const merge of sheet.merges) {
    spans.set(`${merge.row},${merge.col}`, merge);
    for (let r = 0; r < merge.rows; r++) {
      for (let c = 0; c < merge.cols; c++) {
        if (r === 0 && c === 0) continue;
        covered.add(`${merge.row + r},${merge.col + c}`);
      }
    }
  }

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th')).className = 'ul-sheet-corner';
  for (let c = 0; c < sheet.cols; c++) {
    const th = document.createElement('th');
    th.textContent = columnName(c);
    th.className = 'ul-sheet-colhead';
    const width = sheet.widths.get(c);
    if (width) th.style.minWidth = `${Math.min(width, 420)}px`;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  for (let r = 0; r < sheet.rows; r++) {
    const row = document.createElement('tr');

    const rowHead = document.createElement('th');
    rowHead.textContent = String(r + 1);
    rowHead.className = 'ul-sheet-rowhead';
    row.appendChild(rowHead);

    for (let c = 0; c < sheet.cols; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue;

      const td = document.createElement('td');
      // Referenca ostaje na ćeliji: spajanja pomiču položaj u retku, pa
      // brojanje djece nije pouzdan način da se ćelija poslije nađe.
      td.dataset.ref = key;
      const merge = spans.get(key);
      if (merge) {
        if (merge.rows > 1) td.rowSpan = merge.rows;
        if (merge.cols > 1) td.colSpan = merge.cols;
      }

      const cell = sheet.cells.get(key);
      if (cell) {
        td.textContent = cell.text;
        td.dataset.kind = cell.kind;
        if (cell.formula) td.title = `=${cell.formula}`;
      }
      row.appendChild(td);
    }

    body.appendChild(row);
  }
  table.appendChild(body);

  return table;
}
