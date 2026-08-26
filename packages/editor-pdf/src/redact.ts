/**
 * Deleting text from a document — genuinely, not by covering it up.
 *
 * A black rectangle over text is not deletion: the text stays in the content
 * stream and comes back out through selection, copying, or any tool that reads
 * PDF. That is the mistake that has repeatedly published other people's secrets,
 * and the reason this code exists.
 *
 * Here the glyphs are **removed from the operators that draw them**, and the
 * space they occupied is made up with an offset in the `TJ` array — so the rest
 * of the line stays exactly where it was.
 *
 * When it cannot be guaranteed that everything was removed, nothing is changed
 * and the reason is reported. A redaction that quietly misses part of the text
 * is worse than none at all: the user believes the job is done and sends the
 * document on.
 */

import { PDFDocument } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import type { Rect } from './annotations.js';
import {
  pageContentOrNothing,
  type Glyph,
  type Obstacle,
  type TextOperation,
} from './content.js';
import { adjustmentFor, hexOf, replaceContents, round, splice } from './stream.js';
import type { StandardWidths } from './text.js';

export interface Redaction {
  id: string;
  /** The page in the SOURCE document, 1-based. */
  page: number;
  /** The area in the page's user space. */
  rect: Rect;
  /**
   * Already carried out in the saved file.
   *
   * The mark stays in the list because every save is built from the **untouched**
   * source: the redaction is therefore repeated with the same outcome, and
   * removing the mark brings the text back. That is what makes undo genuinely
   * possible even after a save.
   */
  applied?: boolean;
  /**
   * New text is coming to this spot.
   *
   * The on-screen mark is therefore opaque, so the old and new lines are not seen
   * through one another before saving. For a plain deletion nothing is covered
   * **on purpose** — there it matters to see what is going away.
   */
  replaced?: boolean;
}

export interface RedactionResult {
  bytes: Uint8Array;
  /** How many glyphs were actually removed. */
  removed: number;
  /** The pages that could not be cleaned, with the reason. */
  refused: { page: number; reason: string }[];
}

/** Whether the rectangles overlap by area rather than merely at an edge. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Whether a glyph falls inside the area — by its centre, not by contact.
 *
 * Glyphs in a line touch at their edges, so an "any contact" rule would let a
 * hand-drawn rectangle swallow the neighbouring letter too: being half a point
 * off while dragging is normal, a quietly lost letter is not.
 *
 * Safety does not suffer for it. A glyph whose centre lies outside the rectangle
 * is mostly outside it, so the user can see it stayed — nothing is hidden under
 * anything, because no rectangle is drawn over what was removed.
 */
function covers(rect: Rect, box: Rect): boolean {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * Rewrites one operator without the removed glyphs.
 *
 * The output is always `TJ`, whatever the input was: `TJ` is the only form that
 * carries offsets alongside strings, and the offset is what holds the rest of the
 * line in place. The `'` and `"` operators also carry a move to the next line, so
 * that is emitted separately.
 */
function rewrite(operation: TextOperation, doomed: Set<Glyph>): string {
  const pieces: string[] = [];
  let pendingAdjust = 0;
  let run: Uint8Array[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const total = run.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const part of run) {
      merged.set(part, at);
      at += part.length;
    }
    pieces.push(hexOf(merged));
    run = [];
  };

  const flushAdjust = () => {
    if (pendingAdjust === 0) return;
    flushRun();
    pieces.push(String(round(pendingAdjust)));
    pendingAdjust = 0;
  };

  for (const part of operation.parts) {
    if (part.kind === 'adjust') {
      flushRun();
      pendingAdjust += part.value;
      continue;
    }

    for (const glyph of part.glyphs) {
      if (doomed.has(glyph)) {
        pendingAdjust += adjustmentFor(glyph.advance, operation);
        continue;
      }
      flushAdjust();
      run.push(glyph.bytes);
    }
  }

  flushAdjust();
  flushRun();

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

/** Obstacles touching the area being redacted — the rest are none of this job's business. */
function blockingObstacles(obstacles: Obstacle[], rects: Rect[]): Obstacle[] {
  return obstacles.filter(
    (obstacle) => !obstacle.box || rects.some((rect) => overlaps(rect, obstacle.box!)),
  );
}

/**
 * What a redaction would remove — without changing the document.
 *
 * It exists so the user can be shown exactly what disappears **before** they
 * confirm, because deleted text does not come back out of the file.
 */
export function previewRedaction(
  page: PDFPage,
  rects: Rect[],
  standard?: StandardWidths,
): { glyphs: number; obstacles: Obstacle[] } {
  /* A page nothing can decode is an obstacle like any other: the person is
     told before they confirm, rather than after the save has failed. */
  const content = pageContentOrNothing(page, standard);
  if (!content) return { glyphs: 0, obstacles: [{ reason: t('this page cannot be read') }] };

  let glyphs = 0;

  for (const operation of content.operations) {
    for (const part of operation.parts) {
      if (part.kind !== 'glyphs') continue;
      for (const glyph of part.glyphs) {
        if (rects.some((rect) => covers(rect, glyph.box))) glyphs++;
      }
    }
  }

  return { glyphs, obstacles: blockingObstacles(content.obstacles, rects) };
}

/**
 * Removes the text from the marked areas and returns new document bytes.
 *
 * It works over the SOURCE pages, before the plan reorders or deletes any — the
 * areas were recorded against what the user saw.
 */
export async function applyRedactions(
  source: Uint8Array,
  redactions: Redaction[],
  standard?: StandardWidths,
): Promise<RedactionResult> {
  if (redactions.length === 0) {
    return { bytes: source, removed: 0, refused: [] };
  }

  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  const pages = doc.getPages();

  const byPage = new Map<number, Rect[]>();
  for (const redaction of redactions) {
    const list = byPage.get(redaction.page) ?? [];
    list.push(redaction.rect);
    byPage.set(redaction.page, list);
  }

  const refused: { page: number; reason: string }[] = [];
  let removed = 0;
  let changed = false;

  for (const [pageNumber, rects] of byPage) {
    const page = pages[pageNumber - 1];
    if (!page) continue;

    const content = pageContentOrNothing(page, standard);
    if (!content) {
      refused.push({ page: pageNumber, reason: t('this page cannot be read') });
      continue;
    }

    const blocking = blockingObstacles(content.obstacles, rects);
    if (blocking.length > 0) {
      // Nothing is touched: a partially redacted page looks like a finished job.
      refused.push({ page: pageNumber, reason: blocking.map((o) => o.reason).join('; ') });
      continue;
    }

    const edits: { start: number; end: number; text: string }[] = [];

    for (const operation of content.operations) {
      const doomed = new Set<Glyph>();
      for (const part of operation.parts) {
        if (part.kind !== 'glyphs') continue;
        for (const glyph of part.glyphs) {
          if (rects.some((rect) => covers(rect, glyph.box))) doomed.add(glyph);
        }
      }
      if (doomed.size === 0) continue;

      removed += doomed.size;
      edits.push({ start: operation.start, end: operation.end, text: rewrite(operation, doomed) });
    }

    if (edits.length === 0) continue;

    replaceContents(doc, page, splice(content.bytes, edits));
    changed = true;
  }

  if (!changed) {
    return { bytes: source, removed, refused };
  }

  return { bytes: await doc.save({ useObjectStreams: false }), removed, refused };
}

/** The message about pages that could not be cleaned. */
export function refusalWarning(refused: RedactionResult['refused']): string[] {
  return refused.map(({ page, reason }) =>
    t('Page {n} was left untouched — the text there cannot be removed safely ({reason}).', {
      n: page,
      reason,
    }),
  );
}
