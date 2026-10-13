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

import { escapeXml, localName, ownAttr, scanTags, unescapeXml, type Tag } from './docx-edit.js';

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
      add(tag.start, tag.end, local === 's' ? spacesOf(numberOf(ownAttr(xml, tag, 'c'))) : '\t');
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
  /* And what XML 1.0 cannot hold at all — a vertical tab, a form feed, the
     other control characters, a lone surrogate — is left out: a browser keeps
     them in what is typed or pasted, and one of them in the part is a file no
     reader opens (the review of card 459). */
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
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
  return prefixFor(xml, TEXT_NS, 'text');
}

const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const DRAW_NS = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';

/**
 * The namespaces the root element declares, prefix to URI — read attribute
 * after attribute, so a declaration written inside another attribute's value
 * is not taken for one (the review of card 459). Once per part.
 */
export function rootNamespaces(xml: string): Map<string, string> {
  if (namespacesRead?.xml === xml) return namespacesRead.map;
  const map = new Map<string, string>();
  const root = scanTags(xml).next().value;
  if (root) {
    const attribute = /\s([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const body = xml.slice(root.start, root.end);
    for (let match = attribute.exec(body); match; match = attribute.exec(body)) {
      const name = match[1]!;
      if (name === 'xmlns') map.set('', match[2] ?? match[3] ?? '');
      else if (name.startsWith('xmlns:')) map.set(name.slice(6), match[2] ?? match[3] ?? '');
    }
  }
  namespacesRead = { xml, map };
  return map;
}
let namespacesRead: { xml: string; map: Map<string, string> } | null = null;

/** The names of every element in the part, as the scan reads them, in order. */
export function scannedElements(xml: string): string[] {
  const names: string[] = [];
  for (const tag of scanTags(xml)) if (!tag.closing) names.push(tag.name);
  return names;
}

/** The prefix the root binds a namespace to; `fallback` where it binds none. */
function prefixFor(xml: string, uri: string, fallback: string): string {
  for (const [prefix, bound] of rootNamespaces(xml)) {
    if (bound === uri && prefix !== '') return prefix;
  }
  return fallback;
}

/**
 * Why this part is not one whose structure may be edited here; `null` when
 * it may.
 *
 * The view counts paragraphs and rows over the parsed tree, the writer over
 * the raw part, and an edit is offered only where the two counts agree. A
 * count can agree while the elements differ: a processing instruction a
 * scanner and a parser end in different places, a namespace bound again
 * inside the part or to two prefixes, an entity a DTD declares — each hides
 * an element from one side and not the other, and the next removal takes the
 * paragraph beside the one pointed at (the review of card 459). LibreOffice
 * writes none of these, so a part holding one is shown and not edited.
 */
export function odtIsPlain(xml: string): string | null {
  const start = xml.replace(/^﻿/, '').trimStart();
  const prolog = /^<\?xml\b[\s\S]*?\?>/.exec(start)?.[0] ?? '';
  if (start.slice(prolog.length).includes('<?')) return 'a processing instruction';
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return 'a document type declaration';

  const namespaces = rootNamespaces(xml);
  if (namespaces.has('')) return 'a default namespace';
  /* Any namespace, not only the three this file names: `draw` bound twice
     hid a picture from the rule that keeps it (the second review). */
  const bound = [...namespaces.values()];
  if (new Set(bound).size !== bound.length) return 'a namespace bound to two prefixes';

  let first = true;
  for (const tag of scanTags(xml)) {
    if (tag.closing) continue;
    if (!first && /\sxmlns(?::|\s*=)/.test(xml.slice(tag.start, tag.end))) return 'a namespace declared inside the part';
    const colon = tag.name.indexOf(':');
    if (colon < 1 || !namespaces.has(tag.name.slice(0, colon))) return 'an element in an undeclared namespace';
    first = false;
  }
  return null;
}

function editable(pieces: OdtPiece[], edits: OdtEdit[]): { piece: OdtPiece; text: string }[] {
  const byIndex = new Map(pieces.map((piece) => [piece.index, piece]));
  return edits
    .map((edit) => ({ piece: byIndex.get(edit.index), text: edit.text }))
    .filter((pair): pair is { piece: OdtPiece; text: string } => !!pair.piece && !pair.piece.refusal);
}

/* ── paragraphs ──────────────────────────────────────────────────────── */

export interface OdtParagraph {
  /** The ordinal among every `text:p` and `text:h` in the part, nested ones included. */
  index: number;
  start: number;
  end: number;
  /** Where its opening tag ends — where its content begins, unless it closes itself. */
  openEnd: number;
  selfClosing: boolean;
  /** `p` or `h`. */
  kind: 'p' | 'h';
  /** The name as the file writes it, prefix and all: `text:p`. */
  name: string;
  /** `text:style-name`, as it stands in the file. */
  style: string | null;
  /** `text:outline-level` of a heading. */
  level: string | null;
  /** Why this paragraph is not one the plan may add after, take away, divide or join; `null` when it is. */
  refusal: string | null;
}

/**
 * Every `text:p` and `text:h` in `content.xml`, in document order.
 *
 * The ordinals count **every** paragraph — one in a table cell, a list, a
 * frame's text box — so an index names a paragraph for the life of the
 * document, as `findParagraphs` does for Word. Which of them the plan may
 * reshape is `refusal`: only a paragraph standing directly in `office:text`.
 * A list item is a paragraph inside a `text:list-item`, and a new one after it
 * is a new **item** — a different anchor, and not yet this one. Measured on 60
 * documents LibreOffice wrote from the real corpus: 1069 paragraphs in the
 * body, 239 in lists, 972 in table cells.
 */
export function findOdtParagraphs(xml: string): OdtParagraph[] {
  const prefix = textPrefix(xml);
  /* The parent by its whole name, in its own namespace: `x:text` in some other
     namespace is not the body, whatever its local name (the review of card 459). */
  const body = `${prefixFor(xml, OFFICE_NS, 'office')}:text`;
  const lists = new Set([`${prefix}:list-item`, `${prefix}:list-header`]);
  const paragraphs: OdtParagraph[] = [];
  const stack: { name: string; paragraph: OdtParagraph | null }[] = [];

  for (const tag of scanTags(xml)) {
    if (tag.closing) {
      const popped = stack.pop();
      if (popped?.paragraph) popped.paragraph.end = tag.end;
      continue;
    }
    const local = localName(tag.name);
    const own = tag.name === `${prefix}:p` || tag.name === `${prefix}:h`;
    let paragraph: OdtParagraph | null = null;
    if (own) {
      const parent = stack[stack.length - 1]?.name ?? '';
      paragraph = {
        index: paragraphs.length,
        start: tag.start,
        end: tag.end,
        openEnd: tag.end,
        selfClosing: tag.selfClosing,
        kind: local === 'h' ? 'h' : 'p',
        name: tag.name,
        style: ownAttr(xml, tag, 'style-name'),
        level: local === 'h' ? ownAttr(xml, tag, 'outline-level') : null,
        refusal:
          parent === body
            ? null
            : lists.has(parent)
              ? 'the paragraph is in a list'
              : 'the paragraph is not in the body of the document',
      };
      paragraphs.push(paragraph);
    }
    if (!tag.selfClosing) stack.push({ name: tag.name, paragraph });
  }

  return paragraphs;
}

/** The innermost paragraph a range sits in; `null` for one outside every paragraph. */
export function paragraphOf(paragraphs: OdtParagraph[], range: { start: number; end: number }): OdtParagraph | null {
  let innermost: OdtParagraph | null = null;
  for (const one of paragraphs) {
    if (one.start > range.start) break;
    if (one.end >= range.end && !one.selfClosing) innermost = one;
  }
  return innermost;
}

/** Where a paragraph's content lies — between its tags; at its end for one that closes itself. */
function insideOf(xml: string, paragraph: OdtParagraph): { start: number; end: number } {
  if (paragraph.selfClosing) return { start: paragraph.end, end: paragraph.end };
  return { start: paragraph.openEnd, end: xml.lastIndexOf('<', paragraph.end - 1) };
}

/* ── styles ──────────────────────────────────────────────────────────── */

export interface OdtParagraphStyle {
  parent: string | null;
  /** `style:next-style-name` — the style the paragraph after this one takes. */
  next: string | null;
  /** `style:default-outline-level`: a style that makes a paragraph a heading. */
  level: string | null;
  /** It starts a page: a master page of its own, or a page break before or after it. */
  page: boolean;
}

export interface OdtStyles {
  /** The automatic styles of `content.xml` — the paragraph's own formatting. */
  automatic: Map<string, OdtParagraphStyle>;
  /** The styles of `styles.xml` a person can see by name — `Heading 1`, `Text body`. */
  common: Map<string, OdtParagraphStyle>;
}

/** The paragraph styles in one region of a part — `office:automatic-styles` or `office:styles`. */
function paragraphStyles(xml: string, region: string): Map<string, OdtParagraphStyle> {
  const styles = new Map<string, OdtParagraphStyle>();
  let inside = 0;
  let open: OdtParagraphStyle | null = null;

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);
    if (local === region && !tag.selfClosing) {
      inside += tag.closing ? -1 : 1;
      continue;
    }
    if (inside === 0) continue;

    if (local === 'style') {
      if (tag.closing) {
        open = null;
        continue;
      }
      const name = ownAttr(xml, tag, 'name');
      const family = ownAttr(xml, tag, 'family');
      if (!name || family !== 'paragraph') {
        open = null;
        continue;
      }
      const master = ownAttr(xml, tag, 'master-page-name');
      const style: OdtParagraphStyle = {
        parent: ownAttr(xml, tag, 'parent-style-name'),
        next: ownAttr(xml, tag, 'next-style-name'),
        level: ownAttr(xml, tag, 'default-outline-level'),
        page: master !== null && master !== '',
      };
      styles.set(name, style);
      open = tag.selfClosing ? null : style;
      continue;
    }
    if (open && !tag.closing && local === 'paragraph-properties') {
      if (ownAttr(xml, tag, 'break-before') === 'page' || ownAttr(xml, tag, 'break-after') === 'page') {
        open.page = true;
      }
    }
  }

  return styles;
}

export function readOdtStyles(contentXml: string, stylesXml: string | null): OdtStyles {
  return {
    automatic: paragraphStyles(contentXml, 'automatic-styles'),
    common: stylesXml ? paragraphStyles(stylesXml, 'styles') : new Map(),
  };
}

/**
 * Whether a paragraph of this style starts a page — the OpenDocument form of
 * Word's section break. A master page named on a style starts the page style
 * there, and a page break before or after is the same kind of thing: carried
 * into a second paragraph it would start a second page, and taken away with
 * the first it would rewire the layout of everything after it. Measured: three
 * of 1069 body paragraphs, all of them the first of their document.
 */
export function startsPage(styles: OdtStyles, style: string | null): boolean {
  const seen = new Set<string>();
  let name = style;
  let automatic = true;
  while (name !== null && !seen.has(name)) {
    seen.add(name);
    const found = (automatic ? styles.automatic.get(name) : undefined) ?? styles.common.get(name);
    if (!found) return false;
    if (found.page) return true;
    name = found.parent;
    automatic = false;
  }
  return false;
}

/** The common style a paragraph's own style stands on: itself, or an automatic style's parent. */
function commonOf(styles: OdtStyles, style: string | null): string | null {
  if (style === null) return null;
  return styles.automatic.get(style)?.parent ?? style;
}

/**
 * What a new paragraph after one of this style is: its style, and whether it
 * is a heading and at what level.
 *
 * The style the paragraph's own style **hands on**, through
 * `style:next-style-name` on the common style beneath it — so a paragraph after
 * a heading is body text, as LibreOffice gives it, and not a second heading.
 * The heading's own direct formatting (an automatic style) is not carried into
 * a paragraph of another style: that would mean writing a new automatic style
 * into the part, and a heading's centring is not the body text's.
 *
 * A style that hands on nothing hands on itself, automatic style and all —
 * Enter at the end of a centred paragraph gives a centred paragraph — except
 * where that style starts a page, which a second paragraph must not.
 */
export function successorOf(
  styles: OdtStyles,
  paragraph: Pick<OdtParagraph, 'kind' | 'style' | 'level'>,
): { kind: 'p' | 'h'; style: string | null; level: string | null } {
  const common = commonOf(styles, paragraph.style);
  const next = common !== null ? styles.common.get(common)?.next ?? null : null;
  if (next !== null && next !== common) {
    const level = styles.common.get(next)?.level ?? null;
    return { kind: level ? 'h' : 'p', style: next, level };
  }
  if (!startsPage(styles, paragraph.style)) {
    return { kind: paragraph.kind, style: paragraph.style, level: paragraph.level };
  }
  const parent = paragraph.style !== null ? (styles.automatic.get(paragraph.style)?.parent ?? null) : null;
  const style = parent !== null && !startsPage(styles, parent) ? parent : null;
  return { kind: paragraph.kind, style, level: paragraph.level };
}

/** An attribute value as it goes back between double quotes. */
function quoted(raw: string): string {
  /* The value as the file means it, written whole again: a name out of a
     part nobody parsed — `styles.xml` — can hold a `<` or an `&`, and copied
     as it stands it would break the part it goes into. */
  return escapeXml(unescapeXml(raw)).replace(/"/g, '&quot;');
}

/**
 * The opening tag of a paragraph this program writes — built, never copied:
 * a copy would carry `xml:id` and `text:id`, and two paragraphs with one id
 * is a file LibreOffice repairs or refuses.
 */
function openingTag(
  prefix: string,
  shape: { kind: 'p' | 'h'; style: string | null; level: string | null },
): string {
  const style = shape.style !== null ? ` ${prefix}:style-name="${quoted(shape.style)}"` : '';
  const level = shape.kind === 'h' && shape.level !== null ? ` ${prefix}:outline-level="${quoted(shape.level)}"` : '';
  return `<${prefix}:${shape.kind}${style}${level}>`;
}

/* ── the formatting a person is continuing ───────────────────────────── */

interface OpenSpan {
  name: string;
  style: string | null;
}

/**
 * The `text:span`s a piece of text stands in, outermost first; `null` when
 * anything else stands between it and its paragraph — a link, a field — which
 * a cut would tear in two and a new line cannot continue.
 */
function spansAround(xml: string, paragraph: OdtParagraph, piece: { start: number }): OpenSpan[] | null {
  const prefix = textPrefix(xml);
  const open: (OpenSpan | null)[] = [];
  const from = paragraph.openEnd;
  for (const tag of scanTags(xml.slice(from, piece.start))) {
    if (tag.selfClosing) continue;
    if (tag.closing) {
      open.pop();
      continue;
    }
    const shifted = { start: tag.start + from, end: tag.end + from };
    open.push(tag.name === `${prefix}:span` ? { name: tag.name, style: ownAttr(xml, shifted, 'style-name') } : null);
  }
  return open.every((span): span is OpenSpan => span !== null) ? open : null;
}

const opening = (spans: OpenSpan[], prefix: string): string =>
  spans.map((span) => `<${span.name}${span.style !== null ? ` ${prefix}:style-name="${quoted(span.style)}"` : ''}>`).join('');

const closing = (spans: OpenSpan[]): string =>
  [...spans].reverse().map((span) => `</${span.name}>`).join('');

/** The pieces that are a paragraph's own — not ones in a frame or a note it holds. */
function piecesOf(pieces: OdtPiece[], paragraphs: OdtParagraph[], paragraph: OdtParagraph): OdtPiece[] {
  /* The paragraphs nested in it — a text box's, a note's — follow it in
     order, and so do the pieces: one walk over both, a piece inside the
     outermost nested range left out, rather than every piece asked about
     every range (the second review of card 459). */
  const nested: { start: number; end: number }[] = [];
  for (let i = paragraph.index + 1; i < paragraphs.length && paragraphs[i]!.start < paragraph.end; i++) {
    const inner = paragraphs[i]!;
    const last = nested[nested.length - 1];
    if (!last || inner.start >= last.end) nested.push({ start: inner.start, end: inner.end });
  }
  const own: OdtPiece[] = [];
  let at = 0;
  for (const piece of pieces) {
    if (piece.start < paragraph.start || piece.end > paragraph.end) continue;
    while (at < nested.length && nested[at]!.end <= piece.start) at++;
    const inner = nested[at];
    if (inner && piece.start >= inner.start && piece.end <= inner.end) continue;
    own.push(piece);
  }
  return own;
}

/**
 * The piece a new line after this paragraph continues: its last, when nothing
 * but closing tags follows it and only spans stand around it — the formatting
 * at the point the person is typing from. `null` when the paragraph ends in
 * something else, or has no text of its own.
 */
export function lastPieceOf(
  xml: string,
  pieces: OdtPiece[],
  paragraphs: OdtParagraph[],
  paragraph: OdtParagraph,
): OdtPiece | null {
  const own = piecesOf(pieces, paragraphs, paragraph);
  const last = own[own.length - 1];
  if (!last || last.refusal) return null;
  const after = xml.slice(last.end, insideOf(xml, paragraph).end);
  if (!/^(\s*<\/[^>]+>)*\s*$/.test(after)) return null;
  return spansAround(xml, paragraph, last) ? last : null;
}

/**
 * The markup of one new paragraph after `line` — the style it hands on, and
 * the typed text in the spans of the piece the line ends in.
 */
export function odtParagraphMarkup(
  xml: string,
  styles: OdtStyles,
  line: OdtParagraph,
  continued: OdtPiece | null,
  continuedIn: OdtParagraph,
  text: string,
): string {
  const prefix = textPrefix(xml);
  const shape = successorOf(styles, line);
  const spans = continued ? (spansAround(xml, continuedIn, continued) ?? []) : [];
  return `${openingTag(prefix, shape)}${opening(spans, prefix)}${odtTextXml(text, prefix)}${closing(spans)}</${prefix}:${shape.kind}>`;
}

/* ── what may not be torn in half ────────────────────────────────────── */

/** Marks that open in one place and close in another, matched by the attribute named. */
const PAIRED: readonly (readonly [string, string, string])[] = [
  ['reference-mark-start', 'reference-mark-end', 'name'],
  ['toc-mark-start', 'toc-mark-end', 'id'],
  ['alphabetical-index-mark-start', 'alphabetical-index-mark-end', 'id'],
  ['user-index-mark-start', 'user-index-mark-end', 'id'],
];

const TRACKED = new Set(['change', 'change-start', 'change-end']);

/**
 * Whether every marked stretch opened within `[from, to)` closes within it,
 * and the reverse — a comment's range (`office:annotation` named, and its
 * `office:annotation-end`) and the index and reference marks. Bookmarks are not
 * among them: OpenDocument lets a bookmark run from one paragraph into another.
 */
function rangesBalanced(xml: string, from: number, to: number): boolean {
  const halves = new Map<string, { starts: Set<string>; ends: Set<string> }>();
  const add = (key: string, half: 'starts' | 'ends', id: string) => {
    const pair = halves.get(key) ?? { starts: new Set<string>(), ends: new Set<string>() };
    pair[half].add(id);
    halves.set(key, pair);
  };
  for (const raw of scanTags(xml.slice(from, to))) {
    if (raw.closing) continue;
    const local = localName(raw.name);
    const tag = { start: raw.start + from, end: raw.end + from };
    if (local === 'annotation') {
      const name = ownAttr(xml, tag, 'name');
      /* A comment with a name is the start of a range only if its end is
         written somewhere; one without an end is a comment on a point. */
      if (name !== null && annotationEnds(xml).has(name)) add('annotation', 'starts', name);
      continue;
    }
    if (local === 'annotation-end') {
      add('annotation', 'ends', ownAttr(xml, tag, 'name') ?? '');
      continue;
    }
    for (const [open, close, key] of PAIRED) {
      if (local === open) add(open, 'starts', ownAttr(xml, tag, key) ?? '');
      else if (local === close) add(open, 'ends', ownAttr(xml, tag, key) ?? '');
    }
  }
  for (const pair of halves.values()) {
    if ([...pair.starts].some((id) => !pair.ends.has(id))) return false;
    if ([...pair.ends].some((id) => !pair.starts.has(id))) return false;
  }
  return true;
}

/** The names every `office:annotation-end` in the part closes. */
function annotationEnds(xml: string): Set<string> {
  /* Read once per part: asked for every comment in a range, a file of ten
     thousand comments would be read ten thousand times. */
  if (endsRead?.xml === xml) return endsRead.names;
  const names = new Set<string>();
  for (const tag of scanTags(xml)) {
    if (!tag.closing && localName(tag.name) === 'annotation-end') names.add(ownAttr(xml, tag, 'name') ?? '');
  }
  endsRead = { xml, names };
  return names;
}
let endsRead: { xml: string; names: Set<string> } | null = null;

/** Whether a tracked change is recorded anywhere in a range. */
function tracked(xml: string, from: number, to: number): boolean {
  for (const tag of scanTags(xml.slice(from, to))) {
    if (!tag.closing && TRACKED.has(localName(tag.name))) return true;
  }
  return false;
}

/** Marks that name a place: what a cross-reference, a link or an index points to. */
const PLACES = new Set(['bookmark', 'reference-mark', 'bookmark-start', 'reference-mark-start']);

/**
 * The names something in the part points to: a cross-reference to a bookmark
 * or a reference mark (`text:bookmark-ref`, `text:reference-ref`, by
 * `text:ref-name`), or a link within the document (`xlink:href="#name"`, up to
 * a `|`, as LibreOffice writes a link to a heading or a table).
 */
function pointedNames(xml: string): Set<string> {
  if (pointedRead?.xml === xml) return pointedRead.names;
  const names = new Set<string>();
  for (const tag of scanTags(xml)) {
    if (tag.closing) continue;
    const local = localName(tag.name);
    if (local === 'bookmark-ref' || local === 'reference-ref') {
      const name = ownAttr(xml, tag, 'ref-name');
      if (name !== null) names.add(name);
    }
    const href = ownAttr(xml, tag, 'href');
    if (href?.startsWith('#')) names.add(href.slice(1).split('|')[0]!);
  }
  pointedRead = { xml, names };
  return names;
}
let pointedRead: { xml: string; names: Set<string> } | null = null;

/**
 * Why the places named in a range may not go with it, if any: one something
 * else points to — a cross-reference would be left reading "Error: Reference
 * source not found" — or half a bookmark whose other half is outside, which
 * would be left closing nothing. A place nothing points to goes: measured over
 * the corpus (card 525), the marks in the paragraphs that may be taken away
 * were all `_GoBack` and `_Hlk…`, which Word writes and drops itself.
 */
function placesRefusal(xml: string, from: number, to: number): string | null {
  const pointed = pointedNames(xml);
  const halves = new Map<string, number>();
  for (const raw of scanTags(xml.slice(from, to))) {
    if (raw.closing) continue;
    const local = localName(raw.name);
    const tag = { start: raw.start + from, end: raw.end + from };
    if (PLACES.has(local) && pointed.has(ownAttr(xml, tag, 'name') ?? '')) {
      return 'the paragraph holds a place something else points to';
    }
    if (local === 'bookmark-start' || local === 'bookmark-end') {
      const name = ownAttr(xml, tag, 'name') ?? '';
      halves.set(name, (halves.get(name) ?? 0) + (local === 'bookmark-start' ? 1 : -1));
    }
  }
  if ([...halves.values()].some((open) => open !== 0)) return 'a bookmark continues outside the paragraph';
  return null;
}

/* ── the rules ───────────────────────────────────────────────────────── */

/**
 * Why this paragraph may not be taken away; `null` when it may.
 *
 * - **Only a body paragraph** — see `findOdtParagraphs`.
 * - **Not one that starts a page** (`startsPage`).
 * - **Not half a marked stretch**, and not one a tracked change is recorded
 *   in: the record would be left describing text that is gone.
 * - **Not the last paragraph standing**, judged against `survivors` — the body
 *   paragraphs the plan still keeps — so taking them away one at a time cannot
 *   reach a place one step may not.
 */
export function odtRemovalRefusal(
  xml: string,
  paragraphs: OdtParagraph[],
  styles: OdtStyles,
  index: number,
  survivors?: ReadonlySet<number>,
): string | null {
  const span = paragraphs[index];
  if (!span) return 'there is no such paragraph';
  if (span.refusal) return span.refusal;
  if (startsPage(styles, span.style)) return 'the paragraph starts a page';
  if (tracked(xml, span.start, span.end)) return 'a tracked change is recorded in the paragraph';
  if (!rangesBalanced(xml, span.start, span.end)) return 'a marked stretch continues outside the paragraph';
  const places = placesRefusal(xml, span.start, span.end);
  if (places) return places;
  /* A text box anchored in it, or a comment, holds paragraphs of its own,
     which the view does not draw: the line looks nearly empty and carries a
     page of text. Measured: one such paragraph in the corpus held forty. */
  const inner = paragraphs[index + 1];
  if (inner && inner.start < span.end) return 'the paragraph holds text the view does not show';
  /* And a picture, a chart, a formula or a shape: the view draws some
     pictures and none of the rest — a Word document written as .odt carries
     its EMF pictures there — so a line that looks empty can hold one, and
     taking the line away would take it too (the review of card 459). */
  const draw = prefixFor(xml, DRAW_NS, 'draw');
  for (const tag of scanTags(xml.slice(span.start, span.end))) {
    if (!tag.closing && tag.name.startsWith(`${draw}:`)) return 'the paragraph holds a picture or an object';
  }
  const body = paragraphs.filter((one) => one.refusal === null);
  const alive = survivors ?? new Set(body.map((one) => one.index));
  if (!alive.has(index)) return 'there is no such paragraph';
  if (!body.some((one) => one.index !== index && alive.has(one.index))) return 'the last paragraph of the document';
  return null;
}

/**
 * Why the paragraph a piece of text stands in may not be divided inside it —
 * Enter in the middle of a sentence; `null` when it may.
 *
 * A cut closes the paragraph where it falls and opens another, so whatever
 * else is open there is closed and opened again: a `text:span` can be, its
 * formatting is its style; a link, a field or anything else would become two.
 * And a marked stretch must close on the side it opened.
 */
export function odtDivisionRefusal(
  xml: string,
  paragraphs: OdtParagraph[],
  styles: OdtStyles,
  piece: OdtPiece,
): string | null {
  const paragraph = paragraphOf(paragraphs, piece);
  if (!paragraph || paragraph.refusal) return paragraph?.refusal ?? 'the paragraph is not in the body of the document';
  if (piece.refusal) return 'the text cannot be retyped';
  if (startsPage(styles, paragraph.style)) return 'the paragraph starts a page';
  if (!spansAround(xml, paragraph, piece)) return 'the text is inside an element a cut would tear in two';
  if (tracked(xml, paragraph.start, paragraph.end)) return 'a tracked change is recorded in the paragraph';
  const inside = insideOf(xml, paragraph);
  if (!rangesBalanced(xml, inside.start, piece.start) || !rangesBalanced(xml, piece.end, inside.end)) {
    return 'a marked stretch continues outside the paragraph';
  }
  return null;
}

/** What may stand between two body paragraphs a join brings together: nothing but layout's own marks. */
const BETWEEN = new Set(['soft-page-break']);

/**
 * The next body paragraph the plan keeps, and whether anything but white
 * space, a soft page break and paragraphs the plan removes stands between.
 */
function partnerOf(
  xml: string,
  body: OdtParagraph[],
  span: OdtParagraph,
  alive: ReadonlySet<number>,
): OdtParagraph | string {
  let from = span.end;
  for (const one of body) {
    if (one.index <= span.index) continue;
    for (const tag of scanTags(xml.slice(from, one.start))) {
      if (!tag.closing && !BETWEEN.has(localName(tag.name))) return 'something stands between the two paragraphs';
    }
    if (xml.slice(from, one.start).replace(/<[^>]*>/g, '').trim() !== '') return 'something stands between the two paragraphs';
    if (alive.has(one.index)) return one;
    from = one.end;
  }
  return 'nothing follows the paragraph';
}

/**
 * Why a paragraph may not be joined with the next one the plan keeps — Delete
 * at its end, Backspace at the start of the next; `null` when it may.
 *
 * The joined paragraph keeps the first one's tag and style, as LibreOffice
 * keeps them. So the next one may not start a page — its page would go — while
 * the first may: its page starts where it always did.
 */
export function odtJoinRefusal(
  xml: string,
  paragraphs: OdtParagraph[],
  styles: OdtStyles,
  index: number,
  survivors?: ReadonlySet<number>,
): string | null {
  const span = paragraphs[index];
  if (!span) return 'there is no such paragraph';
  if (span.refusal) return span.refusal;
  const body = paragraphs.filter((one) => one.refusal === null);
  const alive = survivors ?? new Set(body.map((one) => one.index));
  if (!alive.has(index)) return 'there is no such paragraph';
  const next = partnerOf(xml, body, span, alive);
  if (typeof next === 'string') return next;
  if (startsPage(styles, next.style)) return 'the paragraph starts a page';
  /* The joined paragraph is the first one's tag, so the next one's `xml:id`
     or `text:id` goes with its tag — a file whose metadata names one would lose that (none in the
     corpus; the review of card 459 asked). */
  if (tracked(xml, span.start, span.end) || tracked(xml, next.start, next.end)) {
    return 'a tracked change is recorded where the paragraphs meet';
  }
  return null;
}

/** Marks that show nothing on the page — a line holding only these is an empty line. */
const SHOWS_NOTHING = new Set([
  'span',
  'bookmark',
  'bookmark-start',
  'bookmark-end',
  'soft-page-break',
  'reference-mark',
  'reference-mark-start',
  'reference-mark-end',
  'annotation-end',
]);

/**
 * Whether a stretch of a paragraph shows nothing, with the rewrites of its
 * pieces as the plan holds them. A space written as `text:s` or a tab is
 * something; white space in the character data is not, since OpenDocument
 * collapses it. Anything not listed counts as something, so an element nobody
 * thought of can only make a line count as holding text.
 */
function showsNothingIn(
  xml: string,
  from: number,
  to: number,
  pieces: OdtPiece[],
  typed: ReadonlyMap<number, string>,
): boolean {
  const retyped = pieces.filter((piece) => typed.has(piece.index) && piece.start >= from && piece.end <= to);
  if (retyped.some((piece) => typed.get(piece.index)!.length > 0)) return false;
  const skipped = (at: number) => retyped.some((piece) => at >= piece.start && at < piece.end);

  let after = from;
  for (const raw of scanTags(xml.slice(from, to))) {
    const start = raw.start + from;
    if (start > after && !skipped(after) && xml.slice(after, start).trim() !== '') return false;
    after = raw.end + from;
    if (raw.closing || skipped(start)) continue;
    if (!SHOWS_NOTHING.has(localName(raw.name))) return false;
  }
  return !(to > after && !skipped(after) && xml.slice(after, to).trim() !== '');
}

/** Whether a paragraph shows nothing, with the rewrites the plan holds. */
export function odtShowsNothing(
  xml: string,
  pieces: OdtPiece[],
  paragraph: OdtParagraph,
  typed: ReadonlyMap<number, string> = new Map(),
): boolean {
  const inside = insideOf(xml, paragraph);
  return showsNothingIn(xml, inside.start, inside.end, pieces, typed);
}

/** Whether two paragraphs would give a new line the same shape: the same tag, style and level. */
export function odtAlike(a: OdtParagraph, b: OdtParagraph): boolean {
  return a.kind === b.kind && a.style === b.style && a.level === b.level;
}

/* ── a new row in a table ────────────────────────────────────────────── */

/** One cell of a row as the grid sees it. */
interface OdtCell {
  tag: Tag;
  /** `covered-table-cell` — a place another cell's span covers. */
  covered: boolean;
  /** Covered by a cell of a row above, rather than by the one before it in this row. */
  fromAbove: boolean;
  /** Columns of the grid it covers, `number-columns-spanned`. */
  span: number;
  /** `number-columns-repeated`: one element written for that many cells. */
  repeat: number;
}

export interface OdtRow {
  /** The ordinal among every `table:table-row` in the part, nested tables' included. */
  index: number;
  start: number;
  end: number;
  /** Where its own table begins; the rows of one table share it. */
  table: number;
  cells: OdtCell[];
  /** Some cell of it is covered by a cell of a row above — it is inside a merge. */
  continued: boolean;
  /** Why no new row may follow this one; `null` when one may. */
  refusal: string | null;
}

/** How many columns of a table's grid are followed — LibreOffice's own tables stop far short of it. */
const MOST_COLUMNS = 4096;

/** What may stand between a row and the body: its own table, and a cell of an outer one. */
const ROW_REGION = new Set(['table', 'table-row', 'table-cell', 'table-rows', 'table-header-rows', 'table-row-group']);

/** The direct children of an element, by their ranges. */
function childrenOf(xml: string, outer: { start: number; end: number }): Tag[] {
  const found: Tag[] = [];
  let depth = 0;
  let opened: Tag | null = null;
  for (const tag of scanTags(xml.slice(outer.start, outer.end))) {
    const shifted = { ...tag, start: tag.start + outer.start, end: tag.end + outer.start };
    if (shifted.selfClosing) {
      if (depth === 1) found.push(shifted);
      continue;
    }
    if (shifted.closing) {
      depth--;
      if (depth === 1 && opened) {
        found.push({ ...opened, end: shifted.end });
        opened = null;
      }
      continue;
    }
    depth++;
    if (depth === 2 && !opened) opened = shifted;
  }
  return found;
}

/**
 * An element's opening tag alone — the range its own attributes are read
 * from. Read over the whole element, an attribute it lacks would be found on
 * a child: a row without a style would take its first cell's.
 */
function openingOf(xml: string, element: { start: number }): { start: number; end: number } {
  const first = scanTags(xml.slice(element.start)).next().value;
  return { start: element.start, end: element.start + (first?.end ?? 0) };
}

const count = (raw: string | null, most: number): number => {
  const n = raw === null ? 1 : Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, most) : 1;
};

/**
 * Every `table:table-row` in the part, in document order, with its cells
 * read against the grid.
 *
 * A cell spanning rows (`number-rows-spanned`) leaves a `covered-table-cell`
 * in each row below it that it reaches; a cell spanning columns leaves them
 * after itself in its own row. The two look alike in the file, and only the
 * grid tells them apart — which matters, because a new row below a merge goes
 * below the last row it reaches, and a covered cell there is a cell of its own
 * in the new row.
 */
export function findOdtRows(xml: string): OdtRow[] {
  /* Every name in its own namespace: a `table-row` of some other namespace
     is no row of a table (the review of card 459). */
  const table = prefixFor(xml, TABLE_NS, 'table');
  const body = `${prefixFor(xml, OFFICE_NS, 'office')}:text`;
  const region = new Set([...ROW_REGION].map((local) => `${table}:${local}`));
  const rowName = `${table}:table-row`;
  const cellNames = new Set([`${table}:table-cell`, `${table}:covered-table-cell`]);

  const rows: OdtRow[] = [];
  /* The cells of each row, gathered in the same pass: asked of the row
     afterwards, a table nested a thousand deep was scanned a thousand times. */
  const raw = new Map<OdtRow, Tag[]>();
  /* Each frame carries the table it is in and the nearest element around it
     that is not part of a table, from its parent: walked up the stack for
     every row instead, tables nested a thousand deep cost a thousand steps a
     row (the second review of card 459). */
  const stack: { name: string; start: number; row: OdtRow | null; cell: Tag | null; table: number; outside: string }[] = [];

  for (const tag of scanTags(xml)) {
    if (tag.closing) {
      const popped = stack.pop();
      if (popped?.row) popped.row.end = tag.end;
      if (popped?.cell) popped.cell.end = tag.end;
      continue;
    }
    let row: OdtRow | null = null;
    let cell: Tag | null = null;
    const parent = stack[stack.length - 1];
    if (tag.name === rowName) {
      const owner = parent?.table ?? -1;
      const where = parent?.outside ?? '';
      row = {
        index: rows.length,
        start: tag.start,
        end: tag.end,
        table: owner,
        cells: [],
        continued: false,
        refusal:
          owner === -1
            ? 'the row is not a row of a table'
            : where !== body
              ? 'the table is not in the body of the document'
              : count(ownAttr(xml, tag, 'number-rows-repeated'), 2) > 1
                ? 'the row stands for several rows'
                : null,
      };
      rows.push(row);
      raw.set(row, []);
    } else if (cellNames.has(tag.name) && parent?.row) {
      cell = { ...tag };
      raw.get(parent.row)!.push(cell);
    }
    if (!tag.selfClosing) {
      stack.push({
        name: tag.name,
        start: tag.start,
        row,
        cell,
        table: tag.name === `${table}:table` ? tag.start : (parent?.table ?? -1),
        outside: region.has(tag.name) ? (parent?.outside ?? '') : tag.name,
      });
    }
  }

  /* The cells, against each table's grid, row after row. The grid is
     followed only so far: the spans and repeats are numbers in somebody
     else's file, and a row claiming a million columns would otherwise cost a
     million steps for every row after it. A row past the edge takes no new
     row after it. */
  const pending = new Map<number, number[]>();
  for (const row of rows) {
    if (row.table === -1) continue;
    const below = pending.get(row.table) ?? [];
    pending.set(row.table, below);
    const fromAbove = below.map((left) => left > 0);
    let column = 0;
    for (const tag of raw.get(row) ?? []) {
      const local = localName(tag.name);
      if (column >= MOST_COLUMNS) {
        row.refusal ??= 'the table is wider than this program follows';
        break;
      }
      const covered = local === 'covered-table-cell';
      const repeat = count(ownAttr(xml, tag, 'number-columns-repeated'), 64);
      const span = covered ? 1 : count(ownAttr(xml, tag, 'number-columns-spanned'), 1024);
      const down = covered ? 1 : count(ownAttr(xml, tag, 'number-rows-spanned'), 1 << 20);
      row.cells.push({ tag, covered, fromAbove: covered && fromAbove[column] === true, span, repeat });
      if (covered && fromAbove[column]) row.continued = true;
      for (let r = 0; r < repeat && column < MOST_COLUMNS; r++) {
        if (down > 1) for (let c = column; c < Math.min(column + span, MOST_COLUMNS); c++) below[c] = down;
        column += span;
      }
    }
    for (let c = 0; c < below.length; c++) if (below[c]! > 0) below[c]! -= 1;
  }

  return rows;
}

/** The next row of the same table — one that begins where it does; `null` at its end. A nested table's rows are not its own. */
function nextRowOf(rows: OdtRow[], row: OdtRow): OdtRow | null {
  for (let i = row.index + 1; i < rows.length; i++) {
    if (rows[i]!.table === row.table) return rows[i]!;
  }
  return null;
}

/** The row a new one actually follows: below the last row a cell merged down reaches. */
export function anchorOdtRow(rows: OdtRow[], row: OdtRow): OdtRow {
  let at = row;
  for (let next = nextRowOf(rows, at); next !== null && next.continued; next = nextRowOf(rows, at)) at = next;
  return at;
}

/** Why no new row may follow this one; `null` when one may. */
export function odtRowRefusal(rows: OdtRow[], index: number): string | null {
  const row = rows[index];
  if (!row) return 'there is no such row';
  if (row.refusal) return row.refusal;
  const anchor = anchorOdtRow(rows, row);
  if (anchor.refusal) return anchor.refusal;
  if (anchor.cells.length === 0) return 'the row has no cells';
  return null;
}

/**
 * The cells a new row after this one has, as wide across the grid as these
 * are: a cell keeps its span, a cell repeated is that many cells, a place
 * covered from the row above is a cell of its own, and a place covered by the
 * cell before it in this row is that cell's.
 */
export function odtRowShape(row: OdtRow): number[] {
  const shape: number[] = [];
  for (const cell of row.cells) {
    if (cell.covered && !cell.fromAbove) continue;
    for (let r = 0; r < cell.repeat; r++) shape.push(cell.covered ? 1 : cell.span);
  }
  return shape;
}

/**
 * The markup of a new row: **the row it follows, emptied** — the row's style,
 * each cell's style and span, and each cell's first paragraph's style, each
 * built rather than copied; no content, no spanning down, no ids.
 */
export function odtRowMarkup(xml: string, row: OdtRow, texts: readonly string[]): string {
  const prefix = textPrefix(xml);
  const table = prefixFor(xml, TABLE_NS, 'table');
  const office = prefixFor(xml, OFFICE_NS, 'office');
  const styled = (raw: string | null) => (raw !== null ? ` ${table}:style-name="${quoted(raw)}"` : '');

  let out = `<${table}:table-row${styled(ownAttr(xml, openingOf(xml, row), 'style-name'))}>`;
  let at = 0;
  for (const cell of row.cells) {
    if (cell.covered && !cell.fromAbove) continue;
    const own = openingOf(xml, cell.tag);
    const style = ownAttr(xml, own, 'style-name');
    const typed = ownAttr(xml, own, 'value-type') !== null ? ` ${office}:value-type="string"` : '';
    const first = cell.covered
      ? undefined
      : childrenOf(xml, cell.tag).find((child) => child.name === `${prefix}:p` || child.name === `${prefix}:h`);
    const paragraphStyle = first ? ownAttr(xml, openingOf(xml, first), 'style-name') : null;
    for (let r = 0; r < cell.repeat; r++) {
      const text = texts[at++] ?? '';
      const p = paragraphStyle !== null ? ` ${prefix}:style-name="${quoted(paragraphStyle)}"` : '';
      const paragraph = text.length > 0 ? `<${prefix}:p${p}>${odtTextXml(text, prefix)}</${prefix}:p>` : `<${prefix}:p${p}/>`;
      const span = cell.covered || cell.span === 1 ? '' : ` ${table}:number-columns-spanned="${cell.span}"`;
      out += `<${table}:table-cell${styled(style)}${typed}${span}>${paragraph}</${table}:table-cell>`;
      if (!cell.covered) for (let c = 1; c < cell.span; c++) out += `<${table}:covered-table-cell/>`;
    }
  }
  return `${out}</${table}:table-row>`;
}

/* ── writing the plan ────────────────────────────────────────────────── */

/** A piece of text divided by Enter: the first part stays, every later one begins a paragraph. */
export interface OdtCut {
  piece: number;
  parts: string[];
}

export interface OdtReshaping {
  paragraphs: OdtParagraph[];
  styles: OdtStyles;
  /** New paragraphs, each after a paragraph of the original part. */
  inserts?: { after: number; text: string }[];
  /** Paragraphs of the original part the plan takes away. */
  removals?: number[];
  cuts?: OdtCut[];
  /** Paragraphs of the original part joined with the next one the plan keeps. */
  joins?: number[];
  /** The rows of the original part, for new rows to name and be built from. */
  rows?: OdtRow[];
  /** New rows, each after a row of the original part, with what was typed into each cell. */
  rowInserts?: { after: number; cells: string[] }[];
}

/**
 * Writes the new texts into `content.xml`, changing only their ranges — and,
 * with a reshaping, every new paragraph, removal, division and join in the
 * same pass, from the original as it was opened, as `applyDocxEdits` does for
 * Word and for the same reasons: back to front so no offset moves under the
 * next operation, a removal before an insertion at the same offset, a new
 * paragraph nobody typed into not written, and every step judged again here
 * rather than trusted, because a caller is not obliged to have asked first.
 */
export function applyOdtEdits(
  xml: string,
  pieces: OdtPiece[],
  edits: OdtEdit[],
  reshaping?: OdtReshaping,
): string {
  const prefix = textPrefix(xml);
  const operations: { at: number; end: number; text: string; order: number }[] = [];
  const paragraphs = reshaping?.paragraphs ?? [];
  const styles = reshaping?.styles ?? { automatic: new Map(), common: new Map() };
  const byIndex = new Map(pieces.map((piece) => [piece.index, piece]));
  const typed = new Map(editable(pieces, edits).map(({ piece, text }) => [piece.index, text]));
  const body = paragraphs.filter((span) => span.refusal === null);

  /* The removals first, judged one by one against what the ones before them left. */
  const removed: OdtParagraph[] = [];
  if (reshaping?.removals?.length) {
    const alive = new Set(body.map((span) => span.index));
    for (const index of [...reshaping.removals].sort((a, b) => a - b)) {
      if (odtRemovalRefusal(xml, paragraphs, styles, index, alive) !== null) continue;
      alive.delete(index);
      removed.push(paragraphs[index]!);
    }
  }
  const inRemoved = (range: { start: number; end: number }) =>
    removed.some((span) => range.start >= span.start && range.end <= span.end);

  /* The cuts next: a divided paragraph is written as one operation from its
     first cut to the end of its content, so nothing else may touch that range. */
  const cutByPiece = new Map<number, OdtCut>();
  const divided = new Map<number, OdtPiece[]>();
  for (const cut of reshaping?.cuts ?? []) {
    const piece = byIndex.get(cut.piece);
    if (!piece || cut.parts.length < 2 || cutByPiece.has(cut.piece)) continue;
    const paragraph = paragraphOf(paragraphs, piece);
    if (!paragraph || inRemoved(paragraph)) continue;
    if (odtDivisionRefusal(xml, paragraphs, styles, piece) !== null) continue;
    cutByPiece.set(cut.piece, cut);
    divided.set(paragraph.index, [...(divided.get(paragraph.index) ?? []), piece]);
  }
  const claimed = [...divided].map(([index, cut]) => ({
    from: Math.min(...cut.map((piece) => piece.start)),
    to: insideOf(xml, paragraphs[index]!).end,
  }));

  /* The joins, in ordinal order, each judged against the links before it. An
     empty first line is not joined: Backspace after an empty line takes the
     line away, and the plan says that with a removal. */
  const joinedTo = new Map<number, number>();
  const joins: { first: OdtParagraph; next: OdtParagraph }[] = [];
  const lineShowsNothing = (span: OdtParagraph): boolean => {
    const cut = divided.get(span.index);
    if (cut) {
      const last = [...cut].sort((a, b) => b.start - a.start)[0]!;
      if (cutByPiece.get(last.index)!.parts.at(-1)!.length > 0) return false;
      return showsNothingIn(xml, last.end, insideOf(xml, span).end, pieces, typed);
    }
    if (!odtShowsNothing(xml, pieces, span, typed)) return false;
    const before = joinedTo.get(span.index);
    return before === undefined || lineShowsNothing(paragraphs[before]!);
  };
  if (reshaping?.joins?.length) {
    const alive = new Set(body.filter((span) => !removed.includes(span)).map((span) => span.index));
    const followed = new Set(
      (reshaping.inserts ?? []).filter((insert) => insert.text.length > 0).map((insert) => insert.after),
    );
    for (const index of [...new Set(reshaping.joins)].sort((a, b) => a - b)) {
      if (odtJoinRefusal(xml, paragraphs, styles, index, alive) !== null) continue;
      const first = paragraphs[index]!;
      const next = partnerOf(xml, body, first, alive) as OdtParagraph;
      const crossed = body.filter((span) => span.index >= index && span.index < next.index);
      if (crossed.some((span) => followed.has(span.index))) continue;
      if (lineShowsNothing(first)) continue;
      joinedTo.set(next.index, index);
      joins.push({ first, next });
    }
  }
  /** The paragraph whose tag and style the line holding this one is written with. */
  const headOf = (index: number): OdtParagraph => {
    let at = index;
    while (joinedTo.has(at)) at = joinedTo.get(at)!;
    return paragraphs[at]!;
  };
  /** The piece a new line after this paragraph continues, and the paragraph it stands in. */
  const lineEnd = (index: number): { piece: OdtPiece | null; in: OdtParagraph } => {
    for (let at: number | undefined = index; at !== undefined; at = joinedTo.get(at)) {
      const found = lastPieceOf(xml, pieces, paragraphs, paragraphs[at]!);
      if (found) return { piece: found, in: paragraphs[at]! };
    }
    return { piece: null, in: paragraphs[index]! };
  };

  for (const [index, text] of typed) {
    const piece = byIndex.get(index)!;
    if (inRemoved(piece)) continue;
    if (claimed.some((range) => piece.start >= range.from && piece.end <= range.to)) continue;
    operations.push({ at: piece.start, end: piece.end, text: odtTextXml(text, prefix), order: 0 });
  }

  (reshaping?.inserts ?? []).forEach((insert, order) => {
    const paragraph = paragraphs[insert.after];
    if (!paragraph || paragraph.refusal || insert.text.length === 0) return;
    const end = lineEnd(paragraph.index);
    operations.push({
      at: paragraph.end,
      end: paragraph.end,
      text: odtParagraphMarkup(xml, styles, headOf(paragraph.index), end.piece, end.in, insert.text),
      order,
    });
  });

  /** A stretch of the original carried into a divided paragraph, with the rewrites inside it applied. */
  const carried = (from: number, to: number): string => {
    const inside = [...typed.keys()]
      .map((index) => byIndex.get(index)!)
      .filter((piece) => piece.start >= from && piece.end <= to)
      .sort((a, b) => b.start - a.start);
    let text = xml.slice(from, to);
    for (const piece of inside) {
      text = text.slice(0, piece.start - from) + odtTextXml(typed.get(piece.index)!, prefix) + text.slice(piece.end - from);
    }
    return text;
  };

  /* A divided paragraph, written whole: each cut closes the spans around it
     and the line, and opens a paragraph of the line's own shape — both halves
     of a heading are headings — with the same spans again. */
  for (const [index, cut] of divided) {
    const paragraph = paragraphs[index]!;
    const head = headOf(index);
    const end = insideOf(xml, paragraph).end;
    const ordered = [...cut].sort((a, b) => a.start - b.start);
    const shape = { kind: head.kind, style: head.style, level: head.level };

    let text = '';
    ordered.forEach((piece, k) => {
      if (k > 0) text += carried(ordered[k - 1]!.end, piece.start);
      const spans = spansAround(xml, paragraph, piece)!;
      const [first, ...rest] = cutByPiece.get(piece.index)!.parts;
      text += odtTextXml(first!, prefix);
      for (const part of rest) {
        text += `${closing(spans)}</${head.name}>${openingTag(prefix, shape)}${opening(spans, prefix)}${odtTextXml(part, prefix)}`;
      }
    });
    text += carried(ordered[ordered.length - 1]!.end, end);
    operations.push({ at: ordered[0]!.start, end, text, order: 0 });
  }

  /* A join, written as the boundary it takes away: from the first
     paragraph's closing tag to the end of the next one's opening tag. The
     line closes with the next one's closing tag, which is rewritten to the
     line's own where the two differ — a body paragraph joined onto a heading
     closes as a heading — and written where the next one closes itself. */
  const firsts = new Set(joins.map((join) => join.first.index));
  for (const join of joins) {
    const from = insideOf(xml, join.first);
    const to = insideOf(xml, join.next);
    const head = headOf(join.first.index);
    const last = !firsts.has(join.next.index);
    const close = last && join.next.selfClosing ? `</${head.name}>` : '';
    operations.push({ at: from.end, end: to.start, text: close, order: 0 });
    if (last && !join.next.selfClosing && join.next.name !== head.name) {
      operations.push({ at: to.end, end: join.next.end, text: `</${head.name}>`, order: 0 });
    }
  }

  for (const span of removed) {
    if (joins.some((join) => span.start >= join.first.end && span.end <= join.next.start)) continue;
    operations.push({ at: span.start, end: span.end, text: '', order: 0 });
  }

  /* A new row, after the row it follows — below the last row a merge
     reaches — and only one somebody typed into: a row of empty cells has
     nothing in it a person could put a cursor in again. Two after one row
     keep the order they were added in. */
  const rows = reshaping?.rows ?? [];
  (reshaping?.rowInserts ?? []).forEach((insert, order) => {
    if (insert.cells.every((text) => text.length === 0)) return;
    if (odtRowRefusal(rows, insert.after) !== null) return;
    const anchor = anchorOdtRow(rows, rows[insert.after]!);
    operations.push({ at: anchor.end, end: anchor.end, text: odtRowMarkup(xml, anchor, insert.cells), order });
  });

  operations.sort((a, b) => b.at - a.at || b.end - b.at - (a.end - a.at) || b.order - a.order);
  let out = xml;
  for (const operation of operations) {
    out = out.slice(0, operation.at) + operation.text + out.slice(operation.end);
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
