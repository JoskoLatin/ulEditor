/**
 * Editing a page's content stream in place.
 *
 * The pieces here are shared by the two operations that change what a page
 * draws — deleting text ([`redact.ts`](./redact.ts)) and retyping it
 * ([`retype.ts`](./retype.ts)). Both work the same way: find the operator that
 * draws the text, write a new one over its byte range, and put the whole stream
 * back in place of the old object.
 *
 * They live apart from [`content.ts`](./content.ts) on purpose. That file only
 * reads; nothing in it can change a document. Keeping the writing side separate
 * means the reading side can be trusted at a glance.
 */

import { PDFArray, PDFName, PDFRef } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';

import type { TextOperation } from './content.js';

/** A glyph string, written as hex so no byte needs escaping. */
export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return `<${out}>`;
}

/** Three decimals: a thousandth of a text unit is far below a printed dot. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The `TJ` offset that moves the pen by a given advance.
 *
 * A number inside a `TJ` array shifts text by `-(n/1000) · Tfs · Th`, so `n` is
 * negative when the pen has to move forward. It is what holds the rest of a line
 * in place after something before it has changed length.
 */
export function adjustmentFor(advance: number, operation: TextOperation): number {
  const scale = operation.fontSize * operation.horizontalScale;
  if (scale === 0) return 0;
  return -(1000 * advance) / scale;
}

/** Replaces byte ranges, from the end backwards so the offsets do not shift. */
export function splice(
  bytes: Uint8Array,
  edits: { start: number; end: number; text: string }[],
): Uint8Array {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  const encoder = new TextEncoder();
  let out = bytes;

  for (const edit of ordered) {
    const replacement = encoder.encode(edit.text);
    const next = new Uint8Array(out.length - (edit.end - edit.start) + replacement.length);
    next.set(out.subarray(0, edit.start), 0);
    next.set(replacement, edit.start);
    next.set(out.subarray(edit.end), edit.start + replacement.length);
    out = next;
  }

  return out;
}

/**
 * Replaces a page's content stream with a single new one.
 *
 * **It writes over the existing object, not beside it.** A new stream with
 * `/Contents` redirected would leave the old one orphaned: nothing points at it
 * any more and no reader draws it — yet the bytes with the deleted text are still
 * in the file and come out with the first tool that unpacks streams. The check
 * caught exactly that.
 *
 * The array of streams is collapsed into the first one in the process — it was
 * read as one, so it is written back as one; the rest are emptied so nothing old
 * remains.
 */
export function replaceContents(doc: PDFDocument, page: PDFPage, bytes: Uint8Array): void {
  const raw = page.node.get(PDFName.of('Contents'));

  const refs: PDFRef[] = [];
  if (raw instanceof PDFRef) refs.push(raw);
  else if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i++) {
      const item = raw.get(i);
      if (item instanceof PDFRef) refs.push(item);
    }
  }

  const first = refs[0];
  if (!first) {
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)));
    return;
  }

  doc.context.assign(first, doc.context.flateStream(bytes));
  for (const ref of refs.slice(1)) {
    doc.context.assign(ref, doc.context.flateStream(new Uint8Array(0)));
  }
  page.node.set(PDFName.of('Contents'), first);
}
