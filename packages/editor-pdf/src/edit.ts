/**
 * Rewriting text that is already in the document.
 *
 * The edit is assembled from two things the project already has: the old line is
 * **removed from the content stream** (see [`redact.ts`](./redact.ts)) and the
 * new one is **written as text** (see [`text.ts`](./text.ts)). Nothing is
 * covered over and nothing is left underneath.
 *
 * It is written **with our embedded font**, not the original one. That is a
 * deliberate choice with a cost worth knowing:
 *
 * - For Helvetica and Arial there is no difference — Liberation Sans was built
 *   to match their widths, so a rewritten line sits exactly where the old one
 *   did.
 * - For everything else the size, colour and position stay the same, but the
 *   letterforms do not. This is said before typing starts, not after saving.
 *
 * Why not the original font: an embedded subset contains only the glyphs that
 * document already used. The moment a letter that is not there gets added — and
 * `č`, `ć`, `ž`, `š` and `đ` are almost never there in somebody else's
 * documents — it would come out as a blank in the middle of a sentence.
 */

import type { PDFPage } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import type { Rect, Rgb } from './annotations.js';
import { boundsOfOperation, readPageContent, textOf } from './content.js';
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
        metricsMatch: matchesOurMetrics(operation.font.baseFont),
      },
    };
  }

  return null;
}

/** The warning for when the letterforms will not match the original. */
export function metricsWarning(line: EditableLine): string | null {
  if (line.metricsMatch) return null;
  return t('{font} is not the font we write with — size and position stay, the letterforms change.', {
    font: line.baseFont || t('The original font'),
  });
}
