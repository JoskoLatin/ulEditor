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
 * `COUNTA` and `ROW`, and the remaining six are **references into another
 * sheet** — `SUM(Cashless!$L$7:$L$11)`. Those last are refused deliberately
 * even though the workbook is right there to read: refusing is the safe
 * direction, since it shows the total as stale rather than as a number, and
 * `dependency` below still tracks them properly, because it compares sheet
 * names rather than following them. A formula this cannot work out and a
 * formula this does not know about are two different things, and only the
 * second one is dangerous.
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
   * The sheet named before the `!`, or `null` for this one.
   *
   * Kept rather than followed: this module is given one sheet's values, and a
   * reference into another is a reference it cannot read — which is an answer,
   * not a failure.
   */
  sheet: string | null;
  from: { row: number; col: number };
  to: { row: number; col: number };
}

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

/** Anything this module knows it cannot read, each of which makes an answer `'unknown'`. */
const UNREADABLE = [
  /* `Tablica1[Iznos]` — a structured table reference, which needs the table
     definition out of another part of the archive to become a range at all. */
  /[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*\[/,
  /* `#REF!`, `#VALUE!` and the rest: the formula is already broken. */
  /#[A-Z/0-9]+[!?]/,
];

/** Every rectangle a formula reads, as far as it can be read. */
export function referencesOf(formula: string): Reference[] {
  const found: Reference[] = [];
  for (const piece of outsideQuotes(formula)) {
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
  }
  return found;
}

/** Whether anything in the formula is beyond what this module can read. */
function unreadable(formula: string): boolean {
  return outsideQuotes(formula).some((piece) => UNREADABLE.some((shape) => shape.test(piece)));
}

/**
 * Whether this formula, standing on this sheet, reads that cell.
 *
 * A reference naming another sheet is not this sheet's — unless it names this
 * one, which a workbook of several sheets does often enough to matter. The
 * comparison is case-insensitive, because that is how a spreadsheet compares
 * sheet names.
 */
export function dependency(
  formula: string,
  sheetName: string,
  at: { row: number; col: number },
): Dependency {
  if (unreadable(formula)) return 'unknown';
  const here = sheetName.toLowerCase();
  for (const reference of referencesOf(formula)) {
    if (reference.sheet !== null && reference.sheet.toLowerCase() !== here) continue;
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
  | { kind: 'ref'; from: { row: number; col: number }; to: { row: number; col: number } }
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
      /* A reference to another sheet is not this module's to work out. */
      if (reference[1] !== undefined || reference[2] !== undefined) return null;
      const from = parseA1(reference[3]!);
      const to = reference[4] ? parseA1(reference[4]) : from;
      if (!from || !to) return null;
      tokens.push({
        kind: 'ref',
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
 */
export function evaluate(formula: string, valueAt: Lookup): number | null {
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

  /** Every cell of a reference, in order, however many there are. */
  const spread = (token: Extract<Token, { kind: 'ref' }>): Value[] => {
    const out: Value[] = [];
    for (let row = token.from.row; row <= token.to.row; row++) {
      for (let col = token.from.col; col <= token.to.col; col++) out.push(valueAt(row, col));
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
      const value = valueAt(token.from.row, token.from.col);
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
            for (const value of spread(argument)) {
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

const key = (row: number, col: number) => `${row},${col}`;
const parse = (text: string): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

/**
 * What changed on a sheet because somebody typed into it.
 *
 * The question is not "what do the formulas come to" — it is **which of the
 * numbers on the screen are no longer true**, and that is a different question
 * with a more careful answer. A formula nothing has touched is left exactly
 * alone: its cached result is still right and recomputing it would only risk
 * disagreeing with Excel about a number nobody changed.
 *
 * **The cost of that is real and is named rather than hidden.** A formula this
 * cannot read goes stale on *any* edit to the sheet, because there is no way to
 * tell whether it read the cell that changed. In the one real workbook that has
 * such formulas there are 35 of them, so a single keystroke marks all 35. The
 * alternative is showing a number that may be wrong, and between annoying and
 * wrong this picks annoying — but the way out is not a rule guessed here. It is
 * resolving `Tablica1[Iznos]` into the range it stands for, which is a
 * measurement away: the table definitions are in `xl/tables/*.xml`, in the
 * archive the editor already has open.
 *
 * It settles by going round until nothing moves, because a total feeds a total:
 * the sum of a column feeds the grand total under it, and one edit has to
 * travel the whole way. A workbook whose formulas refer to each other in a ring
 * would go round for ever, so the rounds are capped — a circular reference is
 * something Excel itself refuses to resolve, and this stops rather than hangs.
 */
export function recalculate(
  cells: ReadonlyMap<string, Held>,
  sheetName: string,
  typed: ReadonlyMap<string, string>,
): Recalculation {
  const values = new Map<string, number>();
  const stale = new Set<string>();
  /** Every cell whose value is not what the file says any more. */
  const moved = new Set<string>(typed.keys());

  /** What a cell is worth now: what was typed, what was worked out, or what the file holds. */
  const valueAt: Lookup = (row, col) => {
    const at = key(row, col);
    const written = typed.get(at);
    if (written !== undefined) return parse(written);
    if (values.has(at)) return values.get(at)!;
    const cell = cells.get(at);
    if (!cell) return undefined;
    if (cell.kind !== 'number') return null;
    return parse(cell.text);
  };

  const formulas = [...cells].filter(([, cell]) => cell.formula !== undefined);
  const settled = new Set<string>();

  /* One round per link in the longest chain of totals, and no more. */
  for (let round = 0; round < 64; round++) {
    let changed = false;

    for (const [at, cell] of formulas) {
      if (settled.has(at) || typed.has(at)) continue;
      const formula = cell.formula!;

      /* Does anything that moved reach this formula at all? */
      let reaches: Dependency = 'no';
      for (const source of moved) {
        const [row, col] = source.split(',').map(Number) as [number, number];
        const answer = dependency(formula, sheetName, { row, col });
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
         where every function in it is one this understands. */
      const readsStale = referencesOf(formula).some((reference) => {
        if (reference.sheet !== null && reference.sheet.toLowerCase() !== sheetName.toLowerCase()) return false;
        for (const gone of stale) {
          const [row, col] = gone.split(',').map(Number) as [number, number];
          if (
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

      settled.add(at);
      changed = true;
      const worked = readsStale ? null : evaluate(formula, valueAt);
      if (worked === null) {
        stale.add(at);
        moved.add(at);
        continue;
      }
      /* A number that did not move is not news, and saying so would put a
         marker on a cell nobody changed. */
      const [row, col] = at.split(',').map(Number) as [number, number];
      const before = cells.get(key(row, col));
      values.set(at, worked);
      if (before === undefined || parse(before.text) !== worked) moved.add(at);
    }

    if (!changed) break;
  }

  return { values, stale };
}
