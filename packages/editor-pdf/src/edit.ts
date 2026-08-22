/**
 * Finding the line under the finger, so it can be rewritten.
 *
 * How it is then written is decided elsewhere, and there are two routes:
 *
 * - **In place, in the document's own font** — [`retype.ts`](./retype.ts).
 *   The operator that draws the line is rewritten with the codes of the font
 *   that was already there, so nothing about the page changes except the words.
 *   This is the normal route.
 * - **Removed and typed again in ours** — [`redact.ts`](./redact.ts) plus
 *   [`text.ts`](./text.ts), for when the first route cannot write a character.
 *   An embedded font is usually a subset holding only the glyphs the document
 *   already used, and `č`, `ć`, `ž`, `š` and `đ` are almost never among them in
 *   somebody else's document. Then the size, the colour and the position stay
 *   and the letterforms do not — which is said while typing, not after saving.
 */

import type { PDFPage } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import type { Rect, Rgb } from './annotations.js';
import { boundsOfOperation, readPageContent, textOf, type FontInfo } from './content.js';
import {
  gatherLine,
  inventoryOf,
  spaceAdvanceOf,
  writerFor,
  type LigatureSpan,
  type Writer,
} from './retype.js';
import type { StandardWidths } from './text.js';

/** A line of the document offered for rewriting. */
export interface EditableLine {
  text: string;
  /** The area the whole line occupies; the cover and the redaction mark follow it. */
  bounds: Rect;
  /**
   * The area of the one operator the finger landed on.
   *
   * A visible line is often several instructions, and the line is regathered
   * around this one when the edit is written — so this, not the line's own
   * rectangle, is what identifies it again.
   */
  anchor: Rect;
  /** The start of the baseline — the replacement is aligned to it. */
  origin: { x: number; y: number };
  size: number;
  color: Rgb;
  baseFont: string;
  /** How many glyphs are going; shown before confirmation. */
  glyphs: number;
  /**
   * The font the line is drawn with.
   *
   * Carried along because it is what decides the route: it knows which
   * characters it can write, and therefore whether the line can be retyped in
   * place or has to be replaced with ours.
   */
  font: FontInfo;
  /**
   * What this line can be written with.
   *
   * The letters that page already draws with that font, and what a space is
   * worth where it draws none. Carried along because it is what decides the
   * route, and it has to be known while the user types rather than after they
   * have finished — see [`retype.ts`](./retype.ts) for why the page is a better
   * authority on this than the font's own map.
   */
  writer: Writer;
  /**
   * Which of its letters share a glyph, as `{at, chars}`.
   *
   * Carried for the same reason as the writer: a change that reaches into a
   * ligature has to take the whole of it, and whether the whole of it can be
   * written back has to be known while the user is typing.
   */
  ligatures: LigatureSpan[];
  /**
   * Whether our font's metrics match the original's.
   *
   * When they do not, the replacement is the same size and in the same place but
   * with different letterforms — so that is said in advance.
   */
  metricsMatch: boolean;
}

/** Fonts Liberation Sans matches in width, character for character. */
function matchesOurMetrics(baseFont: string): boolean {
  const lower = baseFont.toLowerCase();
  return lower.startsWith('helvetica') || lower.startsWith('arial') || lower.startsWith('liberationsans');
}

/**
 * Finds the line under a given point.
 *
 * What comes back is **the line as it is read**, not the one instruction the
 * finger happened to land on. `€93.89` on an invoice is often the currency sign
 * in one instruction and the figure in another, and offering `€ 9` for editing
 * — which is what taking the single operator did — is not offering the line at
 * all. The gathering rule lives in [`retype.ts`](./retype.ts), so what is shown
 * and what is written are decided by the same code.
 */
export function findEditableLine(
  page: PDFPage,
  point: { x: number; y: number },
  standard?: StandardWidths,
): { line: EditableLine } | { refusal: string } | null {
  const content = readPageContent(page, standard);

  for (const operation of content.operations) {
    const bounds = boundsOfOperation(operation);
    if (!bounds) continue;
    if (
      point.x < bounds.x ||
      point.x > bounds.x + bounds.width ||
      point.y < bounds.y ||
      point.y > bounds.y + bounds.height
    ) {
      continue;
    }

    if (operation.renderMode === 3) {
      // Invisible text is a recognition layer; the image beneath changes, not it.
      return { refusal: t('That text is invisible — it is a recognition layer, not the page.') };
    }
    if (!operation.axisAligned) {
      return { refusal: t('That text is rotated or skewed, so it cannot be retyped in place.') };
    }
    if (operation.horizontalScale !== 1) {
      return { refusal: t('That text is horizontally stretched, so a replacement would not match.') };
    }
    if (!operation.fill) {
      return { refusal: t('The colour of that text comes from a colour space we do not read.') };
    }

    if (textOf(operation) === null) {
      return {
        refusal: t('That text cannot be read back as letters — the font has no /ToUnicode map.'),
      };
    }

    const line = gatherLine(content, operation);
    const glyphs = line.segments.reduce(
      (sum, segment) =>
        sum +
        segment.operation.parts.reduce(
          (count, part) => count + (part.kind === 'glyphs' ? part.glyphs.length : 0),
          0,
        ),
      0,
    );

    const boxes = line.segments
      .map((segment) => boundsOfOperation(segment.operation))
      .filter((box): box is Rect => !!box);
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.max(...boxes.map((box) => box.y + box.height));
    const bottom = Math.min(...boxes.map((box) => box.y));
    const whole: Rect = {
      x: left,
      y: bottom,
      width: Math.max(...boxes.map((box) => box.x + box.width)) - left,
      height: top - bottom,
    };

    return {
      line: {
        text: line.text,
        bounds: whole,
        anchor: bounds,
        // The first segment: where the line starts, whichever part was clicked.
        origin: line.segments[0]?.operation.origin ?? operation.origin,
        size: operation.effectiveSize,
        color: operation.fill,
        baseFont: operation.font.baseFont,
        glyphs,
        font: operation.font,
        writer: writerFor(
          operation.font,
          inventoryOf(content, operation.font),
          line.spaceAdvance ?? spaceAdvanceOf(content, operation.font),
        ),
        ligatures: line.ligatures,
        metricsMatch: matchesOurMetrics(operation.font.baseFont),
      },
    };
  }

  return null;
}

/**
 * The warning for the fallback route, once it is known to be needed.
 *
 * It names the characters that forced it. "The font is different" is not
 * actionable; "there is no ć in this document's font" is — the person can decide
 * to write the word another way, or to accept the change.
 */
/**
 * A space has to be said in words; printed as itself it looks like a gap where
 * a letter should be. Without an article, so it reads in the sentence it goes
 * into: "the font of this document has no space".
 */
function nameOf(char: string): string {
  return char === ' ' ? t('space') : char;
}

export function fallbackWarning(line: EditableLine, chars: string[]): string {
  if (line.metricsMatch) {
    // Liberation Sans matches Helvetica and Arial width for width, so the line
    // will not move; only the missing characters are worth mentioning.
    return t('The font of this document has no {chars}, so the line is written with ours instead.', {
      chars: chars.map(nameOf).join(' '),
    });
  }
  return t(
    'The font of this document has no {chars}. The line will be written in {font} instead — same size and place, different letterforms.',
    { chars: chars.map(nameOf).join(' '), font: 'Liberation Sans' },
  );
}
