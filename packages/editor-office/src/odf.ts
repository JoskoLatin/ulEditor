/**
 * OpenDocument — `.odt` and `.ods` — read here, not converted elsewhere.
 *
 * The plan said phase 2 would bring these in through LibreOffice running
 * headless. That is the right instrument for `.cdr` and PostScript, which hold
 * drawing models nobody else implements. It is the wrong one here: an
 * OpenDocument file is a ZIP of XML, exactly like the OOXML this package
 * already reads, and asking somebody to install a four-hundred-megabyte office
 * suite before a `.ods` will open is a larger imposition than the reader is a
 * piece of work. So the container helpers are shared with `ooxml.ts` and only
 * the vocabulary is new.
 *
 * The vocabulary is genuinely different, and in two places it is *better*, which
 * this reader takes advantage of:
 *
 * - A spreadsheet cell carries **both** the number and the text the writing
 *   program drew for it (`<text:p>`), so the grid shows exactly what LibreOffice
 *   showed, with no format code interpreted on our side at all.
 * - Empty space is written as a repeat count rather than as cells, so a sheet
 *   with three used columns says `number-columns-repeated="1021"` once. Those
 *   counts are the one thing that has to be handled carefully: taken literally
 *   they ask for a million rows of nothing.
 *
 * `.ods` is **editable in place**: a save writes the `.ods` it came from, with
 * only the cells that were retyped changed — see [`ods-edit.ts`](./ods-edit.ts).
 * `.odt` opens **read-only**, and says so. The `.docx` editor rewrites a run by
 * cutting into the bytes it came from; nothing here has been proven to that
 * standard yet, and an editor that cannot say what it will do to the file it
 * saves is the thing this project refuses to ship.
 */

import { t } from '@uleditor/i18n';

import {
  attr,
  attrNum,
  child,
  children,
  imageUrl,
  openArchive,
  readXml,
  tag,
  tags,
  type Archive,
} from './ooxml.js';
import type { Preview, PreviewOutline } from './docx.js';
import { MAX_COLS, MAX_ROWS, type Cell, type Merge, type Sheet, type Workbook } from './xlsx.js';

/**
 * A cell repeated with content is written out that many times; one repeated
 * empty is only a jump of the cursor. Without a cap on the first, a file that
 * says a value repeats a million times costs a million cells of memory to show
 * a wall of the same number.
 */
const MAX_REPEAT = 512;

/* ── the container ───────────────────────────────────────────────────── */

interface Opened {
  archive: Archive;
  content: Document;
  /** `styles.xml` — where the named styles and the page layout live. */
  styles: Document | null;
  body: Element;
}

function open(bytes: Uint8Array, kind: 'text' | 'spreadsheet'): Opened {
  const archive = openArchive(bytes);
  const content = readXml(archive, 'content.xml');
  if (!content) {
    throw new Error(t('The file has no `content.xml` — this is not an OpenDocument file.'));
  }

  const body = tag(content, kind);
  if (!body) {
    /* A `.ods` renamed to `.odt` is the common way to arrive here, and the
       message has to say which of the two it actually is rather than that
       something is wrong. */
    const found = tag(content, 'body')?.firstElementChild?.localName ?? '';
    throw new Error(
      found
        ? t('This OpenDocument file holds a {found}, not a {expected}.', {
            found: t(KIND_NAMES[found] ?? found),
            expected: t(KIND_NAMES[kind] ?? kind),
          })
        : t('The file has no readable OpenDocument body.'),
    );
  }

  return { archive, content, styles: readXml(archive, 'styles.xml'), body };
}

const KIND_NAMES: Record<string, string> = {
  text: 'text document',
  spreadsheet: 'spreadsheet',
  presentation: 'presentation',
  drawing: 'drawing',
};

/** Every `style:style` in the file, automatic and named, from both parts. */
function styleElements(opened: Opened): Element[] {
  const out: Element[] = [];
  for (const doc of [opened.content, opened.styles]) {
    if (doc) out.push(...tags(doc, 'style'));
  }
  return out;
}

/** ODF writes lengths with their unit; the view needs pixels. */
const PER_UNIT: Record<string, number> = {
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  in: 96,
  pt: 96 / 72,
  pc: 16,
  px: 1,
};

function lengthPx(value: string | null): number | null {
  if (!value) return null;
  const match = /^(-?[\d.]+)(cm|mm|in|pt|pc|px)$/.exec(value.trim());
  if (!match) return null;
  const per = PER_UNIT[match[2]!];
  const size = Number(match[1]);
  if (!per || !Number.isFinite(size)) return null;
  return Math.round(size * per);
}

/* ── text ────────────────────────────────────────────────────────────── */

/**
 * The text of one paragraph, spaces included.
 *
 * `textContent` is not enough: ODF collapses runs of spaces into a `<text:s>`
 * with a count, and a tab and a line break are elements too. Reading the
 * property alone turns "Ime      Prezime" into "ImePrezime", which is exactly
 * the kind of quiet damage a column of a table makes visible.
 */
function flatText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (!(node instanceof Element)) return '';

  switch (node.localName) {
    case 's':
      return ' '.repeat(Math.max(1, attrNum(node, 'c') ?? 1));
    case 'tab':
      return '\t';
    case 'line-break':
      return '\n';
    case 'note':
    case 'annotation':
      return '';
    default:
      return [...node.childNodes].map(flatText).join('');
  }
}

/* ── spreadsheet ─────────────────────────────────────────────────────── */

/**
 * A number format, translated from a description into a code.
 *
 * ODF *describes* a format — "a day, a full stop, a month, a full stop, a
 * four-digit year" — while Excel *names* it with a code string, `dd.mm.yyyy`.
 * Nothing needs this to read the file: the display text is already in the cell.
 * It is needed by the save, which writes an `.xlsx`, and a date that arrives
 * there as the number 45823 is not a date any more.
 *
 * What it cannot express — scientific notation, fractions, conditional colours —
 * comes back empty rather than approximately, and an empty format means the
 * value is written plain. A number that lost its thousands separator is a small
 * loss; a number silently rounded by a format that was guessed at is not.
 */
function formatCode(style: Element): string {
  let code = '';

  for (const el of [...style.children]) {
    switch (el.localName) {
      case 'number': {
        const grouping = attr(el, 'grouping') === 'true';
        const minInt = Math.max(1, Math.min(attrNum(el, 'min-integer-digits') ?? 1, 12));
        const decimals = Math.min(attrNum(el, 'decimal-places') ?? 0, 10);
        const minDecimals = Math.min(attrNum(el, 'min-decimal-places') ?? decimals, decimals);

        let part = '0'.repeat(minInt);
        if (grouping) part = `#,##${part}`;
        if (decimals > 0) {
          part += `.${'0'.repeat(minDecimals)}${'#'.repeat(decimals - minDecimals)}`;
        }
        code += part;
        break;
      }
      case 'currency-symbol':
        code += `"${(el.textContent ?? '').replace(/"/g, '')}"`;
        break;
      case 'text': {
        const literal = el.textContent ?? '';
        if (!literal) break;
        // `%` is Excel's own percent operator, and the punctuation a date is
        // built from needs no quoting; everything else would be read as code.
        code += literal === '%' || /^[.,:\-/ ]+$/.test(literal) ? literal : `"${literal.replace(/"/g, '')}"`;
        break;
      }
      case 'day':
        code += attr(el, 'style') === 'long' ? 'dd' : 'd';
        break;
      case 'month':
        code +=
          attr(el, 'textual') === 'true'
            ? attr(el, 'style') === 'long'
              ? 'mmmm'
              : 'mmm'
            : attr(el, 'style') === 'long'
              ? 'mm'
              : 'm';
        break;
      case 'year':
        code += attr(el, 'style') === 'long' ? 'yyyy' : 'yy';
        break;
      case 'day-of-week':
        code += attr(el, 'style') === 'long' ? 'dddd' : 'ddd';
        break;
      case 'hours':
        code += attr(el, 'style') === 'long' ? 'hh' : 'h';
        break;
      case 'minutes':
        code += attr(el, 'style') === 'long' ? 'mm' : 'm';
        break;
      case 'seconds':
        code += attr(el, 'style') === 'long' ? 'ss' : 's';
        break;
      case 'am-pm':
        code += 'AM/PM';
        break;
      case 'text-content':
        code += '@';
        break;
      case 'scientific-number':
      case 'fraction':
      case 'boolean':
        // Expressible in a code, but not in one worth guessing at.
        return '';
      default:
        break;
    }
  }

  return code;
}

/** Cell style name → the number format code it carries. */
function cellFormats(opened: Opened): Map<string, string> {
  const byDataStyle = new Map<string, string>();
  for (const doc of [opened.content, opened.styles]) {
    if (!doc) continue;
    for (const el of doc.querySelectorAll('*')) {
      if (!/-style$/.test(el.localName) || el.localName === 'default-style') continue;
      const name = attr(el, 'name');
      if (!name || byDataStyle.has(name)) continue;
      const code = formatCode(el);
      if (code) byDataStyle.set(name, code);
    }
  }

  const byCellStyle = new Map<string, string>();
  for (const style of styleElements(opened)) {
    if (attr(style, 'family') !== 'table-cell') continue;
    const name = attr(style, 'name');
    const data = attr(style, 'data-style-name');
    const code = data ? byDataStyle.get(data) : undefined;
    if (name && code) byCellStyle.set(name, code);
  }
  return byCellStyle;
}

/** Column style name → its width in pixels. */
function columnWidths(opened: Opened): Map<string, number> {
  const widths = new Map<string, number>();
  for (const style of styleElements(opened)) {
    if (attr(style, 'family') !== 'table-column') continue;
    const name = attr(style, 'name');
    const width = lengthPx(attr(child(style, 'table-column-properties'), 'column-width'));
    if (name && width) widths.set(name, width);
  }
  return widths;
}

/**
 * Excel counts days from 1899-12-30 — the 1900 leap-year bug included.
 *
 * Exported for the checks. A date that arrives one day out is the quietest
 * possible corruption: nothing looks broken, an invoice is simply dated
 * yesterday, and the page test can only see that the cell says "date".
 */
export function serialFromDate(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?))?/.exec(iso);
  if (!match) return null;
  const [, year, month, day, hours = '0', minutes = '0', seconds = '0'] = match;
  const days = Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000 + 25_569;
  if (!Number.isFinite(days)) return null;

  const serial = days + (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) / 86_400;

  /*
   * Excel counts a 29 February 1900 that never happened — the bug it inherited
   * from Lotus 1-2-3 and has kept ever since for the sake of files written in
   * 1985. The offset above is the one everybody uses, and it is right from
   * 1 March 1900 onward; below that line every date sits one day too late.
   *
   * Anything before Excel's own first day it cannot store as a date at all, and
   * saying so returns nothing rather than a number that would land in the wrong
   * century. The cell then keeps the text the file drew for it.
   */
  if (serial >= 61) return serial;
  return serial - 1 >= 1 ? serial - 1 : null;
}

/** A time of day is a fraction of a day, which is how both formats store it. */
function fractionFromDuration(value: string): number | null {
  const match = /^-?P(?:(\d+)D)?T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(value);
  if (!match) return null;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  const total =
    Number(days) + (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) / 86_400;
  return Number.isFinite(total) ? total : null;
}

/**
 * A formula as a person would read it.
 *
 * ODF writes `of:=SUM([.B2:.B4])`: a namespace saying which formula language it
 * is, then references in brackets with a dot for "this sheet". None of that
 * belongs in a message explaining why a cell will not open, so the shell sees
 * `SUM(B2:B4)` — the same thing the file's own author typed.
 *
 * Exported for the checks: it is a chain of substitutions over other people's
 * strings, which is where this kind of function goes wrong.
 */
export function plainFormula(raw: string): string {
  return raw
    .replace(/^[a-z0-9]+:/i, '')
    .replace(/^=/, '')
    .replace(/\[([^\]]*)\]/g, (_, inner: string) =>
      /* A range is two references either side of a colon, and each carries its
         own sheet part — `[$Prodaja.B2:.B3]`. Split first: a pattern run over
         the whole bracket swallows the colon along with the first reference. */
      inner
        .split(':')
        .map((part) => {
          const dot = part.indexOf('.');
          if (dot === -1) return part.replace(/\$/g, '');
          const sheet = part.slice(0, dot).replace(/\$/g, '');
          const ref = part.slice(dot + 1).replace(/\$/g, '');
          return sheet ? `${sheet}!${ref}` : ref;
        })
        .join(':'),
    )
    .replace(/;/g, ',');
}

function readCell(node: Element, formats: Map<string, string>): Cell | null {
  const type = attr(node, 'value-type');
  const raw = attr(node, 'value');
  const formula = attr(node, 'formula');
  const fmt = formats.get(attr(node, 'style-name') ?? '');

  const display = children(node, 'p').map(flatText).join('\n').trim();
  const common = {
    ...(formula ? { formula: plainFormula(formula), fromFormula: true } : {}),
    ...(fmt ? { fmt } : {}),
  };

  switch (type) {
    case 'float':
    case 'percentage':
    case 'currency': {
      const value = Number(raw);
      if (!Number.isFinite(value)) break;
      return { text: display || String(value), kind: 'number', raw: value, ...common };
    }
    case 'date': {
      const serial = serialFromDate(attr(node, 'date-value') ?? '');
      if (serial === null) break;
      return {
        text: display || (attr(node, 'date-value') ?? ''),
        kind: 'date',
        raw: serial,
        ...common,
        fmt: fmt ?? 'dd.mm.yyyy',
      };
    }
    case 'time': {
      const fraction = fractionFromDuration(attr(node, 'time-value') ?? '');
      if (fraction === null) break;
      return {
        text: display || (attr(node, 'time-value') ?? ''),
        kind: 'date',
        raw: fraction,
        ...common,
        fmt: fmt ?? 'hh:mm',
      };
    }
    case 'boolean': {
      const value = (attr(node, 'boolean-value') ?? '').toLowerCase() === 'true';
      return { text: display || (value ? t('TRUE') : t('FALSE')), kind: 'bool', raw: value, ...common };
    }
    default:
      break;
  }

  const text = display || attr(node, 'string-value') || '';
  return text ? { text, kind: 'text', raw: text, ...common } : null;
}

/** Rows sit inside grouping and header wrappers as often as directly in the table. */
function rowsOf(node: Element): Element[] {
  const out: Element[] = [];
  for (const el of [...node.children]) {
    if (el.localName === 'table-row') out.push(el);
    else if (/^table-(rows|header-rows|row-group)$/.test(el.localName)) out.push(...rowsOf(el));
  }
  return out;
}

function columnsOf(node: Element): Element[] {
  const out: Element[] = [];
  for (const el of [...node.children]) {
    if (el.localName === 'table-column') out.push(el);
    else if (/^table-(columns|header-columns|column-group)$/.test(el.localName)) {
      out.push(...columnsOf(el));
    }
  }
  return out;
}

function readTable(
  node: Element,
  formats: Map<string, string>,
  widthByStyle: Map<string, number>,
  index: number,
): { sheet: Sheet; truncated: boolean } {
  const cells = new Map<string, Cell>();
  const merges: Merge[] = [];
  const widths = new Map<number, number>();
  let maxRow = 0;
  let maxCol = 0;
  let truncated = false;

  let column = 0;
  for (const col of columnsOf(node)) {
    const repeat = Math.max(1, attrNum(col, 'number-columns-repeated') ?? 1);
    const width = widthByStyle.get(attr(col, 'style-name') ?? '');
    for (let i = 0; i < repeat && column < MAX_COLS; i++, column++) {
      if (width) widths.set(column, width);
    }
  }

  let row = 0;
  for (const rowNode of rowsOf(node)) {
    if (row >= MAX_ROWS) {
      truncated = true;
      break;
    }

    const rowRepeat = Math.max(1, attrNum(rowNode, 'number-rows-repeated') ?? 1);
    const cellNodes = [...rowNode.children].filter((el) =>
      /^(covered-)?table-cell$/.test(el.localName),
    );

    /* A repeated row is only worth writing out when it holds something. The
       thousand empty ones at the bottom of every LibreOffice sheet are a jump,
       not a thousand rows. */
    const hasContent = cellNodes.some((el) => el.children.length > 0 || attr(el, 'value') !== null);
    const rows = hasContent ? Math.min(rowRepeat, MAX_REPEAT) : 1;

    for (let r = 0; r < rows && row + r < MAX_ROWS; r++) {
      const y = row + r;
      let x = 0;

      for (const cellNode of cellNodes) {
        if (x >= MAX_COLS) {
          truncated = true;
          break;
        }

        const repeat = Math.max(1, attrNum(cellNode, 'number-columns-repeated') ?? 1);
        const covered = cellNode.localName === 'covered-table-cell';
        const cell = covered ? null : readCell(cellNode, formats);

        if (!cell) {
          x += repeat;
          continue;
        }

        const spanCols = Math.max(1, attrNum(cellNode, 'number-columns-spanned') ?? 1);
        const spanRows = Math.max(1, attrNum(cellNode, 'number-rows-spanned') ?? 1);

        for (let i = 0; i < Math.min(repeat, MAX_REPEAT) && x < MAX_COLS; i++, x++) {
          cells.set(`${y},${x}`, cell);
          if (y > maxRow) maxRow = y;
          if (x > maxCol) maxCol = x;
          if (spanCols > 1 || spanRows > 1) {
            merges.push({ row: y, col: x, rows: spanRows, cols: spanCols });
          }
        }
      }
    }

    row += hasContent ? Math.min(rowRepeat, MAX_REPEAT) : rowRepeat;
  }

  return {
    sheet: {
      name: attr(node, 'name') ?? `${t('Sheet')} ${index + 1}`,
      /* Every sheet lives in the same part — a `.ods` keeps the whole
         spreadsheet in one `content.xml`, and which table is which is decided
         by order. See `ods-edit.ts`. */
      path: 'content.xml',
      rows: maxRow + 1,
      cols: maxCol + 1,
      cells,
      merges,
      widths,
    },
    truncated,
  };
}

/**
 * `.ods` → the same grid `.xlsx` and `.xls` get.
 *
 * Editable, and saved the way the old binary Excel is: into a **new `.xlsx`
 * beside the original**, which is never touched. Writing OpenDocument back is a
 * separate piece of work with its own fidelity question, and the honest thing
 * until it is done is to say where the save is going.
 */
export function readOds(bytes: Uint8Array): Workbook {
  const opened = open(bytes, 'spreadsheet');
  const formats = cellFormats(opened);
  const widthByStyle = columnWidths(opened);

  const sheets: Sheet[] = [];
  const notes = new Set<string>();

  for (const node of children(opened.body, 'table')) {
    const { sheet, truncated } = readTable(node, formats, widthByStyle, sheets.length);
    if (truncated) {
      notes.add(`Only the first ${MAX_ROWS} rows and ${MAX_COLS} columns of each sheet are shown.`);
    }
    sheets.push(sheet);
  }

  if (sheets.length === 0) throw new Error(t('The workbook has no readable sheet.'));

  if (tag(opened.content, 'object') || tag(opened.content, 'object-ole')) {
    notes.add('Charts are not shown.');
  }
  if (Object.keys(opened.archive).some((name) => name.startsWith('Pictures/'))) {
    notes.add('Images inside sheets are not shown.');
  }
  if (tag(opened.content, 'database-ranges') || tag(opened.content, 'named-expressions')) {
    notes.add('Filters and frozen panes are not applied.');
  }
  notes.add('Formulas are not recalculated — the value stored in the file is shown.');

  return { sheets, notes: [...notes], archive: opened.archive, kind: 'odf' };
}

/* ── text document ───────────────────────────────────────────────────── */

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  background?: string;
}

interface Context {
  archive: Archive;
  text: Map<string, TextStyle>;
  /** Style name → whether its list is numbered rather than bulleted. */
  ordered: Map<string, boolean>;
  urls: string[];
  notes: Set<string>;
}

function textStyles(opened: Opened): Map<string, TextStyle> {
  const styles = new Map<string, TextStyle>();

  for (const style of styleElements(opened)) {
    const name = attr(style, 'name');
    const props = child(style, 'text-properties');
    if (!name || !props) continue;

    const entry: TextStyle = {};
    if ((attr(props, 'font-weight') ?? '') === 'bold') entry.bold = true;
    if (/^(italic|oblique)$/.test(attr(props, 'font-style') ?? '')) entry.italic = true;

    const underline = attr(props, 'text-underline-style');
    if (underline && underline !== 'none') entry.underline = true;

    const strike = attr(props, 'text-line-through-style');
    if (strike && strike !== 'none') entry.strike = true;

    const color = attr(props, 'color');
    if (color && color !== 'transparent') entry.color = color;

    const background = attr(props, 'background-color');
    if (background && background !== 'transparent') entry.background = background;

    if (Object.keys(entry).length > 0) styles.set(name, entry);
  }

  return styles;
}

/**
 * List style name → numbered or bulleted.
 *
 * A list carries the name of a style, and that style says per level whether the
 * marker is a number, a bullet or an image. The first level decides here, as it
 * does for Word: a list that changes kind halfway down its levels is rare enough
 * that following it would cost more than it is worth.
 */
function listStyles(opened: Opened): Map<string, boolean> {
  const ordered = new Map<string, boolean>();
  for (const doc of [opened.content, opened.styles]) {
    if (!doc) continue;
    for (const style of tags(doc, 'list-style')) {
      const name = attr(style, 'name');
      if (!name) continue;
      const first = [...style.children][0];
      ordered.set(name, first?.localName === 'list-level-style-number');
    }
  }
  return ordered;
}

function buildImage(frame: Element, ctx: Context): HTMLElement | null {
  const image = child(frame, 'image');
  const href = attr(image, 'href');

  if (!href) {
    if (child(frame, 'object') || child(frame, 'object-ole')) {
      ctx.notes.add('Embedded objects (equations, OLE) are not shown.');
    }
    return null;
  }
  if (/^[a-z]+:\/\//i.test(href)) {
    ctx.notes.add('Images linked from outside the document are not loaded.');
    return null;
  }

  const url = imageUrl(ctx.archive, href.replace(/^\.?\//, ''));
  if (!url) {
    ctx.notes.add('Some images use a format the browser cannot render (EMF/WMF).');
    return null;
  }
  ctx.urls.push(url);

  const img = document.createElement('img');
  img.src = url;
  img.alt = child(frame, 'desc')?.textContent ?? '';
  const width = lengthPx(attr(frame, 'width'));
  if (width) img.style.width = `${width}px`;
  return img;
}

/** The formatting a `text:span` carries, applied by wrapping its content. */
function wrapStyled(nodes: Node[], style: TextStyle | undefined): Node[] {
  if (!style || nodes.length === 0) return nodes;

  let wrapper: HTMLElement | null = null;
  const wrap = (tagName: string) => {
    const el = document.createElement(tagName);
    if (wrapper) el.appendChild(wrapper);
    else for (const node of nodes) el.appendChild(node);
    wrapper = el;
  };

  if (style.bold) wrap('strong');
  if (style.italic) wrap('em');
  if (style.underline) wrap('u');
  if (style.strike) wrap('s');

  if (style.color || style.background) {
    wrap('span');
    const span = wrapper as unknown as HTMLElement;
    if (style.color) span.style.color = style.color;
    if (style.background) span.style.background = style.background;
  }

  return wrapper ? [wrapper] : nodes;
}

/** The content of one `text:p` or `text:h`. */
function inlineContent(parent: Node, ctx: Context): Node[] {
  const out: Node[] = [];

  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? '';
      if (value) out.push(document.createTextNode(value));
      continue;
    }
    if (!(node instanceof Element)) continue;

    switch (node.localName) {
      case 'span':
        out.push(...wrapStyled(inlineContent(node, ctx), ctx.text.get(attr(node, 'style-name') ?? '')));
        break;
      case 'a': {
        const link = document.createElement('a');
        const href = attr(node, 'href');
        if (href) {
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        link.append(...inlineContent(node, ctx));
        if (link.textContent) out.push(link);
        break;
      }
      case 's':
        out.push(document.createTextNode(' '.repeat(Math.max(1, attrNum(node, 'c') ?? 1))));
        break;
      case 'tab':
        out.push(document.createTextNode(' '));
        break;
      case 'line-break':
        out.push(document.createElement('br'));
        break;
      case 'frame': {
        const image = buildImage(node, ctx);
        if (image) out.push(image);
        break;
      }
      case 'note':
        ctx.notes.add('Footnotes and endnotes are not shown.');
        break;
      case 'annotation':
      case 'annotation-end':
        ctx.notes.add('Comments are not shown.');
        break;
      case 'change-start':
      case 'change':
      case 'change-end':
        ctx.notes.add('Tracked changes are shown as accepted; deleted text is not visible.');
        break;
      case 'bookmark':
      case 'bookmark-start':
      case 'bookmark-end':
      case 'soft-page-break':
      case 'sequence-decls':
        break;
      default:
        // Fields — a date, a page number, a cross-reference — carry the text
        // the writing program last drew, and that is the honest thing to show.
        out.push(...inlineContent(node, ctx));
        break;
    }
  }

  return out;
}

/**
 * A `table:table` inside a text document.
 *
 * Merges are simpler here than in Word: the spanning cell states how far it
 * reaches, and the cells it covers are written out as `covered-table-cell`
 * placeholders. So the span is copied straight across and the placeholders only
 * move the column cursor — nothing has to be counted up as the rows go by.
 */
function buildTable(node: Element, ctx: Context): HTMLElement {
  const table = document.createElement('table');
  const headerRows = new Set(rowsOf(tag(node, 'table-header-rows') ?? node));
  const isHeaderWrapper = child(node, 'table-header-rows') !== null;

  for (const rowNode of rowsOf(node)) {
    const row = document.createElement('tr');
    const header = isHeaderWrapper && headerRows.has(rowNode);

    for (const cellNode of [...rowNode.children]) {
      if (!/^(covered-)?table-cell$/.test(cellNode.localName)) continue;
      if (cellNode.localName === 'covered-table-cell') continue;

      const repeat = Math.min(Math.max(1, attrNum(cellNode, 'number-columns-repeated') ?? 1), 64);
      const spanCols = Math.max(1, attrNum(cellNode, 'number-columns-spanned') ?? 1);
      const spanRows = Math.max(1, attrNum(cellNode, 'number-rows-spanned') ?? 1);

      for (let i = 0; i < repeat; i++) {
        const cell = document.createElement(header ? 'th' : 'td');
        if (spanCols > 1) cell.colSpan = spanCols;
        if (spanRows > 1) cell.rowSpan = spanRows;

        for (const inner of [...cellNode.children]) {
          if (inner.localName === 'p' || inner.localName === 'h') {
            const p = document.createElement('p');
            p.append(...inlineContent(inner, ctx));
            cell.appendChild(p);
          } else if (inner.localName === 'table') {
            cell.appendChild(buildTable(inner, ctx));
          } else if (inner.localName === 'list') {
            cell.appendChild(buildList(inner, ctx));
          }
        }

        row.appendChild(cell);
      }
    }

    table.appendChild(row);
  }

  return table;
}

function buildList(node: Element, ctx: Context, level = 0): HTMLElement {
  const name = attr(node, 'style-name') ?? '';
  const list = document.createElement(ctx.ordered.get(name) ? 'ol' : 'ul');
  if (level > 0) list.dataset.level = String(Math.min(level, 4));

  for (const itemNode of [...node.children]) {
    if (!/^list-(item|header)$/.test(itemNode.localName)) continue;

    const item = document.createElement('li');
    for (const inner of [...itemNode.children]) {
      if (inner.localName === 'p' || inner.localName === 'h') {
        item.append(...inlineContent(inner, ctx));
      } else if (inner.localName === 'list') {
        item.appendChild(buildList(inner, ctx, level + 1));
      }
    }
    list.appendChild(item);
  }

  return list;
}

/**
 * `.odt` → the same reading view a `.docx` gets: headings, paragraphs,
 * formatting, lists, tables and images in their places.
 *
 * Read-only, and the returned `Preview` says so by carrying no `source`. That
 * field is what the Word editor cuts into when it rewrites a run; there is no
 * equivalent proven here, and a document offered for editing that cannot be
 * saved is a promise broken at the worst possible moment.
 */
export function readOdt(bytes: Uint8Array): Preview {
  const opened = open(bytes, 'text');

  const ctx: Context = {
    archive: opened.archive,
    text: textStyles(opened),
    ordered: listStyles(opened),
    urls: [],
    notes: new Set(),
  };

  const body = document.createElement('div');
  body.className = 'ul-office-doc';
  const outline: PreviewOutline[] = [];

  const walk = (parent: Element, into: HTMLElement): void => {
    for (const node of [...parent.children]) {
      switch (node.localName) {
        case 'h': {
          const content = inlineContent(node, ctx);
          const level = Math.min(Math.max(attrNum(node, 'outline-level') ?? 1, 1), 6);
          const element = document.createElement(`h${level}`);
          element.append(...content);
          element.id = `naslov-${outline.length}`;
          outline.push({
            id: element.id,
            label: (element.textContent ?? '').trim().slice(0, 120),
            depth: Math.min(level - 1, 3),
          });
          into.appendChild(element);
          break;
        }
        case 'p': {
          const content = inlineContent(node, ctx);
          if (content.length === 0) {
            // An empty paragraph is deliberate spacing, not junk.
            const spacer = document.createElement('p');
            spacer.className = 'ul-office-blank';
            into.appendChild(spacer);
            break;
          }
          const p = document.createElement('p');
          if (/quotation/i.test(attr(node, 'style-name') ?? '')) p.className = 'ul-office-quote';
          p.append(...content);
          into.appendChild(p);
          break;
        }
        case 'list':
          into.appendChild(buildList(node, ctx));
          break;
        case 'table':
          into.appendChild(buildTable(node, ctx));
          break;
        case 'frame': {
          const image = buildImage(node, ctx);
          if (image) {
            const wrapper = document.createElement('p');
            wrapper.appendChild(image);
            into.appendChild(wrapper);
          }
          break;
        }
        case 'tracked-changes':
          ctx.notes.add('Tracked changes are shown as accepted; deleted text is not visible.');
          break;
        default:
          /* Sections, generated tables of contents and index bodies hold
             ordinary paragraphs one level down — walking into them shows the
             text rather than dropping it. */
          walk(node, into);
          break;
      }
    }
  };

  walk(opened.body, body);

  if (opened.styles && (tag(opened.styles, 'header') || tag(opened.styles, 'footer'))) {
    ctx.notes.add('Page headers and footers are not shown.');
  }
  ctx.notes.add('OpenDocument text is shown, not written — saving is not offered.');

  const meta = readXml(opened.archive, 'meta.xml');
  const title = (meta ? tag(meta, 'title')?.textContent : '')?.trim() ?? '';

  return {
    title,
    body,
    text: (body.textContent ?? '').replace(/\s+/g, ' ').trim(),
    outline,
    notes: [...ctx.notes],
    release: () => {
      for (const url of ctx.urls) URL.revokeObjectURL(url);
      ctx.urls.length = 0;
    },
  };
}
