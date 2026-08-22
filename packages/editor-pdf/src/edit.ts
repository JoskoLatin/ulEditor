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
import type { StandardWidths } from './text.js';

/** A line of the document offered for rewriting. */
export interface EditableLine {
  text: string;
  /** The area it occupies; the redaction mark is derived from it. */
  bounds: Rect;
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
 * The unit is one operator from the content stream, because that is the only
 * piece whose start and end are reliably known. A visual line is often broken
 * across several operators; in that case only the part under the finger is
 * rewritten, and the user is shown exactly which.
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

    const text = textOf(operation);
    if (text === null) {
      return {
        refusal: t('That text cannot be read back as letters — the font has no /ToUnicode map.'),
      };
    }

    const glyphs = operation.parts.reduce(
      (sum, part) => sum + (part.kind === 'glyphs' ? part.glyphs.length : 0),
      0,
    );

    return {
      line: {
        text,
        bounds,
        origin: operation.origin,
        size: operation.effectiveSize,
        color: operation.fill,
        baseFont: operation.font.baseFont,
        glyphs,
        font: operation.font,
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
export function fallbackWarning(line: EditableLine, chars: string[]): string {
  if (line.metricsMatch) {
    // Liberation Sans matches Helvetica and Arial width for width, so the line
    // will not move; only the missing characters are worth mentioning.
    return t('The font of this document has no {chars}, so the line is written with ours instead.', {
      chars: chars.join(' '),
    });
  }
  return t(
    'The font of this document has no {chars}. The line will be written in {font} instead — same size and place, different letterforms.',
    { chars: chars.join(' '), font: 'Liberation Sans' },
  );
}
