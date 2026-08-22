/**
 * Retyping a line **in the document's own font**.
 *
 * This is what makes an edit look like no edit happened. The old approach —
 * delete the line, write a new one with our embedded font — was correct in the
 * file and wrong on the page: everything except Helvetica and Arial came back in
 * different letterforms, so a corrected invoice announced itself as corrected.
 *
 * Here the operator that draws the line is rewritten with **the codes of the
 * font that was already there**. Nothing new is embedded, nothing is covered,
 * and the glyphs are the same ones the rest of the paragraph is made of.
 *
 * Two things make it work:
 *
 * - **`/ToUnicode` read backwards.** The map that says which letter a code
 *   stands for also says which code writes that letter — see `encode` in
 *   [`content.ts`](./content.ts).
 * - **Everything else is left alone.** The runs of glyphs that did not change
 *   keep their own bytes and their own `TJ` offsets, so nothing about them can
 *   shift by so much as a rounding error.
 *
 * Which characters can be written is decided by **what the page already draws**.
 * Every code the reader has drawn on that page has a glyph behind it, by
 * definition — so writing that code again with the same font draws the same
 * letter, and no map has to be trusted for it. The font's own `/ToUnicode`,
 * read backwards, adds whatever else it promises.
 *
 * That inventory is what makes real documents editable. An invoice from a
 * payment processor embeds a subset of its font and often ships no `/ToUnicode`
 * at all; going by the map alone not a single letter of it could be written, and
 * every correction fell back to being a box glued on top. Going by what is on
 * the page, the whole alphabet of that invoice is available.
 *
 * The limit is what remains honest: a `č` typed into a document that never drew
 * one has no glyph to come from. Then this refuses, names the characters, and
 * the caller falls back to the route where the letterforms change but the text
 * is right.
 *
 * **A visible line is rarely one operator.** `€93.89` in an invoice is often the
 * currency sign in one instruction and the figure in another; a sentence is
 * frequently a word per instruction, each placed at its own coordinates. Taking
 * one of them for the line was the fault behind the first attempt at this: a
 * click on the `9` offered `€ 9` for editing, and the rest of the number stayed
 * where it was. So the operators that share a baseline, a font, a size and a
 * colour, and sit close enough together to read as one line, are gathered into
 * one — and the edit is then matched against **the whole line**.
 *
 * Only what actually changed is written. The unchanged head and tail keep the
 * bytes they had — their kerning, their offsets, their exact places — and the
 * changed span is written where it stood.
 *
 * **The line reflows inside itself and nothing else moves at all.** What follows
 * the change on that line shifts by exactly what the change gained or lost, and
 * every instruction still advances the pen by exactly as much as it did before
 * — so the column beside it, the next line, anything placed by where the pen
 * stopped, stays where it was. Holding the rest of the line still instead would
 * write the new words straight over the old ones, which is what a screenshot of
 * a corrected invoice showed.
 *
 * What it does not do is reflow. A retyped line stays one line at one place; if
 * the new text is much longer it will run towards whatever comes next, the way
 * typing over a printed form does. Paragraph reflow is a different job, and
 * pretending to do it by moving neighbouring operators would move things the
 * user never looked at.
 */

import { PDFDocument } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import type { Rect } from './annotations.js';
import {
  boundsOfOperation,
  readPageContent,
  textOf,
  type FontInfo,
  type PageContent,
  type TextOperation,
} from './content.js';
import { adjustmentFor, hexOf, replaceContents, round, splice } from './stream.js';
import type { StandardWidths } from './text.js';

/** One line to put right: where it was, what it read, what it should read. */
export interface RetypeSpec {
  /** 1-based, in the document these bytes are. */
  page: number;
  /**
   * The bounds of the operator that was clicked — the anchor of the line.
   *
   * Not the whole line's rectangle: the anchor is one instruction, whose place
   * and text identify it again exactly, and the rest of the line is regathered
   * around it by the same rule as when it was picked.
   */
  rect: Rect;
  before: string;
  after: string;
}

/** One operator's share of a visible line. */
export interface Segment {
  operation: TextOperation;
  /** What that operator draws. */
  text: string;
  /** Where its text begins in the joined line. */
  at: number;
}

/** The operators that read as one line, and what they say together. */
export interface Line {
  segments: Segment[];
  /** The anchor: the operator the finger landed on. */
  anchor: TextOperation;
  /** The segments joined, with a space wherever the page leaves a visible gap. */
  text: string;
}

/** Character → the code that draws it, for the letters a page already carries. */
export type Inventory = Map<string, number>;

export type RetypeOutcome =
  /** Written. The bytes are a whole new document. */
  | { kind: 'done'; bytes: Uint8Array }
  /** The font cannot write these characters; the caller falls back. */
  | { kind: 'missing'; chars: string[] }
  /** Nothing was touched, and this is why. */
  | { kind: 'refused'; reason: string };

/** How far a remembered rectangle may sit from the one found, in points. */
const TOLERANCE = 0.75;

function near(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= TOLERANCE &&
    Math.abs(a.y - b.y) <= TOLERANCE &&
    Math.abs(a.width - b.width) <= TOLERANCE &&
    Math.abs(a.height - b.height) <= TOLERANCE
  );
}

/**
 * Finds the operator the finger landed on, again.
 *
 * By its rectangle alone. What it says is checked afterwards, against the whole
 * line gathered around it — which is the text the user was shown and therefore
 * the text the edit was made against. Checking this one operator's own words
 * here would ask the wrong question: it holds a fragment of the line, not the
 * line.
 */
function locate(
  page: PDFPage,
  spec: RetypeSpec,
  standard?: StandardWidths,
): { operation: TextOperation; content: PageContent } | null {
  const content = readPageContent(page, standard);
  for (const operation of content.operations) {
    const bounds = boundsOfOperation(operation);
    if (!bounds || !near(bounds, spec.rect)) continue;
    if (!editable(operation)) continue;
    return { operation, content };
  }
  return null;
}

/* ── gathering a visible line ────────────────────────────────────────── */

/** How far two baselines may differ and still be the same line, in ems. */
const BASELINE_SLACK = 0.15;
/**
 * The widest gap that still reads as one line, in ems.
 *
 * Wide enough for the space between two words placed separately, narrow enough
 * that the label and the figure in opposite columns of a table stay two things.
 * Between them lies no common typography, which is why one number can do.
 */
const JOIN_GAP = 1.2;
/** Beyond this, the page has left a space whether or not it drew one. */
const SPACE_GAP = 0.16;

/** Whether an operator can be part of a line at all — the same tests as the click. */
function editable(operation: TextOperation): boolean {
  return (
    operation.renderMode !== 3 &&
    operation.axisAligned &&
    operation.horizontalScale === 1 &&
    !!operation.fill &&
    textOf(operation) !== null
  );
}

function sameStyle(a: TextOperation, b: TextOperation): boolean {
  return (
    a.font === b.font &&
    Math.abs(a.effectiveSize - b.effectiveSize) < 0.01 &&
    !!a.fill &&
    !!b.fill &&
    a.fill.every((c, i) => Math.abs(c - b.fill![i]!) < 0.001)
  );
}

/**
 * Everything on the page that reads as one line with the operator clicked.
 *
 * A visible line is rarely one instruction. The rule is deliberately about what
 * a reader sees rather than about how the file is arranged: the same font, the
 * same size, the same colour, the same baseline, and no gap wider than a space
 * or two. Everything the file might do between those — a new `Td`, a new text
 * object, a different order in the stream — is invisible on the page and
 * therefore not a reason to treat two pieces as different lines.
 */
export function gatherLine(content: PageContent, anchor: TextOperation): Line {
  const em = anchor.effectiveSize || 1;

  const candidates = content.operations
    .filter(
      (operation) =>
        editable(operation) &&
        sameStyle(operation, anchor) &&
        Math.abs(operation.origin.y - anchor.origin.y) <= BASELINE_SLACK * em,
    )
    .map((operation) => ({ operation, bounds: boundsOfOperation(operation)! }))
    .filter((entry) => !!entry.bounds)
    .sort((a, b) => a.bounds.x - b.bounds.x);

  const start = candidates.findIndex((entry) => entry.operation === anchor);
  if (start < 0) return { segments: [{ operation: anchor, text: textOf(anchor) ?? '', at: 0 }], anchor, text: textOf(anchor) ?? '' };

  const gapBetween = (left: number, right: number) =>
    candidates[right]!.bounds.x - (candidates[left]!.bounds.x + candidates[left]!.bounds.width);

  let first = start;
  while (first > 0 && gapBetween(first - 1, first) <= JOIN_GAP * em) first--;
  let last = start;
  while (last < candidates.length - 1 && gapBetween(last, last + 1) <= JOIN_GAP * em) last++;

  const segments: Segment[] = [];
  let text = '';
  for (let i = first; i <= last; i++) {
    /* A space the page shows by leaving a gap rather than by drawing one. It is
       part of the line as read, so it is part of the line as edited. */
    if (i > first && gapBetween(i - 1, i) > SPACE_GAP * em && !text.endsWith(' ')) text += ' ';
    const own = textOf(candidates[i]!.operation) ?? '';
    segments.push({ operation: candidates[i]!.operation, text: own, at: text.length });
    text += own;
  }

  return { segments, anchor, text };
}

/**
 * The letters a page already draws with a given font, and the code each is drawn
 * with.
 *
 * A code that has been drawn has a glyph — there is nothing to verify and
 * nothing to guess. This is therefore the safest source of codes there is, and
 * on a real document by far the largest.
 */
export function inventoryOf(content: PageContent, font: FontInfo): Inventory {
  const out: Inventory = new Map();
  for (const operation of content.operations) {
    /* By identity: both come out of the same read of the same page, and two
       different resources can share a name across pages. */
    if (operation.font !== font) continue;
    for (const part of operation.parts) {
      if (part.kind !== 'glyphs') continue;
      for (const glyph of part.glyphs) {
        const text = font.decode(glyph.code);
        // A ligature decodes to several characters; one code per letter here.
        if (text === null || [...text].length !== 1) continue;
        if (!out.has(text)) out.set(text, glyph.code);
      }
    }
  }
  return out;
}

/** Character → code: the page's own glyphs first, then whatever the font promises. */
export function codeFor(
  font: Pick<FontInfo, 'encode'>,
  inventory: Inventory,
  char: string,
): number | null {
  return inventory.get(char) ?? font.encode(char);
}

/**
 * The part of a line that an edit actually touches.
 *
 * Only this has to be written, and therefore only this has to be writable. A
 * line that already contains a character we could not produce ourselves — a
 * ligature, a symbol drawn by one glyph we cannot take apart — can still be
 * edited everywhere else, because the rest of it keeps its own bytes.
 */
export function changedSpan(before: string, after: string): string {
  const head = commonHead(before, after);
  const tail = commonTail(before, after, head);
  return after.slice(head, after.length - tail);
}

/**
 * The characters that cannot be written into a line.
 *
 * Offered separately so the warning can appear **while typing**, when the text
 * can still be changed, rather than after the document has been saved.
 */
export function unwritable(
  font: Pick<FontInfo, 'encode'>,
  inventory: Inventory,
  text: string,
): string[] {
  const out: string[] = [];
  for (const char of text) {
    if (char === '\n' || char === '\r') continue;
    if (codeFor(font, inventory, char) === null && !out.includes(char)) out.push(char);
  }
  return out;
}

/**
 * What an operator is rebuilt out of.
 *
 * `bytes` are the original glyph bytes of a run that did not change — kept as
 * they are rather than encoded afresh, so its kerning and its exact spacing
 * survive untouched. `adjust` is one of the original `TJ` offsets, for the same
 * reason. `codes` is the only thing that is new.
 */
type Piece =
  | { kind: 'bytes'; bytes: Uint8Array }
  /** One of the operator's own `TJ` numbers, kept as it was written. */
  | { kind: 'adjust'; value: number }
  /** A distance in the operator's text space, to be written as a `TJ` number. */
  | { kind: 'advance'; by: number }
  | { kind: 'codes'; codes: number[] };

function bytesOf(operation: TextOperation, codes: number[]): Uint8Array {
  const step = operation.font.twoByte ? 2 : 1;
  const bytes = new Uint8Array(codes.length * step);
  codes.forEach((code, i) => {
    if (step === 2) {
      bytes[i * 2] = (code >> 8) & 0xff;
      bytes[i * 2 + 1] = code & 0xff;
    } else {
      bytes[i] = code & 0xff;
    }
  });
  return bytes;
}

/**
 * The replacement operator, out of the pieces it is made of.
 *
 * Neighbouring runs of bytes are merged into one string, so what comes out reads
 * like something a writer would have produced rather than like a patch.
 */
function operatorFor(operation: TextOperation, pieces: Piece[]): string {
  const parts: string[] = [];
  let run: Uint8Array[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const total = run.reduce((sum, piece) => sum + piece.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const piece of run) {
      merged.set(piece, at);
      at += piece.length;
    }
    parts.push(hexOf(merged));
    run = [];
  };

  for (const piece of pieces) {
    if (piece.kind === 'adjust') {
      flush();
      // An offset of `0` would only be noise for whoever reads the file.
      if (Math.abs(round(piece.value)) > 0) parts.push(String(round(piece.value)));
      continue;
    }
    if (piece.kind === 'advance') {
      flush();
      const offset = round(adjustmentFor(piece.by, operation));
      if (Math.abs(offset) > 0) parts.push(String(offset));
      continue;
    }
    const bytes = piece.kind === 'bytes' ? piece.bytes : bytesOf(operation, piece.codes);
    if (bytes.length > 0) run.push(bytes);
  }
  flush();

  const array = `[${parts.join(' ')}] TJ`;

  switch (operation.operator) {
    case "'":
      return `T* ${array}`;
    case '"':
      return `${round(operation.wordSpacing)} Tw ${round(operation.charSpacing)} Tc T* ${array}`;
    default:
      return array;
  }
}

/* ── writing only what changed ───────────────────────────────────────── */

/** How many characters at the start the two versions still share. */
function commonHead(before: string, after: string): number {
  const limit = Math.min(before.length, after.length);
  let i = 0;
  while (i < limit && before[i] === after[i]) i++;
  return i;
}

/** How many at the end, without overlapping the head. */
function commonTail(before: string, after: string, head: number): number {
  const limit = Math.min(before.length, after.length) - head;
  let i = 0;
  while (i < limit && before[before.length - 1 - i] === after[after.length - 1 - i]) i++;
  return i;
}

/**
 * The tokens of an operator, with where each one starts in its text.
 *
 * The unit is what the file already holds: a glyph with its own bytes, or one of
 * the `TJ` offsets between them. Cutting the change out of this list rather than
 * out of the text means every piece that did not change keeps the bytes it had,
 * and with them its kerning and its exact place.
 *
 * An offset before the first glyph belongs to no character; it is part of where
 * the operator starts drawing and is handed back separately so it survives
 * whatever happens to the text.
 */
function tokensOf(operation: TextOperation): { lead: Piece[]; items: { at: number; piece: Piece }[] } {
  const lead: Piece[] = [];
  const items: { at: number; piece: Piece }[] = [];
  let at = 0;
  let started = false;

  for (const part of operation.parts) {
    if (part.kind === 'adjust') {
      if (started) items.push({ at, piece: { kind: 'adjust', value: part.value } });
      else lead.push({ kind: 'adjust', value: part.value });
      continue;
    }
    for (const glyph of part.glyphs) {
      started = true;
      items.push({ at, piece: { kind: 'bytes', bytes: glyph.bytes } });
      at += (operation.font.decode(glyph.code) ?? '').length;
    }
  }

  return { lead, items };
}

/** The advance of one code, in the operator's text space. */
function advanceOf(operation: TextOperation, code: number): number {
  const width = operation.font.widthOf(code) / 1000;
  const isSpace = !operation.font.twoByte && code === 32;
  return (
    (width * operation.fontSize +
      operation.charSpacing +
      (isSpace ? operation.wordSpacing : 0)) *
    operation.horizontalScale
  );
}

/** What each character of an operator advances the pen by, in its text space. */
function advancesOf(operation: TextOperation): number[] {
  const perChar: number[] = [];

  for (const part of operation.parts) {
    if (part.kind === 'adjust') {
      const by = -(part.value / 1000) * operation.fontSize * operation.horizontalScale;
      if (perChar.length > 0) perChar[perChar.length - 1] = (perChar[perChar.length - 1] ?? 0) + by;
      continue;
    }
    for (const glyph of part.glyphs) {
      const text = operation.font.decode(glyph.code) ?? '';
      perChar.push(glyph.advance);
      // A ligature is one advance spread over several characters of text.
      for (let i = 1; i < text.length; i++) perChar.push(0);
    }
  }

  return perChar;
}

/**
 * Points on the page per unit of an operator's text space.
 *
 * `Tf` gives a size, and the matrices on top of it give another; `effectiveSize`
 * is what the two come to together. Advances are counted in the first and
 * rectangles in the second, so anything measured off the page has to come back
 * through here before it can be written into a `TJ` array.
 */
function scaleOf(operation: TextOperation): number {
  if (!operation.fontSize) return 1;
  return operation.effectiveSize / operation.fontSize;
}

/**
 * The edits that turn a line into what it should say.
 *
 * Two rules, and everything follows from them:
 *
 * - **A run that did not change keeps its own bytes.** Its kerning, its offsets
 *   and its exact place survive the edit untouched.
 * - **The line reflows inside itself; nothing else moves at all.** What follows
 *   the change on that line shifts by exactly as much as the change gained or
 *   lost, and every operator still advances the pen by exactly as much as it did
 *   — so a column beside it, another line, anything positioned by where the pen
 *   stopped, stays where it was.
 *
 * The alternative to reflowing — holding the rest of the line in place — writes
 * the new text straight over it, which is what a screenshot of a corrected
 * invoice showed: two words on top of one another.
 */
function editsFor(
  line: Line,
  after: string,
  codeOf: (char: string) => number | null,
): { edits: { start: number; end: number; text: string }[] } | { missing: string[] } {
  const before = line.text;
  const head = commonHead(before, after);
  const tail = commonTail(before, after, head);

  const from = head;
  const to = before.length - tail;
  const written = after.slice(head, after.length - tail);

  const missing: string[] = [];
  const codes: number[] = [];
  for (const char of written) {
    const code = codeOf(char);
    if (code === null) {
      if (!missing.includes(char)) missing.push(char);
      continue;
    }
    codes.push(code);
  }
  if (missing.length > 0) return { missing };

  /*
   * Which operators the change reaches. An insertion touches nothing at all, and
   * then it belongs to the operator it was typed inside — the one whose text
   * spans that position, or the last one before it.
   */
  const touched = line.segments.filter(
    (segment) => segment.at < to && segment.at + segment.text.length > from,
  );
  const affected = touched.length > 0 ? touched : [lastBefore(line, from)];
  const first = affected[0]!;
  const firstAt = line.segments.indexOf(first);

  /** What the change is worth on the page: what it gained, less what it cost. */
  const gained =
    codes.reduce((sum, code) => sum + advanceOf(first.operation, code), 0) * scaleOf(first.operation);

  let lost = 0;
  affected.forEach((segment, index) => {
    const perChar = advancesOf(segment.operation);
    const localFrom = Math.max(0, from - segment.at);
    const localTo = Math.max(localFrom, Math.min(segment.text.length, to - segment.at));
    for (let i = localFrom; i < localTo; i++) lost += (perChar[i] ?? 0) * scaleOf(segment.operation);

    /* The empty room between two operators the change ran across is part of what
       it replaced, and it is only measurable on the page. */
    if (index > 0) {
      const left = boundsOfOperation(affected[index - 1]!.operation);
      const right = boundsOfOperation(segment.operation);
      if (left && right) lost += Math.max(0, right.x - (left.x + left.width));
    }
  });

  const delta = gained - lost;

  const edits: { start: number; end: number; text: string }[] = [];

  line.segments.forEach((segment, index) => {
    if (index < firstAt) return;

    const scale = scaleOf(segment.operation);
    const shift = delta / scale;
    const { lead, items } = tokensOf(segment.operation);
    const perChar = advancesOf(segment.operation);

    /* A segment the change never reached loses nothing and keeps everything —
       so all of it counts as tail, which is what the shift is applied to. */
    const isAffected = affected.includes(segment);
    const localFrom = isAffected ? Math.max(0, from - segment.at) : 0;
    const localTo = isAffected
      ? Math.max(localFrom, Math.min(segment.text.length, to - segment.at))
      : 0;

    let removed = 0;
    for (let i = localFrom; i < localTo; i++) removed += perChar[i] ?? 0;
    const writes = segment === first ? codes : [];
    const writesBy = writes.reduce((sum, code) => sum + advanceOf(segment.operation, code), 0);

    const keptTail = items.filter((item) => item.at >= localTo);
    const keptHead = items.filter((item) => item.at < localFrom);

    const pieces: Piece[] = [...lead];
    for (const item of keptHead) pieces.push(item.piece);
    if (writes.length > 0) pieces.push({ kind: 'codes', codes: writes });

    /*
     * Where the rest of this operator goes: exactly where it was, plus what the
     * change was worth. For a segment the change never reached, that is the
     * whole of it — which is how the line reflows without anything beside it
     * moving.
     */
    const hasTail = keptTail.length > 0;
    if (hasTail) pieces.push({ kind: 'advance', by: removed + shift - writesBy });
    for (const item of keptTail) pieces.push(item.piece);

    /* And the pen ends where it always did, so nothing positioned by it moves —
       whether that means undoing the shift the tail was given, or making up for
       a span that went with nothing left behind it. */
    pieces.push({ kind: 'advance', by: hasTail ? -shift : removed - writesBy });

    edits.push({
      start: segment.operation.start,
      end: segment.operation.end,
      text: operatorFor(segment.operation, pieces),
    });
  });

  return { edits };
}

/** The segment a bare insertion belongs to: the one it was typed at the end of. */
function lastBefore(line: Line, at: number): Segment {
  let best = line.segments[0]!;
  for (const segment of line.segments) {
    if (segment.at <= at) best = segment;
  }
  return best;
}

/**
 * Rewrites one line and returns the whole document back.
 *
 * The bytes handed in are the ones on screen, so the result can be shown
 * straight away: what the reader draws after this **is** what the file holds,
 * with no approximation in between.
 */
export async function applyRetype(
  source: Uint8Array,
  spec: RetypeSpec,
  standard?: StandardWidths,
): Promise<RetypeOutcome> {
  if (spec.after === spec.before) return { kind: 'done', bytes: source };

  if (/[\r\n]/.test(spec.after)) {
    /* One operator is one line at one place. Splitting it would need somewhere
       for the second line to go, and everything below it moved down. */
    return { kind: 'refused', reason: t('A line rewritten in place stays one line.') };
  }

  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  const page = doc.getPages()[spec.page - 1];
  if (!page) return { kind: 'refused', reason: t('That page is no longer there.') };

  const found = locate(page, spec, standard);
  if (!found) {
    return { kind: 'refused', reason: t('That line is no longer where it was.') };
  }
  const { operation, content } = found;
  if (operation.font.unsupported) {
    return {
      kind: 'refused',
      reason: t('The font of that line cannot be measured ({reason}).', {
        reason: operation.font.unsupported,
      }),
    };
  }

  /* Gathered again rather than carried across: the line is what the page shows,
     and if the page has changed since it was picked, so has the line. */
  const line = gatherLine(content, operation);
  if (line.text !== spec.before) {
    return { kind: 'refused', reason: t('That line no longer reads the way it did.') };
  }

  const inventory = inventoryOf(content, operation.font);
  const result = editsFor(line, spec.after, (char) => codeFor(operation.font, inventory, char));
  if ('missing' in result) return { kind: 'missing', chars: result.missing };

  replaceContents(doc, page, splice(content.bytes, result.edits));
  return { kind: 'done', bytes: await doc.save({ useObjectStreams: false }) };
}
