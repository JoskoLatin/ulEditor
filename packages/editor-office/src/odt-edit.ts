/**
 * Editing text in an OpenDocument text document — in the file it came from.
 *
 * The same contract as [`docx-edit.ts`](./docx-edit.ts): the XML is never
 * re-serialised, the replacement is done by byte range, and every byte outside
 * the rewritten text — styles, images, metadata, the other parts of the archive
 * — comes back exactly as it went in.
 *
 * **The unit is different, and it is simpler.** Word wraps every piece of text
 * in a `w:r` that carries its formatting, so the run is the thing that can be
 * rewritten and a run holding a break or a drawing has to be refused. Here the
 * formatting is an *ancestor* — a `text:span` around the text, or the paragraph
 * itself — so what gets rewritten is the character data, and a `text:line-break`
 * or an image beside it simply ends one piece and starts the next. Nothing has
 * to be refused for carrying foreign content, because a piece carries none.
 *
 * **Except spacing, which is content here.** ODF collapses whitespace the way
 * HTML does, so a run of spaces is written as `<text:s text:c="3"/>` and a tab
 * as `<text:tab/>`. Those belong to the piece rather than breaking it: they are
 * decoded into the text on the way in and written back on the way out. That is
 * what keeps a rewrite from changing the *shape* of the document — the piece
 * that held `A<text:s c="3"/>B` is still one piece after it has been rewritten,
 * so the ordinals the view was built with still point at the same text.
 *
 * There is no DOM and no zip here, so the same code runs in the browser and in
 * the checks; pairing a piece with the element the reader drew for it is done in
 * [`odf.ts`](./odf.ts), where a DOM exists.
 */

import { escapeXml, localName, scanTags, tagAttr, unescapeXml } from './docx-edit.js';

/* ── the pieces ──────────────────────────────────────────────────────── */

export interface OdtPiece {
  /** The ordinal in the document; the same order as a tree walk. */
  index: number;
  /**
   * Which element holds it, counted over **every** element in document order —
   * the same count a `querySelectorAll('*')` produces, which is what lets the
   * reader pair a piece with the text it drew without either side having to
   * agree about anything else.
   */
  container: number;
  /** The range of the whole piece: its text, and the spacing elements in it. */
  start: number;
  end: number;
  /** The text as it reads, with `text:s` and `text:tab` decoded. */
  text: string;
  /** Why this piece must not be rewritten; `null` when it may be. */
  refusal: string | null;
}

/** Elements that carry formatting and nothing else, so text inside them is still text. */
const THROUGH = new Set(['span', 'a']);

/** Elements that are part of a piece rather than a break in it. */
const SPACING = new Set(['s', 'tab']);

/**
 * `<text:s text:c="4"/>` is four spaces.
 *
 * Capped, because the count is a number in somebody else's file and nothing
 * stops it saying a billion. The reader expands it with this same function, so
 * the text a piece reports and the text on the page cannot drift apart.
 */
export function spacesOf(count: number | null): string {
  const n = count !== null && Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 4096) : 1;
  return ' '.repeat(n);
}

/**
 * Every rewritable stretch of text in `content.xml`, in document order.
 *
 * A piece ends where anything that is not text or spacing begins: a span, a
 * link, a line break, an image, a footnote. What is inside a span or a link is
 * a piece of its own, one level down, which is exactly the granularity the
 * formatting is stored at.
 */
export function findOdtPieces(xml: string): OdtPiece[] {
  const pieces: OdtPiece[] = [];
  /** One frame per open element: which it is, and whether text in it may be rewritten. */
  const stack: { ordinal: number; editable: boolean; spacing: boolean }[] = [];
  let ordinal = -1;
  let open: OdtPiece | null = null;
  let after = 0;

  const add = (start: number, end: number, text: string, blocked: string | null = null): void => {
    const frame = stack[stack.length - 1];
    /* Text outside the root element is the whitespace around it, and belongs to
       no paragraph. */
    if (!frame) return;

    if (open && open.container === frame.ordinal) {
      open.end = end;
      open.text += text;
      open.refusal ??= blocked;
      return;
    }

    open = {
      index: pieces.length,
      container: frame.ordinal,
      start,
      end,
      text,
      refusal:
        blocked ??
        (frame.editable
          ? null
          : 'the text is drawn by the program that wrote the file, not typed into it'),
    };
    pieces.push(open);
  };

  for (const tag of scanTags(xml)) {
    if (tag.start > after) {
      const raw = xml.slice(after, tag.start);
      /*
       * Character data cannot contain `<`. If it does, the scan walked past
       * something whole — a comment, a `CDATA` section — and the range now
       * covers it as well. The text is still read; it is not offered for
       * rewriting, because replacing the range would take whatever is in there
       * with it, and this program does not delete what it was not asked to.
       */
      add(after, tag.start, unescapeXml(raw), raw.includes('<') ? 'the range covers markup that is not text' : null);
    }
    after = tag.end;

    const local = localName(tag.name);

    if (tag.closing) {
      const frame = stack.pop();
      // `</text:s>` is spacing that happened to be written the long way.
      if (!frame?.spacing) open = null;
      continue;
    }

    ordinal += 1;

    if (SPACING.has(local)) {
      /* Added before the frame is pushed, so it lands in the piece it is part
         of rather than in one of its own. */
      add(tag.start, tag.end, local === 's' ? spacesOf(numberOf(tagAttr(xml, tag, 'c'))) : '\t');
      if (!tag.selfClosing) stack.push({ ordinal, editable: false, spacing: true });
      continue;
    }

    open = null;

    if (tag.selfClosing) continue;

    const parent = stack[stack.length - 1];
    stack.push({
      ordinal,
      /* A paragraph or a heading is where text may be typed; a span or a link
         inside one carries that permission down. Anywhere else — inside a date
         field, a page number, a cross-reference — the text on the page is a
         *result*, and overwriting it is the quietest way to lose it. */
      editable: local === 'p' || local === 'h' ? true : THROUGH.has(local) && (parent?.editable ?? false),
      spacing: false,
    });
  }

  return pieces;
}

function numberOf(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/* ── writing ─────────────────────────────────────────────────────────── */

export interface OdtEdit {
  index: number;
  text: string;
}

/** A new line is an element here, not a character; a pasted one becomes a space. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/**
 * One piece of text, written the way OpenDocument writes text.
 *
 * A space between two words is a space. A space at either end of the piece, or
 * the second of two in a row, is `<text:s/>` — because ODF collapses whitespace
 * exactly as HTML does, and a literal `"  "` would come back out of LibreOffice
 * as one space. Typing two spaces after a full stop is not an exotic case; it is
 * how a great many people have typed since they learned to.
 */
export function odtTextXml(text: string, prefix: string): string {
  const flat = oneLine(text);
  const out: string[] = [];
  let i = 0;

  while (i < flat.length) {
    const ch = flat[i]!;

    if (ch === '\t') {
      out.push(`<${prefix}:tab/>`);
      i += 1;
      continue;
    }

    if (ch === ' ') {
      let run = 1;
      while (flat[i + run] === ' ') run += 1;
      // The first of a run survives as itself only with text on both sides of it.
      const literal = i > 0 && i + run < flat.length ? 1 : 0;
      if (literal) out.push(' ');
      const rest = run - literal;
      if (rest === 1) out.push(`<${prefix}:s/>`);
      else if (rest > 1) out.push(`<${prefix}:s ${prefix}:c="${rest}"/>`);
      i += run;
      continue;
    }

    let to = i;
    while (to < flat.length && flat[to] !== ' ' && flat[to] !== '\t') to += 1;
    out.push(escapeXml(flat.slice(i, to)));
    i = to;
  }

  return out.join('');
}

const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

/**
 * Which prefix this file binds the text namespace to.
 *
 * `text:` in every file anyone is likely to meet — and the one time it is not,
 * writing `<text:s/>` into a document that never declared the prefix produces a
 * file no office suite will open. The root element says what it is, so it is
 * read rather than assumed.
 */
export function textPrefix(xml: string): string {
  const root = scanTags(xml).next().value;
  if (!root) return 'text';

  const found = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*["']${TEXT_NS}["']`).exec(
    xml.slice(root.start, root.end),
  );
  return found ? found[1]! : 'text';
}

function editable(pieces: OdtPiece[], edits: OdtEdit[]): { piece: OdtPiece; text: string }[] {
  const byIndex = new Map(pieces.map((piece) => [piece.index, piece]));
  return edits
    .map((edit) => ({ piece: byIndex.get(edit.index), text: edit.text }))
    .filter((pair): pair is { piece: OdtPiece; text: string } => !!pair.piece && !pair.piece.refusal);
}

/**
 * Writes the new texts into `content.xml`, changing only their ranges.
 *
 * From the end backwards, so the offsets do not shift underfoot.
 */
export function applyOdtEdits(xml: string, pieces: OdtPiece[], edits: OdtEdit[]): string {
  const prefix = textPrefix(xml);
  const ordered = editable(pieces, edits).sort((a, b) => b.piece.start - a.piece.start);

  let out = xml;
  for (const { piece, text } of ordered) {
    out = out.slice(0, piece.start) + odtTextXml(text, prefix) + out.slice(piece.end);
  }
  return out;
}

/**
 * The pieces as they stand **after** those edits were written — by arithmetic,
 * not by reading the file again.
 *
 * The difference matters in one case, and it is a case people cause every day:
 * deleting the text of a piece leaves no character data behind, so a fresh scan
 * would not find a piece there at all and every ordinal after it would shift by
 * one. The view is still on screen with the old ordinals on it, and the next
 * save would put the next edit into the wrong sentence — silently, which is the
 * only kind of wrong this project treats as unacceptable. Shifting the ranges by
 * what each rewrite gained or lost keeps the emptied piece exactly where it was,
 * as a place to type into.
 *
 * This is why `findOdtPieces` returns them in ascending order, and it relies on
 * it.
 */
export function movedPieces(xml: string, pieces: OdtPiece[], edits: OdtEdit[]): OdtPiece[] {
  const prefix = textPrefix(xml);
  const written = new Map<number, string>();
  for (const { piece, text } of editable(pieces, edits)) {
    written.set(piece.index, oneLine(text));
  }

  let shift = 0;
  return pieces.map((piece) => {
    const start = piece.start + shift;
    const text = written.get(piece.index);
    if (text === undefined) return { ...piece, start, end: piece.end + shift };

    const length = odtTextXml(text, prefix).length;
    shift += length - (piece.end - piece.start);
    return { ...piece, start, end: start + length, text };
  });
}
