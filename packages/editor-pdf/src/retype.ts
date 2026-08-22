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
 * - **The pen is put back where it was.** A shorter or longer line would drag
 *   everything after it sideways, so the difference is made up with an offset in
 *   the `TJ` array, exactly as a redaction makes up for what it removed.
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
  /** The bounds the line had when it was picked. */
  rect: Rect;
  before: string;
  after: string;
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
 * Finds the operator that draws a given line again.
 *
 * Matched on both the place and the text. The place alone is not enough — two
 * cells of a table can share a rectangle to within a point — and the text alone
 * is not enough either, since a document may repeat a word on every page.
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
    if (textOf(operation) !== spec.before) continue;
    return { operation, content };
  }
  return null;
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

/** The advance of one code, in text space — the same arithmetic the reader does. */
function advanceOf(operation: TextOperation, code: number, twoByte: boolean): number {
  const width = operation.font.widthOf(code) / 1000;
  const isSpace = !twoByte && code === 32;
  return (
    (width * operation.fontSize +
      operation.charSpacing +
      (isSpace ? operation.wordSpacing : 0)) *
    operation.horizontalScale
  );
}

/** Everything the operator advances the pen by, offsets included. */
function totalAdvance(operation: TextOperation): number {
  let total = 0;
  for (const part of operation.parts) {
    if (part.kind === 'adjust') {
      total -= (part.value / 1000) * operation.fontSize * operation.horizontalScale;
      continue;
    }
    for (const glyph of part.glyphs) total += glyph.advance;
  }
  return total;
}

/** The replacement operator: the new codes, then whatever offset puts the pen back. */
function operatorFor(operation: TextOperation, codes: number[]): string {
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

  const after = codes.reduce(
    (sum, code) => sum + advanceOf(operation, code, operation.font.twoByte),
    0,
  );
  const correction = adjustmentFor(totalAdvance(operation) - after, operation);

  const pieces = [hexOf(bytes)];
  /* Below a thousandth of a text unit there is nothing to correct, and an offset
     of `0` in the array would only be noise for whoever reads the file. */
  if (Math.abs(round(correction)) > 0) pieces.push(String(round(correction)));

  const array = `[${pieces.join(' ')}] TJ`;

  switch (operation.operator) {
    case "'":
      return `T* ${array}`;
    case '"':
      return `${round(operation.wordSpacing)} Tw ${round(operation.charSpacing)} Tc T* ${array}`;
    default:
      return array;
  }
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

  const inventory = inventoryOf(content, operation.font);
  const missing = unwritable(operation.font, inventory, spec.after);
  if (missing.length > 0) return { kind: 'missing', chars: missing };

  const codes: number[] = [];
  for (const char of spec.after) {
    const code = codeFor(operation.font, inventory, char);
    // `unwritable` has already been past here; this is the type narrowing.
    if (code === null) return { kind: 'missing', chars: [char] };
    codes.push(code);
  }

  const bytes = splice(content.bytes, [
    { start: operation.start, end: operation.end, text: operatorFor(operation, codes) },
  ]);
  replaceContents(doc, page, bytes);

  return { kind: 'done', bytes: await doc.save({ useObjectStreams: false }) };
}
