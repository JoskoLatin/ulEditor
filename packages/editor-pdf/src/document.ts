/**
 * The page plan and writing the modified document.
 *
 * Page operations change nothing until a save — until then there is only a
 * *plan*: which source page goes where, and with what rotation. That is what
 * makes undo trivial, and what lets annotations stay with their source page no
 * matter how many times the pages are shuffled.
 */

import { PDFDocument, degrees } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import { missingGlyphWarning, writeAnnotations, type Annotation } from './annotations.js';
import { applyRedactions, refusalWarning, type Redaction } from './redact.js';
import { standardWidths, type FontLoader } from './text.js';

export interface PagePlan {
  /** The page number in the SOURCE document, 1-based. */
  source: number;
  /** Rotation on top of what the page already has: 0, 90, 180 or 270. */
  rotate: number;
}

export function identityPlan(pageCount: number): PagePlan[] {
  return Array.from({ length: pageCount }, (_, i) => ({ source: i + 1, rotate: 0 }));
}

/** Whether the plan is untouched — same order, every page, no rotations. */
export function isIdentity(plan: PagePlan[], pageCount: number): boolean {
  if (plan.length !== pageCount) return false;
  return plan.every((entry, index) => entry.source === index + 1 && entry.rotate === 0);
}

export function rotatePage(plan: PagePlan[], index: number, delta: number): PagePlan[] {
  return plan.map((entry, i) =>
    i === index ? { ...entry, rotate: (((entry.rotate + delta) % 360) + 360) % 360 } : entry,
  );
}

export function removePage(plan: PagePlan[], index: number): PagePlan[] {
  // A document with no pages at all is not a valid PDF.
  if (plan.length <= 1) return plan;
  return plan.filter((_, i) => i !== index);
}

export function movePage(plan: PagePlan[], index: number, delta: number): PagePlan[] {
  const target = index + delta;
  if (target < 0 || target >= plan.length) return plan;
  const next = [...plan];
  const [entry] = next.splice(index, 1);
  if (entry) next.splice(target, 0, entry);
  return next;
}

/** Source page (1-based) → position in the output (0-based). */
export function pageMapOf(plan: PagePlan[]): Map<number, number> {
  const map = new Map<number, number>();
  plan.forEach((entry, index) => {
    // If the same page appears more than once, annotations go to the first occurrence.
    if (!map.has(entry.source)) map.set(entry.source, index);
  });
  return map;
}

/** How many pages were deleted, rotated and moved — for describing the changes. */
export function describePlan(plan: PagePlan[], pageCount: number): string[] {
  const changes: string[] = [];

  const removed = pageCount - plan.length;
  if (removed > 0) changes.push(t('{n} pages deleted', { n: removed }));

  const rotated = plan.filter((e) => e.rotate !== 0).length;
  if (rotated > 0) changes.push(t('{n} rotated', { n: rotated }));

  const reordered = plan.some((entry, index) => entry.source !== index + 1);
  if (reordered && removed === 0) changes.push(t('order changed'));

  return changes;
}

/** Whether the page order changed (rather than merely being cut short at the end). */
function isReordered(plan: PagePlan[]): boolean {
  for (let i = 1; i < plan.length; i++) {
    if (plan[i]!.source < plan[i - 1]!.source) return true;
  }
  return false;
}

export interface SaveDocumentResult {
  bytes: Uint8Array;
  /** Features of the source document this write could not preserve. */
  lost: string[];
}

/**
 * Writes the document according to the plan, with its annotations.
 *
 * Two paths, on purpose:
 *
 * - **Rotation and deletion** are performed on the source document. Everything
 *   that is none of our business — outlines, forms, metadata, attachments —
 *   stays untouched.
 * - **Reordering** requires copying pages into a new document, because a PDF
 *   page tree can be nested and rewriting it by hand is not safe. The cost is
 *   losing what lives outside the pages themselves, so that is reported to the
 *   caller rather than lost quietly.
 */
export async function saveDocument(
  source: Uint8Array,
  plan: PagePlan[],
  annotations: Annotation[],
  pageCount: number,
  /** The font bytes for the text boxes. */
  loadFont?: FontLoader,
  /** The areas whose text is removed from the document itself. */
  redactions: Redaction[] = [],
): Promise<SaveDocumentResult> {
  const lost: string[] = [];

  /*
   * Redaction goes first, over the source pages: the areas were recorded against
   * what the user saw, before the plan reorders or deletes them.
   */
  const cleaned = await applyRedactions(
    source,
    redactions,
    // The metrics of the standard fonts come from the same font we write with.
    loadFont && redactions.length > 0 ? await standardWidths(loadFont) : undefined,
  );
  lost.push(...refusalWarning(cleaned.refused));
  source = cleaned.bytes;

  if (isIdentity(plan, pageCount)) {
    const { bytes, missingGlyphs } = await writeAnnotations(
      source,
      annotations,
      undefined,
      loadFont,
    );
    return { bytes, lost: [...lost, ...missingGlyphWarning(missingGlyphs)] };
  }

  let working: Uint8Array;

  if (isReordered(plan)) {
    const original = await PDFDocument.load(source, { ignoreEncryption: true });
    const rebuilt = await PDFDocument.create();

    const copied = await rebuilt.copyPages(
      original,
      plan.map((entry) => entry.source - 1),
    );
    copied.forEach((page, index) => {
      const entry = plan[index]!;
      if (entry.rotate !== 0) {
        page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
      }
      rebuilt.addPage(page);
    });

    // Metadata is carried over by hand; the rest outside the pages is lost.
    rebuilt.setTitle(original.getTitle() ?? '');
    rebuilt.setAuthor(original.getAuthor() ?? '');
    rebuilt.setSubject(original.getSubject() ?? '');

    lost.push(t('Reordering pages does not preserve bookmarks, forms or attachments.'));
    working = await rebuilt.save({ useObjectStreams: false });
  } else {
    // Rotations and deletions only — done on the original, without loss.
    const doc = await PDFDocument.load(source, { ignoreEncryption: true });
    const keep = new Set(plan.map((entry) => entry.source));

    for (const entry of plan) {
      if (entry.rotate === 0) continue;
      const page = doc.getPage(entry.source - 1);
      page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
    }

    // Deletion runs backwards so the indices do not shift underfoot.
    for (let i = pageCount; i >= 1; i--) {
      if (!keep.has(i)) doc.removePage(i - 1);
    }

    working = await doc.save({ useObjectStreams: false });
  }

  const { bytes, missingGlyphs } = await writeAnnotations(
    working,
    annotations,
    pageMapOf(plan),
    loadFont,
  );
  return { bytes, lost: [...lost, ...missingGlyphWarning(missingGlyphs)] };
}

/* ── merging and extracting ──────────────────────────────────────────── */

/**
 * Merges the pages of another PDF into the existing plan.
 *
 * It returns **new source bytes** alongside the extended plan: unlike rotation
 * and deletion, a merge cannot be described by a plan over the old source,
 * because the pages being added do not exist in it. That makes this the one page
 * operation that changes the source in memory immediately.
 */
export async function mergeInto(
  source: Uint8Array,
  plan: PagePlan[],
  incoming: Uint8Array,
  at: number,
): Promise<{ bytes: Uint8Array; plan: PagePlan[]; added: number; lost: string[] }> {
  const base = await PDFDocument.load(source, { ignoreEncryption: true });
  const extra = await PDFDocument.load(incoming, { ignoreEncryption: true });

  const before = base.getPageCount();
  const pages = await base.copyPages(extra, extra.getPageIndices());
  for (const page of pages) base.addPage(page);

  const added = pages.length;
  if (added === 0) throw new Error(t('The chosen PDF has no pages.'));

  // The new pages sit at the end of the source, but in the plan they go where asked.
  const inserted: PagePlan[] = Array.from({ length: added }, (_, i) => ({
    source: before + i + 1,
    rotate: 0,
  }));

  const index = Math.max(0, Math.min(at, plan.length));
  const next = [...plan.slice(0, index), ...inserted, ...plan.slice(index)];

  return {
    bytes: await base.save({ useObjectStreams: false }),
    plan: next,
    added,
    lost: [t('Merging does not carry over bookmarks, forms or attachments from the inserted document.')],
  };
}

/**
 * Extracts a subset of pages into a new document. The source stays untouched —
 * hence "extract" rather than "split": nobody wants their document halved on
 * disk because they wanted three pages out of it.
 */
export async function extractPages(
  source: Uint8Array,
  plan: PagePlan[],
  positions: number[],
): Promise<Uint8Array> {
  const wanted = [...new Set(positions)].sort((a, b) => a - b);
  const entries = wanted.map((position) => plan[position - 1]).filter((e): e is PagePlan => !!e);
  if (entries.length === 0) throw new Error(t('No page selected.'));

  const original = await PDFDocument.load(source, { ignoreEncryption: true });
  const out = await PDFDocument.create();

  const copied = await out.copyPages(
    original,
    entries.map((entry) => entry.source - 1),
  );
  copied.forEach((page, index) => {
    const entry = entries[index]!;
    if (entry.rotate !== 0) {
      page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
    }
    out.addPage(page);
  });

  out.setTitle(original.getTitle() ?? '');
  return out.save({ useObjectStreams: false });
}

/** `1-3, 7, 10-12` → `[1,2,3,7,10,11,12]`, clamped to the pages that exist. */
export function parseRanges(input: string, max: number): number[] {
  const out = new Set<number>();

  for (const part of input.split(',')) {
    const piece = part.trim();
    if (!piece) continue;

    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (i >= 1 && i <= max) out.add(i);
      }
      continue;
    }

    const single = Number(piece);
    if (Number.isInteger(single) && single >= 1 && single <= max) out.add(single);
  }

  return [...out].sort((a, b) => a - b);
}
