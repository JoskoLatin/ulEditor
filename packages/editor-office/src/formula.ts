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
 * So this works out `SUM`, arithmetic, and — given the workbook's tables and
 * sheets — `SUMIFS` and `COUNTIFS`, and **refuses everything else out loud**
 * rather than guessing at it. `AVERAGE`, `MIN` and `MAX` are the same shape as
 * `SUM` and would cost ten lines; they are not here because the census did not
 * find them. Adding one is a measurement away, not a rewrite.
 *
 * A criterion's rules were measured the same way, in Excel itself rather than
 * from memory — blanks, text that is a number, case, the locale — and every
 * rule that was not measured is a refusal. `criterionOf` has them.
 *
 * Run over the same real spreadsheets with nothing but the formula in hand,
 * `evaluate` works out **296 of 344 formulas — 86%**; the 34 over a table need
 * the table, and `recalculateBook` is what hands it over. Every one of the 48
 * refused that way was looked at rather than counted: 34 are the
 * `SUMIFS`/`COUNTIFS` over a table, six are `SUBTOTAL`, two are
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

/**
 * What a cell holds, as far as a formula is concerned: a number, the text of a
 * text cell, `undefined` for no cell at all, and `null` for anything else — a
 * date, a truth value, an error — which nothing here compares or adds.
 *
 * Text is carried rather than folded into `null` because `SUMIFS` has to read
 * it: `"Gotovina"` is a criterion about words. Arithmetic still refuses it.
 */
export type Value = number | string | null | undefined;

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

/*
 * Every name below is bounded, and every match that can begin inside a name is
 * told not to. Unbounded, a formula of one long word was scanned from each of
 * its letters to the end — 100 ms a call at Excel's own limit of 8 192
 * characters and four times that for every doubling, on a file nobody has to
 * write by Excel. A sheet's name is at most 31 characters, doubled quotes and
 * all 62 inside quotes; a table's or a column's at most 255.
 */
const NAME_START = String.raw`A-Za-z_\\À-￿`;
const NAME_REST = String.raw`A-Za-z0-9_.\\À-￿`;
/** A sheet name before a `!`, with the quotes a name with a space in it carries. */
const SHEET = String.raw`(?:'((?:[^']|''){1,62})'|(?<![${NAME_REST}])([${NAME_START}][${NAME_REST}]{0,30}))!`;
/* Either case: a file written by a script says `sum(a1:a5)`, and read as
   upper case only that was a formula reading nothing at all. */
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?[0-9]{1,7}`;
const REFERENCE = new RegExp(
  String.raw`(?<![${NAME_REST}$])(?:${SHEET})?(${CELL})(?::(${CELL}))?(?![A-Za-z0-9_(])`,
  'g',
);
/* `M:M` and `2:4` — whole columns and whole rows. Nothing about them looks like
   `A1`, so without this a formula reading `Podaci!M:M` read nothing at all, and
   answered `'no'` for every cell in that column. */
const LINES = new RegExp(
  String.raw`(?<![${NAME_REST}$:!'])(?:${SHEET})?(?:(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})|(\$?[0-9]{1,7}):(\$?[0-9]{1,7}))(?![${NAME_REST}(!:])`,
  'g',
);
/** The last row and column a sheet can have: 1 048 576 rows, XFD columns. */
const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;

/** Anything this module knows it cannot read, each of which makes an answer `'unknown'`. */
const UNREADABLE = [
  /* A bracket left once the declared `Table[Column]`s are taken out: any other
     structured shape — `[#Totals]`, `[@Iznos]` with no table named, a table
     nobody declared — or another workbook, `[1]List1!A1`. */
  /\[/,
  /* `#REF!`, `#VALUE!` and the rest: the formula is already broken. */
  /#[A-Z/0-9]+[!?]/,
  /* Functions that read cells their text does not name: `OFFSET(A1,1,0,3,1)`
     reads A2:A4, `INDIRECT("B"&C1)` whatever C1 spells, and a spilled range
     `A1#` — `ANCHORARRAY(A1)` in the file — however far the spill reaches.
     Read as their text, each answered 'no' to the cells it actually read. A
     name defined as a LAMBDA and called like a function cannot be told from a
     built-in one without `xl/workbook.xml`, which this module does not see;
     that is a risk this knows it takes. */
  /(?<![A-Za-z0-9_.])(?:_xlfn\.)?(?:OFFSET|INDIRECT|ANCHORARRAY)\s*\(/i,
  /[A-Za-z]{1,3}\$?[0-9]{1,7}#/,
  /* `SUM(Jan:Mar!B2)` — a span of sheets. Read as a reference it would be
     `Mar!B2` alone, and an edit to `B2` on `Feb` would be answered `'no'`.
     Quoted, the colon is inside the quotes, and a sheet's own name cannot
     hold one. */
  new RegExp(`:${SHEET}|'(?:[^':]|''){0,62}:(?:[^']|''){0,62}'!`),
];

/** Past Excel's own limit a formula is not something Excel wrote, and is not read at all. */
const LONGEST_FORMULA = 8_192;

/* What is taken out of a formula before asking whether any name is left in it. */
const CALL = new RegExp(String.raw`(?<![${NAME_REST}])[${NAME_START}][${NAME_REST}]{0,254}\s*\(`, 'g');
const NUMBER = /(?<![A-Za-z0-9_.])[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?/g;
const TRUTH = new RegExp(String.raw`(?<![${NAME_REST}])(?:TRUE|FALSE)(?![${NAME_REST}(])`, 'gi');
/* A quote or a `!` left over is a sheet named in a way this did not read —
   a quoted name longer than any sheet can have, a name of digits alone — and
   the reference after it would otherwise be taken for this sheet's. */
const LETTER = new RegExp(`[${NAME_START}'!]`);

/**
 * Whether a name is left once everything this module understands is taken out.
 *
 * `SUM(Iznosi)` over a defined name answered `'no'` to every cell, because
 * nothing in it looked like `A1` — the direction that leaves a stale total on
 * the screen unmarked. What a name stands for is in `xl/workbook.xml`, which
 * this module does not see, so a name is admitted as unreadable rather than
 * read as nothing. `…`, which the reader writes for a formula it could not
 * recover, is caught the same way.
 */
function namesLeft(piece: string): boolean {
  const rest = piece
    .replace(REFERENCE, ' ')
    .replace(LINES, ' ')
    .replace(CALL, '(')
    .replace(NUMBER, ' ')
    .replace(TRUTH, ' ');
  return LETTER.test(rest);
}

/** `PodaciTable[Iznos]` — a table's name, then one plain column name in brackets. Nothing else. */
const STRUCTURED = new RegExp(String.raw`(?<![${NAME_REST}])([${NAME_START}][${NAME_REST}]{0,254})\[([^[\]]{0,255})\]`, 'g');

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
  if (formula.length > LONGEST_FORMULA) return true;
  return outsideQuotes(formula).some((whole) => {
    const piece = tables ? tableReferences(whole, tables).rest : whole;
    return UNREADABLE.some((shape) => shape.test(piece)) || namesLeft(piece);
  });
}

/**
 * Every rectangle a formula reads, or `null` where something in it cannot be
 * read. `dependency` answers from this, and so does `recalculateBook` — worked
 * out once per formula there — so the two cannot come to disagree.
 */
function readsOf(formula: string, tables?: Tables): Reference[] | null {
  return unreadable(formula, tables) ? null : referencesOf(formula, tables);
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
  const reads = readsOf(formula, tables);
  if (reads === null) return 'unknown';
  const here = sheetName.toLowerCase();
  const there = (at.sheet ?? sheetName).toLowerCase();
  for (const reference of reads) {
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
  | { kind: 'string'; value: string }
  | { kind: 'ref'; sheet: string | null; from: { row: number; col: number }; to: { row: number; col: number } }
  | { kind: 'name'; text: string }
  | { kind: 'symbol'; text: string };

/** What the memos below are kept by when a formula is read with no tables. */
const NO_TABLES = {};
/** A memo past this many formulas is emptied rather than left to grow without end. */
const MOST_REMEMBERED = 200_000;

/** `Name[Column]` at the start of the text — the one structured shape `tableReferences` resolves. */
const STRUCTURED_HERE = new RegExp(String.raw`^([${NAME_START}][${NAME_REST}]{0,254})\[([^[\]]{0,255})\]`);

/** `null` where anything at all was not understood. */
function tokenize(formula: string, tables?: Tables): Token[] | null {
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
    /* A string is a word, which only a criterion has any use for; everywhere
       else the parser refuses it. `""` inside one is a quote. */
    if (ch === '"') {
      const string = /^"((?:[^"]|"")*)"/.exec(text.slice(at));
      if (!string) return null;
      tokens.push({ kind: 'string', value: string[1]!.replace(/""/g, '"') });
      at += string[0].length;
      continue;
    }
    /* `PodaciTable[Iznos]`, where the table is declared: the column it names,
       on the sheet the table is on. Anything else in brackets has already been
       refused by `unreadable`. */
    const structured = STRUCTURED_HERE.exec(text.slice(at));
    if (structured) {
      const table = tables?.get(structured[1]!.toLowerCase());
      const offset = table?.columns.get(structured[2]!.toLowerCase());
      if (!table || offset === undefined) return null;
      const col = table.fromCol + offset;
      tokens.push({ kind: 'ref', sheet: table.sheet, from: { row: table.fromRow, col }, to: { row: table.toRow, col } });
      at += structured[0].length;
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
 * What `evaluate` makes of a formula's text before it reads a cell — whether
 * it can be read at all, and its tokens — remembered, for the same reason as
 * `readsCached`: a running balance five thousand rows long works out five
 * thousand formulas on one keystroke, and each was read afresh every time.
 * The tokens are never changed once made; `evaluate` only walks them.
 */
const tokensMemo = new WeakMap<object, Map<string, Token[] | null>>();
function tokensCached(formula: string, tables?: Tables): Token[] | null {
  const owner = tables ?? NO_TABLES;
  let memo = tokensMemo.get(owner);
  if (!memo) tokensMemo.set(owner, (memo = new Map()));
  const known = memo.get(formula);
  if (known !== undefined) return known;
  const tokens = unreadable(formula, tables) ? null : tokenize(formula, tables);
  if (memo.size >= MOST_REMEMBERED) memo.clear();
  memo.set(formula, tokens);
  return tokens;
}

/**
 * The most cells one formula may read and still be worked out: one whole
 * column's worth, across all its references together. Per reference, sixteen
 * whole-column ranges in one `SUM` were sixteen million lookups — seconds, on
 * the keystroke that ends the typing — and a formula can hold hundreds.
 */
const MOST_CELLS = 1_048_576;

const areaOf = (ref: { from: { row: number; col: number }; to: { row: number; col: number } }) =>
  (ref.to.row - ref.from.row + 1) * (ref.to.col - ref.from.col + 1);

/** Whether a cell meets a criterion; `null` where this cannot say, which refuses the whole formula. */
type Criterion = (value: Value) => boolean | null;

/** A whole number written out, with nothing a locale could read differently. */
const PLAIN_INTEGER = /^-?[0-9]+$/;
/** Digits with separators, a sign, a percent or a date's slashes — read by Excel through the locale. */
const LOCALE_NUMBER = /^(?=.*[0-9])[\s+\-−0-9.,%/:eE]+$/;

/**
 * A `SUMIFS`/`COUNTIFS` criterion, as Excel 16 answered 34 cases over a sheet
 * built to tell the rules apart (`tools/verify-formula-excel.mjs`):
 *
 * - **equal to a number** matches a number cell of that value, and a text cell
 *   that is that whole number written out — `"5"` matches `5`. An empty cell
 *   is not zero: `COUNTIFS(E:E, 0)` counted the three zeros and not the blanks.
 * - **`>`, `<`, `>=`, `<=` a number** match number cells only; `"5"` as text is
 *   not greater than 4.
 * - **`<>`** is the other side of equality, blanks included — `"<>0"` counted
 *   both blank cells, and `"<>Gotovina"` added the blank row in.
 * - **equal to text** is case-insensitive and exact otherwise: `"= Gotovina"`
 *   matched nothing, `"Gotovina "` was not matched by `"Gotovina"`, and an en
 *   dash is not a hyphen. `""` is a blank cell, bare `"<>"` a cell that is not.
 *
 * Everything else is refused rather than guessed: wildcards (`*`, `?`, `~`),
 * text compared with `>` or `<`, `TRUE`/`FALSE`, a criterion that is a cell,
 * and any number written with a separator — `"5,0"` matched 5 and `"5.0"` did
 * not, on this machine, because Excel reads it through the locale. A cell that
 * is neither number, text nor blank (a date, an error) refuses it too.
 */
function criterionOf(token: Token): Criterion | null {
  let operator: string;
  let number: number | null = null;
  let text: string | null = null;

  if (token.kind === 'number') {
    operator = '=';
    number = token.value;
  } else if (token.kind === 'string') {
    operator = ['<>', '>=', '<=', '=', '>', '<'].find((one) => token.value.startsWith(one)) ?? '=';
    const rest = token.value.slice(token.value.startsWith(operator) ? operator.length : 0);
    if (/[*?~]/.test(rest)) return null;
    if (PLAIN_INTEGER.test(rest)) number = Number(rest);
    else if (LOCALE_NUMBER.test(rest) || /^(true|false)$/i.test(rest)) return null;
    else text = rest.toLowerCase();
  } else {
    return null;
  }

  if (number !== null) {
    const n = number;
    const equal: Criterion = (value) => {
      if (value === null) return null;
      if (typeof value === 'number') return value === n;
      if (typeof value === 'string') {
        if (PLAIN_INTEGER.test(value)) return Number(value) === n;
        return LOCALE_NUMBER.test(value) ? null : false;
      }
      return false;
    };
    const ordered = (compare: (value: number) => boolean): Criterion => (value) =>
      value === null ? null : typeof value === 'number' && compare(value);
    switch (operator) {
      case '=':
        return equal;
      case '<>':
        return (value) => {
          const same = equal(value);
          return same === null ? null : !same;
        };
      case '>':
        return ordered((value) => value > n);
      case '<':
        return ordered((value) => value < n);
      case '>=':
        return ordered((value) => value >= n);
      default:
        return ordered((value) => value <= n);
    }
  }

  if (operator !== '=' && operator !== '<>') return null;
  const wanted = text!;
  const equal: Criterion = (value) => {
    if (value === null) return null;
    if (wanted === '') return value === undefined || value === '';
    return typeof value === 'string' && value.toLowerCase() === wanted;
  };
  if (operator === '=') return equal;
  return (value) => {
    const same = equal(value);
    return same === null ? null : !same;
  };
}

/**
 * Works the formula out, or answers `null` because it could not.
 *
 * `null` is not an error and it is not zero — it is "this program does not know
 * what this comes to", which is the only honest answer for a table nobody
 * declared, a sheet nobody named, a function nobody measured, a criterion
 * whose rules were not measured, or a division by zero. What the caller does with it is show the number it has as
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
 *
 * `tables` is what `PodaciTable[Iznos]` needs to become a range; without it
 * every structured reference is refused, as it always was.
 */
export function evaluate(
  formula: string,
  valueAt: Lookup,
  elsewhere?: (sheet: string) => Lookup | null,
  tables?: Tables,
): number | null {
  const tokens = tokensCached(formula, tables);
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

  /**
   * Cells this formula has read so far, against `MOST_CELLS`.
   *
   * The cap is a keystroke's worth of work, not a rule about spreadsheets:
   * `SUM(A1:XFD1048576)` is seventeen billion lookups. Past it the formula is
   * refused, which marks it rather than freezing the program. A whole column
   * written `A:A` never gets this far — it is not a reference the tokenizer
   * builds — so a formula reading one is refused, and marked, before any cell
   * is read.
   */
  let walked = 0;
  const budget = (cells: number): boolean => {
    walked += cells;
    return walked <= MOST_CELLS;
  };

  /** Every cell of a reference, in order, handed to `visit` one at a time; `false` where it cannot be read. */
  const spread = (token: Extract<Token, { kind: 'ref' }>, visit: (value: Value) => void): boolean => {
    const read = sheetOf(token);
    if (!read || !budget(areaOf(token))) return false;
    for (let row = token.from.row; row <= token.to.row; row++) {
      for (let col = token.from.col; col <= token.to.col; col++) visit(read(row, col));
    }
    return true;
  };

  /**
   * `SUMIFS(sum, range, criterion, …)` or `COUNTIFS(range, criterion, …)`, the
   * opening bracket already taken.
   *
   * Row by row rather than column by column: in the real workbook that is 34
   * formulas over a table of 5 416 rows, each reading up to four columns, on the
   * keystroke that ends the typing — and nothing is built up per column.
   */
  const conditional = (summing: boolean): number | null => {
    const arguments_: Token[] = [];
    for (;;) {
      const argument = take();
      if (!argument) return null;
      if (argument.kind === 'symbol' && argument.text === '-' && peek()?.kind === 'number') {
        arguments_.push({ kind: 'number', value: -(take() as { value: number }).value });
      } else {
        arguments_.push(argument);
      }
      if (symbol(',')) continue;
      if (symbol(')')) break;
      return null;
    }

    const sum = summing ? arguments_.shift() : undefined;
    if (summing && sum?.kind !== 'ref') return null;
    if (arguments_.length === 0 || arguments_.length % 2 !== 0) return null;

    const pairs: { read: Lookup; from: { row: number; col: number }; test: Criterion }[] = [];
    const first = arguments_[0];
    if (first?.kind !== 'ref') return null;
    const rows = first.to.row - first.from.row;
    const cols = first.to.col - first.from.col;
    const sameShape = (ref: Extract<Token, { kind: 'ref' }>) =>
      ref.to.row - ref.from.row === rows && ref.to.col - ref.from.col === cols;

    for (let i = 0; i < arguments_.length; i += 2) {
      const range = arguments_[i]!;
      /* Excel answers `#VALUE!` to ranges of different shapes. */
      if (range.kind !== 'ref' || !sameShape(range)) return null;
      const read = sheetOf(range);
      const test = criterionOf(arguments_[i + 1]!);
      if (!read || !test) return null;
      pairs.push({ read, from: range.from, test });
    }
    let readSum: Lookup | null = null;
    if (sum?.kind === 'ref') {
      if (!sameShape(sum)) return null;
      readSum = sheetOf(sum);
      if (!readSum) return null;
    }
    /* Every range is read in full, the summed one included. */
    if (!budget(areaOf(first) * (pairs.length + (readSum ? 1 : 0)))) return null;

    let total = 0;
    for (let row = 0; row <= rows; row++) {
      cell: for (let col = 0; col <= cols; col++) {
        for (const pair of pairs) {
          const matched = pair.test(pair.read(pair.from.row + row, pair.from.col + col));
          if (matched === null) return null;
          if (!matched) continue cell;
        }
        if (!readSum || sum?.kind !== 'ref') {
          total++;
          continue;
        }
        const value = readSum(sum.from.row + row, sum.from.col + col);
        /* Text and empty cells in the summed column are passed over, as SUM
           passes over them; a date or an error is not something to guess at. */
        if (value === null) return null;
        if (typeof value === 'number') total += value;
      }
    }
    return total;
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
      /* A word in arithmetic is `#VALUE!` in Excel, not nothing. */
      if (typeof value === 'string') return null;
      return value;
    }

    if (token.kind === 'symbol' && token.text === '(') {
      const inside = expression();
      if (inside === null || !symbol(')')) return null;
      return inside;
    }

    if (token.kind === 'name' && (token.text === 'SUMIFS' || token.text === 'COUNTIFS')) {
      if (!symbol('(')) return null;
      return conditional(token.text === 'SUMIFS');
    }

    if (token.kind === 'name') {
      if (token.text !== 'SUM' || !symbol('(')) return null;
      let total = 0;
      if (!symbol(')')) {
        for (;;) {
          const argument = peek();
          if (argument?.kind === 'ref') {
            at++;
            /* Text and empty alike are passed over, which is what a total
               under a column of headings depends on. A date is a number to
               Excel and an error is an error; neither is something to pass
               over quietly, so either refuses the total. */
            let refused = false;
            const read = spread(argument, (value) => {
              if (typeof value === 'number') total += value;
              else if (value === null) refused = true;
            });
            if (!read || refused) return null;
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
  /** The value as the file stores it. Where it is a number it is the number — `text` is formatted for a person. */
  raw?: number | string | boolean;
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
  /** The first column not read, on a sheet the reader cut short; a cell past it is unknown, not empty. */
  readTo?: number;
}

const key = (row: number, col: number) => `${row},${col}`;
/**
 * What text, read the way the writer reads it, is as a number — or `null`.
 *
 * The writer's rule, `numberOf` in `xlsx-edit.ts`, and not JavaScript's:
 * `Number` takes `1e3`, `.5`, `+5`, `5.` and `0x10` as numbers, and the writer
 * saves every one of them as text. A total that counted them showed a number
 * Excel would not show once the file was opened.
 */
const parse = (text: string): number | null => {
  const normalized = text.trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : null;
};

/** `15.6.2026.` — what the writer saves as a date. */
const TYPED_DATE = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\.?$/;

/**
 * What a typed value is to a formula, by the same decisions the writer makes
 * when it saves it: nothing typed is an empty cell, a date is a date — which
 * nothing here adds up — a number is a number, and anything else is text.
 * `verify-sheet-stale` holds this and `typedKind` to agreeing.
 */
export function typedValue(written: string): Value {
  if (written === '') return undefined;
  if (TYPED_DATE.test(written.trim())) return null;
  return parse(written) ?? written;
}

/** `index:row,col` — a cell anywhere in the workbook, keyed the way the editor keys its edits. */
const place = (sheet: number, at: string) => `${sheet}:${at}`;

/**
 * `readsOf`, remembered. The same formula text read against the same tables
 * always reads the same rectangles, and working that out is the regular
 * expressions — so a workbook's formulas are read once, not once a keystroke.
 * Remembered per `tables`, which lives as long as its workbook; a formula read
 * with none shares one map, cleared rather than left to grow without end.
 */
const readsMemo = new WeakMap<object, Map<string, Reference[] | null>>();
function readsCached(formula: string, tables?: Tables): Reference[] | null {
  const owner = tables ?? NO_TABLES;
  let memo = readsMemo.get(owner);
  if (!memo) readsMemo.set(owner, (memo = new Map()));
  const known = memo.get(formula);
  if (known !== undefined) return known;
  const reads = readsOf(formula, tables);
  if (memo.size >= MOST_REMEMBERED) memo.clear();
  memo.set(formula, reads);
  return reads;
}

/** A binary heap of formula numbers, smallest first — the file's order. */
class Heap {
  #items: number[] = [];
  get size(): number {
    return this.#items.length;
  }
  push(value: number): void {
    const items = this.#items;
    let at = items.length;
    items.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (items[parent]! <= value) break;
      items[at] = items[parent]!;
      at = parent;
    }
    items[at] = value;
  }
  pop(): number {
    const items = this.#items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      let at = 0;
      for (;;) {
        const left = 2 * at + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && items[right]! < items[left]! ? right : left;
        if (items[child]! >= last) break;
        items[at] = items[child]!;
        at = child;
      }
      items[at] = last;
    }
    return top;
  }
  /** Everything in `other`, which is left empty. */
  take(other: Heap): void {
    this.#items = other.#items;
    other.#items = [];
  }
}

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
 * It settles by following each change to the formulas it reaches, because a
 * total feeds a total: the sum of a column feeds the grand total under it, and
 * one edit has to travel the whole way, from sheet to sheet if that is where the
 * totals are. A formula is worked out again whenever a number under it moves —
 * `B2 = B1 + B3` with `B3 = B1 * 0.25` waits for both — and a ring of formulas
 * reading each other, which would go on for ever, is capped and marked: a
 * circular reference is something Excel itself refuses to resolve.
 */
export function recalculateBook(
  sheets: readonly BookSheet[],
  typed: ReadonlyMap<number, ReadonlyMap<string, string>>,
  tables?: Tables,
): Map<number, Recalculation> {
  /*
   * What each sheet's formulas came to, and what was typed on it, by a number
   * rather than by `row,col`: a formula reading a row of fifty cells reads
   * fifty, ten thousand of them half a million, and building a string key and
   * hashing it three times for each was most of a keystroke. The text of the
   * key is built once, for the file's own cells, and only when nothing typed
   * or worked out answers first. Typed text is read the writer's way once, not
   * once a read.
   */
  const cellNumber = (row: number, col: number) => row * 16_384 + col;
  const values = sheets.map(() => new Map<number, number>());
  const stale = sheets.map(() => new Set<string>());
  const typedValues = sheets.map((_, index) => {
    const own = new Map<number, Value>();
    for (const [at, written] of typed.get(index) ?? []) {
      const comma = at.indexOf(',');
      own.set(cellNumber(Number(at.slice(0, comma)), Number(at.slice(comma + 1))), typedValue(written));
    }
    return own;
  });

  /* Two sheets whose names are the same but for case — which is how this
     compares them, and Excel does not write — cannot be told apart, so a
     reference to either reads neither: `-1`, a sheet this workbook does not
     have, and a formula naming it is marked rather than read off the wrong one. */
  const byName = new Map<string, number>();
  sheets.forEach((sheet, index) => {
    const name = sheet.name.toLowerCase();
    byName.set(name, byName.has(name) ? -1 : index);
  });

  /** What a cell is worth now: what was typed, what was worked out, or what the file holds. */
  const lookups = sheets.map((sheet, index): Lookup => {
    const typedHere = typedValues[index]!;
    const worked_ = values[index]!;
    /*
     * The file's cells by number, built once a sheet has been read more times
     * than it has cells — so building it always costs less than the reads it
     * saves. Only for this keystroke: the editor rewrites cells in place after
     * a save, and a copy kept longer would read a cell that is no longer there.
     */
    let byNumber: Map<number, Held> | null = null;
    let reads = 0;
    const threshold = Math.max(4_096, sheet.cells.size);
    const cellAt = (row: number, col: number, at: number): Held | undefined => {
      if (byNumber) return byNumber.get(at);
      if (++reads > threshold) {
        byNumber = new Map();
        for (const [text, cell] of sheet.cells) {
          const comma = text.indexOf(',');
          byNumber.set(cellNumber(Number(text.slice(0, comma)), Number(text.slice(comma + 1))), cell);
        }
        return byNumber.get(at);
      }
      return sheet.cells.get(key(row, col));
    };
    return (row, col) => {
      const at = cellNumber(row, col);
      /* Typed text is text, as the writer saves it — `SUMIFS` reads the word. */
      if (typedHere.size > 0 && typedHere.has(at)) return typedHere.get(at);
      /* Past where the reader stopped, a cell is not empty — it is unread. */
      if (sheet.readTo !== undefined && col >= sheet.readTo) return null;
      const worked = worked_.get(at);
      if (worked !== undefined) return worked;
      const cell = cellAt(row, col, at);
      if (!cell) return undefined;
      if (cell.kind === 'text') return cell.text;
      if (cell.kind !== 'number') return null;
      /* The stored number, not the text: `1.000,00` read back as text is not
         a number, and SUM passed over it — a total a thousand short, shown
         as current. The text is the fallback for a reader that keeps none. */
      return typeof cell.raw === 'number' ? cell.raw : parse(cell.text);
    };
  });
  const elsewhere = (name: string): Lookup | null => {
    const index = byName.get(name.toLowerCase());
    return index === undefined || index === -1 ? null : lookups[index]!;
  };

  /** A rectangle a formula reads, its sheet already found; negative for a sheet the workbook does not have. */
  interface Area {
    on: number;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }

  /** A formula's rectangles with their sheets found; `null` where it cannot be read, or names a sheet that is two at once. */
  const areasOf = (references: Reference[] | null, index: number): Area[] | null => {
    if (references === null) return null;
    const areas: Area[] = [];
    for (const reference of references) {
      const on = reference.sheet === null ? index : (byName.get(reference.sheet.toLowerCase()) ?? -2);
      if (on === -1) return null;
      areas.push({ on, from: reference.from, to: reference.to });
    }
    return areas;
  };

  /* Every formula in the workbook, once, with what it reads. What a formula
     reads is remembered between keystrokes — see `readsCached` — because
     working it out is regular expressions over the formula's text, and a
     workbook of ten thousand formulas made that the larger part of a key. */
  interface Formula {
    sheet: number;
    at: string;
    row: number;
    col: number;
    cell: Held;
    reads: Area[] | null;
  }
  const formulas: Formula[] = [];
  sheets.forEach((sheet, index) => {
    const typedHere = typed.get(index);
    for (const [at, cell] of sheet.cells) {
      /* A formula typed over is a value now, and not worked out. */
      if (cell.formula === undefined || typedHere?.has(at)) continue;
      const comma = at.indexOf(',');
      formulas.push({
        sheet: index,
        at,
        row: Number(at.slice(0, comma)),
        col: Number(at.slice(comma + 1)),
        cell,
        reads: areasOf(readsCached(cell.formula, tables), index),
      });
    }
  });

  /*
   * Who reads what, the other way round: for a cell that changed, which
   * formulas does it reach? Answered from an index, so a change looks at the
   * few formulas reading near it rather than at every formula in the workbook.
   *
   * That turn is the whole of the speed. Asked the other way — every formula
   * looking down the list of every change — ten thousand formulas all reading
   * one typed cell cost half a second a keystroke, and a running balance five
   * thousand rows long a third of one: each formula re-read the changes every
   * formula before it had made. By column alone the balance still cost a
   * tenth of a second, because all five thousand read column B.
   *
   * So an area is filed three ways, by its shape:
   * - **small** — a few columns by a few blocks of `BLOCK` rows — under each
   *   (column, block) it covers;
   * - **tall** — a column or two down a long run of rows, `SUM(A1:A5000)` or
   *   `A:A` — under each column;
   * - **wide** — more than `NARROW` columns — under each block of rows it
   *   covers, `SUM(B5:AZ5)` under one; and where it covers more blocks than
   *   that, a whole row or a whole sheet, on its sheet's short list of huge ones.
   * A change looks in its own (column, block), its column's tall list, its
   * block's wide list and its sheet's huge list, and nowhere else. A formula
   * that cannot be read at all is reached by any change.
   *
   * Wide areas were one list a sheet, looked through on every change: ten
   * thousand row totals over fifty columns, and one shared input typed, was
   * two thirds of a second.
   */
  const NARROW = 32;
  const BLOCK = 64;
  const MOST_BUCKETS = 16;
  type Filed = { formula: number; area: Area };
  const small = sheets.map(() => new Map<number, Filed[]>());
  const tall = sheets.map(() => new Map<number, Filed[]>());
  const wide = sheets.map(() => new Map<number, Filed[]>());
  const huge = sheets.map((): Filed[] => []);
  const file = (into: Map<number, Filed[]>, at: number, filed: Filed) => {
    const list = into.get(at);
    if (list) list.push(filed);
    else into.set(at, [filed]);
  };
  /* A block number fits under 2^15 (1 048 576 / 64), so column and block make one number. */
  const bucket = (col: number, block: number) => col * 32_768 + block;
  /*
   * The index is bounded as a whole. A formula of 8 192 characters can name
   * two thousand ranges, and a file of thousands of them costs nothing to
   * send — filed without a limit, that is hundreds of millions of entries. A
   * workbook of ten thousand ordinary formulas files well under half of
   * this. A formula past the limit is not filed at all: any change reaches it
   * and it is marked — the direction that costs a marker, never a wrong number.
   * Two million was the first limit, and review measured a quarter of a
   * gigabyte a keystroke filling it.
   */
  const MOST_FILED = 500_000;
  let filedLeft = MOST_FILED;
  const blocksOf = (area: Area) => Math.floor(area.to.row / BLOCK) - Math.floor(area.from.row / BLOCK) + 1;
  const costOf = (reads: Area[]) => {
    let cost = 0;
    for (const area of reads) {
      const cols = area.to.col - area.from.col + 1;
      const blocks = blocksOf(area);
      if (cols > NARROW) cost += blocks > MOST_BUCKETS ? 1 : blocks;
      else cost += cols * blocks > MOST_BUCKETS ? cols : cols * blocks;
    }
    return cost;
  };
  const unreadableFormulas: number[] = [];
  const unfiled = new Uint8Array(formulas.length);
  formulas.forEach((formula, index) => {
    if (formula.reads === null) {
      unreadableFormulas.push(index);
      return;
    }
    const cost = costOf(formula.reads);
    if (cost > filedLeft) {
      unfiled[index] = 1;
      unreadableFormulas.push(index);
      return;
    }
    filedLeft -= cost;
    for (const area of formula.reads) {
      if (area.on < 0) continue;
      const filed = { formula: index, area };
      const cols = area.to.col - area.from.col + 1;
      const first = Math.floor(area.from.row / BLOCK);
      const last = Math.floor(area.to.row / BLOCK);
      if (cols > NARROW) {
        if (last - first + 1 > MOST_BUCKETS) huge[area.on]!.push(filed);
        else for (let block = first; block <= last; block++) file(wide[area.on]!, block, filed);
        continue;
      }
      if (cols * (last - first + 1) > MOST_BUCKETS) {
        for (let col = area.from.col; col <= area.to.col; col++) file(tall[area.on]!, col, filed);
        continue;
      }
      for (let col = area.from.col; col <= area.to.col; col++) {
        for (let block = first; block <= last; block++) file(small[area.on]!, bucket(col, block), filed);
      }
    }
  });

  /*
   * The formulas still to be worked out, taken in passes down the file's
   * order: one reached further down than the formula being worked out joins
   * this pass, one reached above it waits for the next.
   *
   * The order is not a detail. Taken in the order they were reached, a total
   * of the interest column under a 100-row repayment plan was worked out again
   * for every row of the plan as it settled, ran out of goes at 64, and was
   * marked on every keystroke. In passes it is worked out once, when the plan
   * above it has settled — as each pass over the sheet used to do, without
   * every formula asking about every change.
   */
  const now = new Heap();
  const next = new Heap();
  let cursor = -1;
  const queued = new Uint8Array(formulas.length);
  /* Reached by a number that is no longer true: whatever it comes to is not. */
  const poisoned = new Uint8Array(formulas.length);
  const done = new Uint8Array(formulas.length);
  /* Times each has been worked out — at most once a pass. A total feeds a
     total, so one may be worked out again as the numbers under it settle, but
     a ring of formulas reading each other never settles, and Excel itself
     refuses to resolve one. Past `ROUNDS` a formula is marked rather than
     worked out again. */
  const ROUNDS = 64;
  const worked = new Uint16Array(formulas.length);
  let unreadableReached = false;

  const enqueue = (index: number, poison: boolean) => {
    if (done[index]) return;
    if (poison) poisoned[index] = 1;
    if (queued[index]) return;
    queued[index] = 1;
    (index > cursor ? now : next).push(index);
  };
  const covers = (area: Area, row: number, col: number) =>
    row >= area.from.row && row <= area.to.row && col >= area.from.col && col <= area.to.col;

  /** A cell that changed — or went stale — and every formula it reaches. */
  const changed = (sheet: number, row: number, col: number, wentStale: boolean) => {
    for (const { formula, area } of small[sheet]!.get(bucket(col, Math.floor(row / BLOCK))) ?? []) {
      if (covers(area, row, col)) enqueue(formula, wentStale);
    }
    for (const { formula, area } of tall[sheet]!.get(col) ?? []) {
      if (row >= area.from.row && row <= area.to.row) enqueue(formula, wentStale);
    }
    for (const { formula, area } of wide[sheet]!.get(Math.floor(row / BLOCK)) ?? []) {
      if (covers(area, row, col)) enqueue(formula, wentStale);
    }
    for (const { formula, area } of huge[sheet]!) if (covers(area, row, col)) enqueue(formula, wentStale);
    if (!unreadableReached) {
      unreadableReached = true;
      for (const formula of unreadableFormulas) enqueue(formula, false);
    }
  };
  const markStale = (index: number) => {
    const formula = formulas[index]!;
    done[index] = 1;
    stale[formula.sheet]!.add(formula.at);
    values[formula.sheet]!.delete(cellNumber(formula.row, formula.col));
    changed(formula.sheet, formula.row, formula.col, true);
  };

  for (const [sheet, cells] of typed) {
    if (!sheets[sheet]) continue;
    for (const at of cells.keys()) {
      const comma = at.indexOf(',');
      changed(sheet, Number(at.slice(0, comma)), Number(at.slice(comma + 1)), false);
    }
  }

  for (;;) {
    if (now.size === 0) {
      if (next.size === 0) break;
      now.take(next);
      cursor = -1;
    }
    const index = now.pop();
    cursor = index;
    queued[index] = 0;
    if (done[index]) continue;
    const formula = formulas[index]!;

    /* A formula this cannot read may or may not have moved, and *may* is
       reason enough to stop showing its number as current. There is no
       separate branch for it: `evaluate` refuses exactly what `readsOf` could
       not read, so it comes out stale by the one rule.

       A total of numbers that are themselves unreliable is unreliable, even
       where every function in it is one this understands — and wherever in
       the workbook those numbers are. */
    if (poisoned[index] || unfiled[index] || ++worked[index]! > ROUNDS) {
      markStale(index);
      continue;
    }
    const answer = evaluate(formula.cell.formula!, lookups[formula.sheet]!, elsewhere, tables);
    if (answer === null) {
      markStale(index);
      continue;
    }
    /* A number that did not move is not news, and saying so would put a
       marker on a cell nobody changed. */
    const mine = values[formula.sheet]!;
    const here = cellNumber(formula.row, formula.col);
    const before = mine.has(here)
      ? mine.get(here)
      : typeof formula.cell.raw === 'number'
        ? formula.cell.raw
        : parse(formula.cell.text);
    mine.set(here, answer);
    if (before !== answer) changed(formula.sheet, formula.row, formula.col, false);
  }

  return new Map<number, Recalculation>(
    sheets.map((_, index) => {
      const own = new Map<string, number>();
      for (const [at, value] of values[index]!) own.set(key(Math.floor(at / 16_384), at % 16_384), value);
      return [index, { values: own, stale: stale[index]! }];
    }),
  );
}
