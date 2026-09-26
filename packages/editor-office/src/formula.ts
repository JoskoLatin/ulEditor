/**
 * What a formula reads, and — where it can be worked out — what it comes to.
 *
 * Not an interpreter. [`tools/formula-census.mjs`](../../../tools/formula-census.mjs)
 * counted every `<f>` in a folder of real spreadsheets before a line of this
 * was written, and the answer settled the shape of it: of 372 formulas, **297
 * are a `SUM`** and five more are arithmetic with no function at all. Four in
 * five. The next two by frequency are not the next two in difficulty — every
 * one of the 35 `SUMIFS`/`COUNTIFS` reaches its data through a structured table
 * reference, `SUMIFS(PodaciTable[Iznos], …)`, which needs `xl/tables/*.xml`
 * resolved before a criterion can be evaluated, and all 35 sit in one workbook.
 *
 * So this works out `SUM` and arithmetic, and **refuses everything else out
 * loud** rather than guessing at it. `AVERAGE`, `MIN` and `MAX` are the same
 * shape as `SUM` and would cost ten lines; they are not here because the census
 * did not find them. Adding one is a measurement away, not a rewrite.
 *
 * Run over the same real spreadsheets, that works out **296 of 344 formulas —
 * 86%**. Every one of the 48 it refuses was looked at rather than counted: 34
 * are the `SUMIFS`/`COUNTIFS` over a table, six are `SUBTOTAL`, two are
 * `COUNTA` and `ROW`, and the remaining six are **references with a sheet
 * named in them** — `SUM(Cashless!$L$7:$L$11)`. Looked at, every one of them is
 * on `Cashless` and names `Cashless`: its own sheet, spelled out. `evaluate` on
 * its own refuses any named sheet, its own included, and `recalculateBook`
 * works them out, because it hands `evaluate` the workbook to look the name up
 * in: a sheet is only readable where somebody said which sheets there are. A
 * formula this cannot work out and a formula this does not know about are two
 * different things, and only the second one is dangerous.
 *
 * The refusal is the load-bearing half. A total whose inputs have just changed
 * is **wrong**, and a view that goes on showing it is lying to the person
 * looking at it — the workbook is marked for full recalculation so Excel
 * settles it on opening, but that is no help to somebody reading the screen
 * now. So `dependency` answers three ways rather than two, and the third one is
 * `'unknown'`: a formula holding a reference this cannot read may or may not
 * depend on the cell that changed, and *may* is reason enough to stop showing
 * its number as current.
 */

/** One rectangle of cells a formula reads. */
export interface Reference {
  /**
   * The sheet named before the `!`, or `null` for the one the formula is on.
   *
   * A name, not a sheet: whether it can be followed depends on who is asking.
   * `recalculateBook` knows every sheet in the workbook; `evaluate` alone knows
   * none, and refuses a reference it cannot follow — which is an answer, not a
   * failure.
   */
  sheet: string | null;
  from: { row: number; col: number };
  to: { row: number; col: number };
}

/**
 * A table declared in the workbook, as far as a formula needs one.
 *
 * `PodaciTable[Iznos]` is not a range until somebody says where `PodaciTable`
 * begins and which of its columns is called `Iznos`, and nobody in this file
 * can: the answer is in `xl/tables/*.xml`, a part of the archive this module
 * never sees. So it is handed one of these instead of reaching for it, and the
 * module stays what it is — arithmetic over text, with no idea what a zip is.
 */
export interface TableRange {
  /** The sheet the table sits on, which is often not the sheet reading it. */
  sheet: string;
  /** The first and last row a `Name[Column]` covers, 0-based: the header row and any totals row left out. */
  fromRow: number;
  toRow: number;
  /** The table's leftmost column, 0-based. */
  fromCol: number;
  /** Each declared column's name, lowercased, to its offset from `fromCol`. */
  columns: ReadonlyMap<string, number>;
}

/** Tables by name, lowercased — a spreadsheet compares a table's name without case. */
export type Tables = ReadonlyMap<string, TableRange>;

/**
 * Whether a formula reads a particular cell.
 *
 * - `'reads'` — a reference this module understands covers that cell.
 * - `'no'` — every reference was understood and none of them covers it.
 * - `'unknown'` — something in the formula could not be read: a structured
 *   table reference, a defined name, a function's argument this does not
 *   parse. It might read the cell and it might not, and the difference cannot
 *   be established from the formula alone.
 */
export type Dependency = 'reads' | 'no' | 'unknown';

/** What a cell holds, as far as arithmetic is concerned. */
export type Value = number | null | undefined;

/** `undefined` — no such cell; `null` — a cell holding something that is not a number. */
export type Lookup = (row: number, col: number) => Value;

/** A1 → `{ row: 0, col: 0 }`; `null` for anything that is not a reference. */
export function parseA1(text: string): { row: number; col: number } | null {
  const found = /^\$?([A-Z]{1,3})\$?([0-9]{1,7})$/.exec(text.toUpperCase());
  if (!found) return null;
  let col = 0;
  for (const letter of found[1]!) col = col * 26 + (letter.charCodeAt(0) - 64);
  const row = Number(found[2]) - 1;
  if (row < 0 || col < 1) return null;
  return { row, col: col - 1 };
}

/**
 * The text with every string literal taken out.
 *
 * A quoted `"A1"` is a word, not a reference, and `"Iznos > 0"` holds a `>`
 * that is not an operator. Everything here that walks the text walks it in the
 * pieces between the quotes — the same split `shiftFormula` makes, for the same
 * reason.
 */
function outsideQuotes(text: string): string[] {
  return text.split(/("(?:[^"]|"")*")/).filter((_, at) => at % 2 === 0);
}

/** A sheet name before a `!`, with the quotes a name with a space in it carries. */
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][A-Za-z0-9_.À-￿]*))!`;
const CELL = String.raw`\$?[A-Z]{1,3}\$?[0-9]{1,7}`;
const REFERENCE = new RegExp(`(?:${SHEET})?(${CELL})(?::(${CELL}))?(?![A-Za-z0-9_(])`, 'g');
/* `M:M` and `2:4` — whole columns and whole rows. Nothing about them looks like
   `A1`, so without this a formula reading `Podaci!M:M` read nothing at all, and
   answered `'no'` for every cell in that column. */
const LINES = new RegExp(
  String.raw`(?<![A-Za-z0-9_.$:!'À-￿])(?:${SHEET})?(?:(\$?[A-Z]{1,3}):(\$?[A-Z]{1,3})|(\$?[0-9]{1,7}):(\$?[0-9]{1,7}))(?![A-Za-z0-9_.(!:])`,
  'g',
);
/** The last row and column a sheet can have: 1 048 576 rows, XFD columns. */
const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;

/** Anything this module knows it cannot read, each of which makes an answer `'unknown'`. */
const UNREADABLE = [
  /* `Tablica1[Iznos]` — a structured table reference, which needs the table
     definition out of another part of the archive to become a range at all. */
  /[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*\[/,
  /* `#REF!`, `#VALUE!` and the rest: the formula is already broken. */
  /#[A-Z/0-9]+[!?]/,
  /* `SUM(Jan:Mar!B2)` — a span of sheets. Read as a reference it would be
     `Mar!B2` alone, and an edit to `B2` on `Feb` would be answered `'no'`.
     Quoted, the colon is inside the quotes, and a sheet's own name cannot
     hold one. */
  new RegExp(`:${SHEET}|'(?:[^']|'')*:(?:[^']|'')*'!`),
];

/** `PodaciTable[Iznos]` — a table's name, then one plain column name in brackets. Nothing else. */
const STRUCTURED = /([A-Za-z_À-￿][A-Za-z0-9_.À-￿]*)\[([^[\]]*)\]/g;

/**
 * The ranges a formula's structured references stand for, and what is left of
 * the formula once they have been taken out of it.
 *
 * **The rule is deliberately narrow, and the narrowness is the whole safety of
 * this.** Only `Name[Column]` resolves, where `Name` is a declared table and
 * `Column` is exactly one of its declared column names. Every other bracketed
 * shape ECMA-376 allows — `[#All]`, `[#Headers]`, `[#Totals]`, `[#Data]`,
 * `[@Column]` for this row, `[[A]:[B]]` for a span of columns, and the `'`
 * escapes a name with a bracket in it carries — is left standing in `rest`,
 * where `unreadable` finds it and the answer stays `'unknown'`.
 *
 * None of those occurs in the spreadsheets this was measured on; all 35
 * structured references there are `PodaciTable[Column]`. The reason to refuse
 * them anyway is the direction of the mistake. Everywhere else in this module a
 * wrong answer costs a number marked out of date that was fine; here it would
 * cost an `'unknown'` turned into a `'no'`, which is a stale total left on the
 * screen with nothing at all to say that it is stale.
 */
function tableReferences(piece: string, tables: Tables): { found: Reference[]; rest: string } {
  const found: Reference[] = [];
  const rest = piece.replace(STRUCTURED, (whole, name: string, column: string) => {
    const table = tables.get(name.toLowerCase());
    const offset = table?.columns.get(column.toLowerCase());
    if (!table || offset === undefined) return whole;
    const col = table.fromCol + offset;
    found.push({
      sheet: table.sheet,
      from: { row: table.fromRow, col },
      to: { row: table.toRow, col },
    });
    /* A space, not nothing: `A1[x]B2` must not become `A1B2`. */
    return ' ';
  });
  return { found, rest };
}

/** Every rectangle a formula reads, as far as it can be read. */
export function referencesOf(formula: string, tables?: Tables): Reference[] {
  const found: Reference[] = [];
  for (const whole of outsideQuotes(formula)) {
    let piece = whole;
    if (tables) {
      const resolved = tableReferences(piece, tables);
      found.push(...resolved.found);
      piece = resolved.rest;
    }
    for (const match of piece.matchAll(REFERENCE)) {
      const sheet = match[1] !== undefined ? match[1].replace(/''/g, "'") : (match[2] ?? null);
      const from = parseA1(match[3]!);
      const to = match[4] ? parseA1(match[4]) : from;
      if (!from || !to) continue;
      found.push({
        sheet,
        from: { row: Math.min(from.row, to.row), col: Math.min(from.col, to.col) },
        to: { row: Math.max(from.row, to.row), col: Math.max(from.col, to.col) },
      });
    }
    for (const match of piece.matchAll(LINES)) {
      const sheet = match[1] !== undefined ? match[1].replace(/''/g, "'") : (match[2] ?? null);
      if (match[3] !== undefined) {
        const from = parseA1(`${match[3].replace('$', '')}1`)!.col;
        const to = parseA1(`${match[4]!.replace('$', '')}1`)!.col;
        found.push({ sheet, from: { row: 0, col: Math.min(from, to) }, to: { row: LAST_ROW, col: Math.max(from, to) } });
      } else {
        const from = Number(match[5]!.replace('$', '')) - 1;
        const to = Number(match[6]!.replace('$', '')) - 1;
        found.push({ sheet, from: { row: Math.min(from, to), col: 0 }, to: { row: Math.max(from, to), col: LAST_COL } });
      }
    }
  }
  return found;
}

/** Whether anything in the formula is beyond what this module can read. */
function unreadable(formula: string, tables?: Tables): boolean {
  return outsideQuotes(formula).some((piece) =>
    UNREADABLE.some((shape) => shape.test(tables ? tableReferences(piece, tables).rest : piece)),
  );
}

/**
 * Whether this formula, standing on sheet `sheetName`, reads that cell — on
 * `at.sheet`, or on the formula's own sheet when that is not given.
 *
 * A reference with no sheet in it is the formula's own sheet's; one naming a
 * sheet is that sheet's, and it may name the formula's own, which a workbook of
 * several sheets does often enough to matter. The comparison is
 * case-insensitive, because that is how a spreadsheet compares sheet names.
 *
 * A reference to a sheet that is not the cell's is `'no'` for that cell, even
 * where no such sheet exists: nothing can be typed into a sheet that is not
 * there, and `evaluate` refuses the reference when it comes to working it out.
 */
export function dependency(
  formula: string,
  sheetName: string,
  at: { row: number; col: number; sheet?: string },
  tables?: Tables,
): Dependency {
  if (unreadable(formula, tables)) return 'unknown';
  const here = sheetName.toLowerCase();
  const there = (at.sheet ?? sheetName).toLowerCase();
  for (const reference of referencesOf(formula, tables)) {
    if ((reference.sheet?.toLowerCase() ?? here) !== there) continue;
    if (
      at.row >= reference.from.row &&
      at.row <= reference.to.row &&
      at.col >= reference.from.col &&
      at.col <= reference.to.col
    ) {
      return 'reads';
    }
  }
  return 'no';
}

/* ── working it out ──────────────────────────────────────────────────── */

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'ref'; sheet: string | null; from: { row: number; col: number }; to: { row: number; col: number } }
  | { kind: 'name'; text: string }
  | { kind: 'symbol'; text: string };

/** `null` where anything at all was not understood — including a string, which SUM has no use for. */
function tokenize(formula: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  const text = formula;

  while (at < text.length) {
    const ch = text[at]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      at++;
      continue;
    }
    if ('+-*/^(),:'.includes(ch)) {
      tokens.push({ kind: 'symbol', text: ch });
      at++;
      continue;
    }
    /* A reference before a number, because `A1` begins with a letter and `1`
       is a perfectly good number in the middle of one. */
    const reference = new RegExp(`^(?:${SHEET})?(${CELL})(?::(${CELL}))?(?![A-Za-z0-9_(])`).exec(
      text.slice(at),
    );
    if (reference) {
      const from = parseA1(reference[3]!);
      const to = reference[4] ? parseA1(reference[4]) : from;
      if (!from || !to) return null;
      tokens.push({
        kind: 'ref',
        sheet: reference[1] !== undefined ? reference[1].replace(/''/g, "'") : (reference[2] ?? null),
        from: { row: Math.min(from.row, to.row), col: Math.min(from.col, to.col) },
        to: { row: Math.max(from.row, to.row), col: Math.max(from.col, to.col) },
      });
      at += reference[0].length;
      continue;
    }
    const number = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(at));
    if (name) {
      tokens.push({ kind: 'name', text: name[0].toUpperCase() });
      at += name[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * Works the formula out, or answers `null` because it could not.
 *
 * `null` is not an error and it is not zero — it is "this program does not know
 * what this comes to", which is the only honest answer for a `SUMIFS` over a
 * table, a reference into another sheet, a function nobody measured, or a
 * division by zero. What the caller does with it is show the number it has as
 * **stale** rather than as current.
 *
 * Where a cell is read matters to what "not a number" means, and this follows
 * the spreadsheet rather than inventing a rule:
 *
 * - **inside `SUM`, text and empty cells are skipped**, which is what makes a
 *   total over a column with a heading in it work at all;
 * - **in arithmetic, an empty cell is zero and text is a refusal** — `=A1*2`
 *   over a word is `#VALUE!` in Excel, and a number here would be a number
 *   nobody could account for.
 *
 * `valueAt` is the formula's own sheet. A reference naming a sheet is read
 * through `elsewhere`, which answers that sheet's `Lookup` or `null` where
 * there is no such sheet — and **without `elsewhere` every such reference is
 * refused**, including one naming the formula's own sheet. That is the default
 * on purpose: a `Lookup` that ignored the sheet it was asked about would add up
 * the right cells on the wrong sheet, and a number worked out that way is the
 * one failure worse than a number marked out of date.
 */
export function evaluate(
  formula: string,
  valueAt: Lookup,
  elsewhere?: (sheet: string) => Lookup | null,
): number | null {
  if (unreadable(formula)) return null;
  const tokens = tokenize(formula);
  if (tokens === null || tokens.length === 0) return null;

  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const take = (): Token | undefined => tokens[at++];
  const symbol = (text: string): boolean => {
    const token = peek();
    if (token?.kind === 'symbol' && token.text === text) {
      at++;
      return true;
    }
    return false;
  };

  /** The sheet a reference reads, or `null` where it cannot be read. */
  const sheetOf = (token: Extract<Token, { kind: 'ref' }>): Lookup | null =>
    token.sheet === null ? valueAt : (elsewhere?.(token.sheet) ?? null);

  /** Every cell of a reference, in order, however many there are; `null` where the sheet cannot be read. */
  const spread = (token: Extract<Token, { kind: 'ref' }>): Value[] | null => {
    const read = sheetOf(token);
    if (!read) return null;
    const out: Value[] = [];
    for (let row = token.from.row; row <= token.to.row; row++) {
      for (let col = token.from.col; col <= token.to.col; col++) out.push(read(row, col));
    }
    return out;
  };

  /** `null` anywhere below means the whole thing is unknown; it is never a value. */
  const expression = (): number | null => {
    let left = term();
    for (;;) {
      if (left === null) return null;
      if (symbol('+')) {
        const right = term();
        if (right === null) return null;
        left += right;
      } else if (symbol('-')) {
        const right = term();
        if (right === null) return null;
        left -= right;
      } else {
        return left;
      }
    }
  };

  const term = (): number | null => {
    let left = power();
    for (;;) {
      if (left === null) return null;
      if (symbol('*')) {
        const right = power();
        if (right === null) return null;
        left *= right;
      } else if (symbol('/')) {
        const right = power();
        if (right === null) return null;
        /* Dividing by zero is refused by the finiteness rule at the end rather
           than here. An explicit guard beside it passed every check with or
           without it — it was right for a reason nothing could break, which is
           to say nothing depended on it. One rule carries this now, and taking
           that one out fails `dividing by zero is refused rather than shown`. */
        left /= right;
      } else {
        return left;
      }
    }
  };

  const power = (): number | null => {
    const left = unary();
    if (left === null) return null;
    if (symbol('^')) {
      const right = power();
      if (right === null) return null;
      const raised = left ** right;
      return Number.isFinite(raised) ? raised : null;
    }
    return left;
  };

  const unary = (): number | null => {
    if (symbol('-')) {
      const value = unary();
      return value === null ? null : -value;
    }
    if (symbol('+')) return unary();
    return atom();
  };

  const atom = (): number | null => {
    const token = take();
    if (!token) return null;

    if (token.kind === 'number') return token.value;

    if (token.kind === 'ref') {
      /* A range standing alone in arithmetic is not something to add up — that
         is what SUM is for, and Excel calls it `#VALUE!`. */
      if (token.from.row !== token.to.row || token.from.col !== token.to.col) return null;
      const read = sheetOf(token);
      if (!read) return null;
      const value = read(token.from.row, token.from.col);
      if (value === undefined) return 0;
      return value;
    }

    if (token.kind === 'symbol' && token.text === '(') {
      const inside = expression();
      if (inside === null || !symbol(')')) return null;
      return inside;
    }

    if (token.kind === 'name') {
      if (token.text !== 'SUM' || !symbol('(')) return null;
      let total = 0;
      if (!symbol(')')) {
        for (;;) {
          const argument = peek();
          if (argument?.kind === 'ref') {
            at++;
            const values = spread(argument);
            if (values === null) return null;
            for (const value of values) {
              /* Text and empty alike are passed over, which is what a total
                 under a column of headings depends on. */
              if (typeof value === 'number') total += value;
            }
          } else {
            const value = expression();
            if (value === null) return null;
            total += value;
          }
          if (symbol(',')) continue;
          if (symbol(')')) break;
          return null;
        }
      }
      return total;
    }

    return null;
  };

  const answer = expression();
  /* Anything left over means the formula was not what it looked like. */
  return at === tokens.length && answer !== null && Number.isFinite(answer) ? answer : null;
}

/* ── keeping a sheet current after somebody types ────────────────────── */

/** As much of a cell as recalculation is about. */
export interface Held {
  text: string;
  kind: string;
  formula?: string;
}

/** What a sheet looks like once the typing is taken into account. */
export interface Recalculation {
  /** Formula cells this worked out afresh, by `row,col`. */
  values: Map<string, number>;
  /**
   * Formula cells whose shown number can no longer be trusted, by `row,col`.
   *
   * Three ways in, and the third is the one that makes this honest: a formula
   * whose inputs changed and which this cannot work out; a formula holding a
   * reference this cannot read while anything at all has changed; and a formula
   * that reads a cell already stale, because a total of unreliable numbers is
   * an unreliable number.
   */
  stale: Set<string>;
}

/** One sheet of a workbook, as far as recalculation is about. */
export interface BookSheet {
  name: string;
  cells: ReadonlyMap<string, Held>;
}

const key = (row: number, col: number) => `${row},${col}`;
const parse = (text: string): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

/** `index:row,col` — a cell anywhere in the workbook, keyed the way the editor keys its edits. */
const place = (sheet: number, at: string) => `${sheet}:${at}`;
const unplace = (placed: string): [number, number, number] => {
  const cut = placed.indexOf(':');
  const [row, col] = placed.slice(cut + 1).split(',').map(Number) as [number, number];
  return [Number(placed.slice(0, cut)), row, col];
};

/**
 * What changed on one sheet because somebody typed into it.
 *
 * `recalculateBook` with a workbook of one sheet. A reference naming any other
 * sheet is one this has nothing to read for, so it is refused and the formula
 * holding it marked, never worked out against the sheet it was given.
 */
export function recalculate(
  cells: ReadonlyMap<string, Held>,
  sheetName: string,
  typed: ReadonlyMap<string, string>,
  tables?: Tables,
): Recalculation {
  return recalculateBook([{ name: sheetName, cells }], new Map([[0, typed]]), tables).get(0)!;
}

/**
 * What changed across a workbook because somebody typed into it, sheet by
 * sheet, by the sheet's index in `sheets`.
 *
 * The question is not "what do the formulas come to" — it is **which of the
 * numbers on the screen are no longer true**, and that is a different question
 * with a more careful answer. A formula nothing has touched is left exactly
 * alone: its cached result is still right and recomputing it would only risk
 * disagreeing with Excel about a number nobody changed.
 *
 * **It is the whole workbook rather than the sheet typed into**, because that
 * is where the formulas reading a cell are. Worked out a sheet at a time, a
 * total on `Sazetak` reading `Cashless!L7` never saw `L7` retyped — the pass
 * over `Cashless` does not look at `Sazetak`, and the pass over `Sazetak` never
 * ran, because nothing was typed there. Every one of the 35 `SUMIFS` in the
 * measured corpus reads a table on another sheet, so the same gap left all 35
 * showing their old totals, unmarked, when their table was edited.
 *
 * **The cost of that is real and is named rather than hidden.** A formula this
 * cannot read goes stale on *any* edit to the workbook, because there is no way
 * to tell whether it read the cell that changed. Given `tables`, that is none of
 * the 35 structured references in the one real workbook that has them: what
 * remains unreadable is every other bracketed shape — `[#Totals]`, `[@Column]`,
 * a span of columns, a table nobody declared — and a span of sheets.
 *
 * It settles by going round until nothing moves, because a total feeds a total:
 * the sum of a column feeds the grand total under it, and one edit has to
 * travel the whole way, from sheet to sheet if that is where the totals are. A
 * workbook whose formulas refer to each other in a ring would go round for
 * ever, so the rounds are capped — a circular reference is something Excel
 * itself refuses to resolve, and this stops rather than hangs.
 */
export function recalculateBook(
  sheets: readonly BookSheet[],
  typed: ReadonlyMap<number, ReadonlyMap<string, string>>,
  tables?: Tables,
): Map<number, Recalculation> {
  const values = new Map<string, number>();
  const stale = new Set<string>();
  /** Every cell whose value is not what the file says any more. */
  const moved = new Set<string>();
  for (const [sheet, cells] of typed) for (const at of cells.keys()) moved.add(place(sheet, at));

  const byName = new Map(sheets.map((sheet, index) => [sheet.name.toLowerCase(), index]));

  /** What a cell is worth now: what was typed, what was worked out, or what the file holds. */
  const lookups = sheets.map(
    (sheet, index): Lookup =>
      (row, col) => {
        const at = key(row, col);
        const written = typed.get(index)?.get(at);
        if (written !== undefined) return parse(written);
        const worked = values.get(place(index, at));
        if (worked !== undefined) return worked;
        const cell = sheet.cells.get(at);
        if (!cell) return undefined;
        if (cell.kind !== 'number') return null;
        return parse(cell.text);
      },
  );
  const elsewhere = (name: string): Lookup | null => {
    const index = byName.get(name.toLowerCase());
    return index === undefined ? null : lookups[index]!;
  };

  const formulas: [number, string, Held][] = [];
  sheets.forEach((sheet, index) => {
    for (const [at, cell] of sheet.cells) if (cell.formula !== undefined) formulas.push([index, at, cell]);
  });
  const settled = new Set<string>();

  /* One round per link in the longest chain of totals, and no more. */
  for (let round = 0; round < 64; round++) {
    let changed = false;

    for (const [index, at, cell] of formulas) {
      const here = place(index, at);
      if (settled.has(here) || typed.get(index)?.has(at)) continue;
      const formula = cell.formula!;
      const sheetName = sheets[index]!.name;

      /* Does anything that moved reach this formula at all? */
      let reaches: Dependency = 'no';
      for (const source of moved) {
        const [sheet, row, col] = unplace(source);
        const answer = dependency(formula, sheetName, { row, col, sheet: sheets[sheet]!.name }, tables);
        if (answer === 'reads') {
          reaches = 'reads';
          break;
        }
        if (answer === 'unknown') reaches = 'unknown';
      }
      if (reaches === 'no') continue;

      /* A formula this cannot read may or may not have moved, and *may* is
         reason enough to stop showing its number as current. There is no
         separate branch for it: `evaluate` refuses exactly what `dependency`
         could not read, so it comes out stale below by the one rule rather
         than by two that agree. A branch here passed every check with and
         without itself. */

      /* A total of numbers that are themselves unreliable is unreliable, even
         where every function in it is one this understands — and wherever in
         the workbook those numbers are. */
      const readsStale = referencesOf(formula, tables).some((reference) => {
        const on = reference.sheet === null ? index : byName.get(reference.sheet.toLowerCase());
        if (on === undefined) return false;
        for (const gone of stale) {
          const [sheet, row, col] = unplace(gone);
          if (
            sheet === on &&
            row >= reference.from.row &&
            row <= reference.to.row &&
            col >= reference.from.col &&
            col <= reference.to.col
          ) {
            return true;
          }
        }
        return false;
      });

      settled.add(here);
      changed = true;
      const worked = readsStale ? null : evaluate(formula, lookups[index]!, elsewhere);
      if (worked === null) {
        stale.add(here);
        moved.add(here);
        continue;
      }
      /* A number that did not move is not news, and saying so would put a
         marker on a cell nobody changed. */
      values.set(here, worked);
      if (parse(cell.text) !== worked) moved.add(here);
    }

    if (!changed) break;
  }

  const answer = new Map<number, Recalculation>(
    sheets.map((_, index) => [index, { values: new Map(), stale: new Set() }]),
  );
  for (const [placed, value] of values) {
    const cut = placed.indexOf(':');
    answer.get(Number(placed.slice(0, cut)))!.values.set(placed.slice(cut + 1), value);
  }
  for (const placed of stale) {
    const cut = placed.indexOf(':');
    answer.get(Number(placed.slice(0, cut)))!.stale.add(placed.slice(cut + 1));
  }
  return answer;
}
