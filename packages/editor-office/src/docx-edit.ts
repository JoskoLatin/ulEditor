/**
 * Editing text in a Word document — surgically, one run at a time.
 *
 * **Why a run and not a paragraph.** In OOXML a `w:r` is a piece of text with a
 * single formatting. A paragraph often holds a dozen of them: a bold name, a
 * plain sentence, an italic aside. To rewrite a paragraph, the program would
 * have to guess which formatting applies to which new letter — and that is
 * precisely the silent loss of somebody else's formatting this project forbids.
 * A run is rewritten without a single such decision: its formatting stays, only
 * the text changes.
 *
 * **Why the XML is not re-serialised.** `XMLSerializer` would walk the whole
 * document and change quotation marks, namespaces, attribute order and
 * whitespace along the way. The diff would bear no resemblance to what the user
 * asked for. So the replacement is done **by byte range**: everything but the
 * rewritten text stays character for character identical.
 *
 * There is no DOM and no zip here, so the same code runs in the browser and in
 * the checks.
 */

import { strToU8, zipSync } from 'fflate';

import type { Archive } from './ooxml.js';

/* ── walking the tags ────────────────────────────────────────────────── */

export interface Tag {
  /** The name with its prefix, as it stands in the file: `w:r`, `w:t`. */
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Yields every XML tag in order, with its range.
 *
 * Quotes are respected because an attribute value may contain `>`, and comments
 * and CDATA are skipped whole — otherwise a `<` inside them would look like the
 * start of a tag.
 *
 * Exported because [`xlsx-edit.ts`](./xlsx-edit.ts) walks a worksheet with the
 * same care this file walks a document.
 */
export function* scanTags(xml: string): Generator<Tag> {
  let i = 0;

  while (i < xml.length) {
    const open = xml.indexOf('<', i);
    if (open === -1) return;

    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const close = xml.indexOf('>', open);
      i = close === -1 ? xml.length : close + 1;
      continue;
    }

    let at = open + 1;
    let quote = '';
    while (at < xml.length) {
      const ch = xml[at]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      at++;
    }
    if (at >= xml.length) return;

    const body = xml.slice(open + 1, at);
    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');
    const name = body
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .trim()
      .split(/[\s/]/, 1)[0]!;

    yield { name, start: open, end: at + 1, closing, selfClosing };
    i = at + 1;
  }
}

export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * An attribute of a scanned tag, **by local name** — the prefix is whatever the
 * file happens to use.
 *
 * OOXML is written with the prefixes everyone writes it with, so `xlsx-edit.ts`
 * and `ods-edit.ts` ask for `r` and `table:number-columns-repeated` by name. An
 * OpenDocument text document is the one place that cannot: it is read here and
 * **written back**, and a producer is free to bind the text namespace to any
 * prefix it likes. Reading `text:c` from a file that spells it `t:c` would
 * silently turn four spaces into one.
 */
export function tagAttr(xml: string, tag: { start: number; end: number }, local: string): string | null {
  const body = xml.slice(tag.start, tag.end);
  const match = new RegExp(
    `[\\s<]([A-Za-z_][\\w.-]*:)?${local}\\s*=\\s*("([^"]*)"|'([^']*)')`,
  ).exec(body);
  if (!match) return null;
  return match[3] ?? match[4] ?? null;
}

/* ── runovi ──────────────────────────────────────────────────────────── */

export interface RunSpan {
  /** The ordinal in the document; the same order as a DOM tree walk. */
  index: number;
  start: number;
  end: number;
  /** The range of the single `w:t` element and of its content. */
  text: { start: number; end: number; contentStart: number; contentEnd: number } | null;
  /** Why this run cannot be rewritten; `null` when it can. */
  refusal: string | null;
}

/**
 * Content that makes a run un-rewritable.
 *
 * A line break and a tab carry position, while a drawing, a field or a nested
 * run carries content of its own — replacing the text alone would shift or lose
 * them. Such a run is still readable, it is simply not offered for editing.
 */
const BLOCKING = new Set(['br', 'tab', 'drawing', 'pict', 'object', 'fldChar', 'instrText', 'ruby']);

/** Finds every `w:r` element in the document, in order. */
export function findRuns(xml: string): RunSpan[] {
  const runs: RunSpan[] = [];
  /** The open runs; the innermost is last. Drawings can contain runs. */
  const open: { span: RunSpan; texts: RunSpan['text'][]; blocked: Set<string> }[] = [];
  let pendingText: { start: number; contentStart: number } | null = null;

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (local === 'r' && !tag.closing) {
      const span: RunSpan = { index: runs.length, start: tag.start, end: tag.end, text: null, refusal: null };
      runs.push(span);
      if (!tag.selfClosing) open.push({ span, texts: [], blocked: new Set() });
      else span.refusal = 'the run is empty';
      continue;
    }

    const current = open[open.length - 1];

    if (local === 'r' && tag.closing) {
      const finished = open.pop();
      if (!finished) continue;

      finished.span.end = tag.end;
      if (finished.blocked.size > 0) {
        finished.span.refusal = `contains ${[...finished.blocked].join(', ')}`;
      } else if (finished.texts.length === 0) {
        finished.span.refusal = 'the run has no text';
      } else if (finished.texts.length > 1) {
        // Word tends to split a word across several `w:t` after a spell check.
        finished.span.refusal = 'the text is split across several parts';
      } else {
        finished.span.text = finished.texts[0] ?? null;
      }

      // A run inside a run makes the outer one un-rewritable, as it carries foreign content.
      open[open.length - 1]?.blocked.add('a nested run');
      continue;
    }

    if (!current) continue;

    if (local === 't') {
      if (tag.closing) {
        if (pendingText) {
          current.texts.push({
            start: pendingText.start,
            end: tag.end,
            contentStart: pendingText.contentStart,
            contentEnd: tag.start,
          });
          pendingText = null;
        }
        continue;
      }
      if (tag.selfClosing) {
        // `<w:t/>` is empty text; content is inserted between the tags.
        current.texts.push({
          start: tag.start,
          end: tag.end,
          contentStart: tag.end,
          contentEnd: tag.end,
        });
        continue;
      }
      pendingText = { start: tag.start, contentStart: tag.end };
      continue;
    }

    if (!tag.closing && BLOCKING.has(local)) current.blocked.add(local);
  }

  return runs;
}

/* ── text ────────────────────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function unescapeXml(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

export function runText(xml: string, run: RunSpan): string {
  if (!run.text) return '';
  return unescapeXml(xml.slice(run.text.contentStart, run.text.contentEnd));
}

/* ── writing ─────────────────────────────────────────────────────────── */

export interface RunEdit {
  index: number;
  text: string;
}

/**
 * Writes the new texts into the document, changing only their ranges.
 *
 * The rewriting itself lives in `applyDocxEdits`, which does this and the new
 * paragraphs in one pass — two passes over the same offsets would be two chances
 * to move them under each other.
 */
export function applyRunEdits(xml: string, runs: RunSpan[], edits: RunEdit[]): string {
  return applyDocxEdits(xml, runs, edits);
}

/**
 * Assembles a new `.docx` with the edited text.
 *
 * Every other part of the archive passes through **untouched**: styles,
 * numbering, images, headers, metadata. Exactly one part changes, and inside it
 * exactly the ranges the user rewrote and the paragraphs they added.
 */
export function writeDocx(
  archive: Archive,
  runs: RunSpan[],
  xml: string,
  edits: RunEdit[],
  reshaping?: Reshaping,
): Uint8Array {
  const next: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(archive)) next[path] = data;
  next['word/document.xml'] = strToU8(applyDocxEdits(xml, runs, edits, reshaping));
  return zipSync(next);
}

/* ── odlomci ─────────────────────────────────────────────────────────── */

export interface ParagraphSpan {
  /** The ordinal among all `w:p` in the part, in document order. */
  index: number;
  start: number;
  end: number;
  /** The `w:pPr` element's range, when the paragraph carries one of its own. */
  props: { start: number; end: number } | null;
  /** The paragraph ends a section: its `w:pPr` holds a `w:sectPr`. */
  section: boolean;
  /** Why nothing may be inserted after this paragraph; `null` when it may. */
  refusal: string | null;
}

/**
 * The regions a paragraph can sit in.
 *
 * Only a direct child of `w:body` is offered, and the reason is not timidity: a
 * paragraph inside a table cell belongs to a grid whose row and column counts
 * are declared elsewhere, one inside a text box belongs to a drawing with its
 * own extents, and one inside `w:sdtContent` belongs to a content control whose
 * boundary a new sibling would cross. Each is a different problem with a
 * different answer, and answering them all at once is how a program comes to
 * corrupt a file it did not understand.
 */
const REGION = new Set([
  'body',
  'tc',
  'txbxContent',
  'sdtContent',
  'customXml',
  'hdr',
  'ftr',
  'footnote',
  'endnote',
  'comment',
  'p',
]);

/**
 * Finds every `w:p` in the part, with the range of its own properties.
 *
 * The ordinals count **every** paragraph, nested ones included, so an index is a
 * stable name for a paragraph regardless of what may be inserted after it. Which
 * of them a new paragraph may follow is a separate question, and `refusal`
 * answers it.
 */
export function findParagraphs(xml: string): ParagraphSpan[] {
  const paragraphs: ParagraphSpan[] = [];
  /** Every open element, so nesting is read rather than guessed. */
  const stack: { local: string; start: number }[] = [];
  /** The paragraphs currently open; the innermost is last. */
  const open: ParagraphSpan[] = [];

  const region = (): string => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const local = stack[i]!.local;
      if (REGION.has(local)) return local;
    }
    return '';
  };

  const begin = (start: number, end: number): ParagraphSpan => {
    const where = region();
    const span: ParagraphSpan = {
      index: paragraphs.length,
      start,
      end,
      props: null,
      section: false,
      refusal: where === 'body' ? null : 'the paragraph is not in the body of the document',
    };
    paragraphs.push(span);
    return span;
  };

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (tag.closing) {
      const popped = stack.pop();
      if (!popped) continue;
      if (popped.local === 'p') {
        const span = open.pop();
        if (span) span.end = tag.end;
      } else if (popped.local === 'pPr' && stack[stack.length - 1]?.local === 'p') {
        // `w:pPr` is the paragraph's own only when the paragraph is its parent.
        const span = open[open.length - 1];
        if (span) span.props = { start: popped.start, end: tag.end };
      }
      continue;
    }

    if (tag.selfClosing) {
      // `<w:p/>` is a complete empty paragraph, and `<w:sectPr/>` a section with defaults.
      if (local === 'p') begin(tag.start, tag.end);
      else if (local === 'sectPr' && stack[stack.length - 1]?.local === 'pPr') {
        const span = open[open.length - 1];
        if (span) span.section = true;
      }
      continue;
    }

    if (local === 'p') open.push(begin(tag.start, tag.end));
    else if (local === 'sectPr' && stack[stack.length - 1]?.local === 'pPr') {
      const span = open[open.length - 1];
      if (span) span.section = true;
    }
    stack.push({ local, start: tag.start });
  }

  return paragraphs;
}

/** The paragraph a run sits in, by containment; `null` for a run outside every paragraph. */
export function paragraphOfRun(paragraphs: ParagraphSpan[], run: RunSpan): ParagraphSpan | null {
  let innermost: ParagraphSpan | null = null;
  for (const span of paragraphs) {
    if (span.start > run.start) break;
    if (span.end >= run.end) innermost = span;
  }
  return innermost;
}

/* ── a new paragraph ─────────────────────────────────────────────────── */

/**
 * A paragraph that is not in the file yet.
 *
 * It is **a plan, not a write** — the shape [`editor-pdf`](../../editor-pdf/src/document.ts)
 * proved: *"page operations change nothing until a save — until then there is
 * only a plan."* Every step names a paragraph of the **original** part and is
 * applied to that original on every save, so saving twice writes the same file,
 * and changing your mind after a save is still possible. Nothing here shifts an
 * ordinal, because nothing here ever advances the document the ordinals count.
 */
export interface ParagraphInsert {
  /** The paragraph the new one follows, by its ordinal in the original part. */
  after: number;
  /** The text. A step with nothing in it is not written — see `applyDocxEdits`. */
  text: string;
}

/**
 * What a style hands on to the paragraph after it.
 *
 * This is the whole of "properties resolved rather than copied". A heading is
 * not a heading because of the bytes in its `w:pPr` — it is a heading because
 * its `w:pStyle` names a style in `word/styles.xml`, and that style says what
 * the **next** paragraph should be. Copying the bytes gives a second heading;
 * reading `w:next` gives what Word gives, which is body text.
 *
 * Over the 49 real documents this was measured on, 9 declare `w:next` at all —
 * 90 declarations, and every heading style among them hands on to body text:
 * `Naslov1 → Normal`, and in one file `Heading → Tijeloteksta`.
 */
export interface Succession {
  /** `styleId` to the style the following paragraph takes. */
  next: Map<string, string>;
  /** The default paragraph style; a `w:pStyle` naming it is dropped instead. */
  fallback: string;
}

export function readStyleSuccession(stylesXml: string | null): Succession {
  const next = new Map<string, string>();
  let fallback = '';
  if (!stylesXml) return { next, fallback };

  /* One pass over the styles, tracking the `w:style` currently open. Its own
     `w:styleId` is an attribute, and `w:next` and `w:default` are children. */
  let open: { id: string } | null = null;
  for (const tag of scanTags(stylesXml)) {
    const local = localName(tag.name);

    if (local === 'style') {
      if (tag.closing) {
        open = null;
        continue;
      }
      const type = tagAttr(stylesXml, tag, 'type');
      const id = tagAttr(stylesXml, tag, 'styleId');
      const paragraph = id && (type === 'paragraph' || type === null);
      /* The default is an attribute, so it is known before the element is —
         a `w:style` that closes itself still declares one. */
      if (paragraph && tagAttr(stylesXml, tag, 'default') === '1') fallback = id;
      open = paragraph && !tag.selfClosing ? { id } : null;
      continue;
    }

    if (!open || tag.closing) continue;
    if (local === 'next') {
      const val = tagAttr(stylesXml, tag, 'val');
      // A style that follows itself — a list item, a quote — says nothing new.
      if (val && val !== open.id) next.set(open.id, val);
    }
  }

  return { next, fallback };
}

/** The direct children of an element's range, by their own ranges. */
function childRanges(xml: string, outer: { start: number; end: number }): Tag[] {
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
 * Children of a `w:pPr` that must not be carried into a new paragraph.
 *
 * A `w:sectPr` says "the section ends here", and two paragraphs in a row saying
 * it is a section break nobody asked for. The other three are tracked-change
 * marks: copying them claims the reviewer who edited this document also made
 * this insertion, which is a lie about a person.
 *
 * Over 49 real documents `w:sectPr` appears inside a `w:pPr` three times, in one
 * file, and all three of those paragraphs are empty section markers with no text
 * — so this rule defends a rare case. The tracked-change names appear zero
 * times, which is a reason to keep the rule and not a reason to trust it.
 */
const NOT_INHERITED = new Set(['sectPr', 'pPrChange', 'ins', 'del']);

/**
 * And the same marks one level down, on the paragraph mark's own run properties.
 *
 * This is where a tracked insertion of a paragraph actually lives —
 * `w:pPr > w:rPr > w:ins` — so a rule that only swept the `w:pPr` would have
 * carried the record across while believing it had not.
 */
const TRACKED = new Set(['ins', 'del', 'rPrChange', 'moveFrom', 'moveTo']);

/** The prefix the file binds the WordprocessingML namespace to — usually `w`. */
function prefixOf(xml: string, at: { start: number }): string {
  const name = /^<\s*([A-Za-z_][\w.-]*):/.exec(xml.slice(at.start, at.start + 40));
  return name ? `${name[1]}:` : '';
}

/**
 * The last `w:r` of a paragraph — the formatting a person is continuing.
 *
 * Its **own** last run, not the last one anywhere inside it. A paragraph can
 * hold a drawing, and a drawing holds a text box with runs of its own; the
 * innermost of those is the formatting of a caption in a picture, which is not
 * the formatting of the line the cursor is on.
 */
function lastRunOf(xml: string, paragraph: ParagraphSpan, runs: RunSpan[]): RunSpan | null {
  const direct = childRanges(xml, paragraph).filter((child) => localName(child.name) === 'r');
  const own = direct[direct.length - 1];
  if (!own) return null;
  return runs.find((run) => run.start === own.start) ?? null;
}

/** An element's text with some of its direct children removed. */
function cutChildren(xml: string, outer: { start: number; end: number }, drop: Set<string>): string {
  const cuts = childRanges(xml, outer).filter((child) => drop.has(localName(child.name)));
  let text = xml.slice(outer.start, outer.end);
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, cut.start - outer.start) + text.slice(cut.end - outer.start);
  }
  return text;
}

/** The `w:rPr` of a run, as text, with a tracked-change record stripped out. */
function runProperties(xml: string, run: RunSpan | null): string {
  if (!run) return '';
  const first = childRanges(xml, run).find((child) => localName(child.name) === 'rPr');
  if (!first) return '';
  return cutChildren(xml, first, TRACKED);
}

/**
 * The markup for one new paragraph, resolved from the one it follows.
 *
 * Three things are taken from three different places, because a paragraph's
 * appearance genuinely lives in three places:
 *
 * - **the paragraph properties**, copied byte for byte from the source's own
 *   `w:pPr` — so indentation, alignment, spacing and list membership carry over
 *   exactly, which is what pressing Enter in Word does;
 * - **the style**, resolved through `w:next` rather than copied, so a new
 *   paragraph after a heading is body text and not a second heading;
 * - **the run formatting**, taken from the source's **last run**, because that
 *   is the formatting at the point the person is typing from. A heading whose
 *   size is direct formatting on its runs rather than in its style is the case
 *   that makes this necessary: copy only the `w:pPr` and the new text arrives at
 *   the document default, sitting under the title at half its size.
 */
export function paragraphMarkup(
  xml: string,
  paragraph: ParagraphSpan,
  runs: RunSpan[],
  succession: Succession,
  text: string,
  /* A paragraph joined onto the end of another is written with the other's
     properties, and a new one after it continues that line — so the line's
     properties and its last run can come from two different paragraphs. */
  like: ParagraphSpan = paragraph,
  lastRun: RunSpan | null = lastRunOf(xml, paragraph, runs),
): string {
  const w = prefixOf(xml, paragraph);

  let props = '';
  if (like.props) {
    const outer = like.props;

    /* Every change to the properties is collected first and applied from the
       end backwards, the same discipline the document itself is edited with.
       Doing it in two passes would mean relying on the schema's ordering to
       keep the offsets of one pass valid under the other — true today, and a
       thing to be right about rather than lucky about. */
    const cuts: { start: number; end: number; text: string }[] = [];

    for (const child of childRanges(xml, outer)) {
      const local = localName(child.name);

      if (NOT_INHERITED.has(local)) {
        cuts.push({ start: child.start, end: child.end, text: '' });
        continue;
      }

      if (local === 'rPr') {
        for (const mark of childRanges(xml, child)) {
          if (TRACKED.has(localName(mark.name))) {
            cuts.push({ start: mark.start, end: mark.end, text: '' });
          }
        }
        continue;
      }

      if (local === 'pStyle') {
        // The style the source hands on, rather than the style the source is.
        const heir = succession.next.get(tagAttr(xml, child, 'val') ?? '');
        if (heir === undefined) continue;
        cuts.push({
          start: child.start,
          end: child.end,
          text:
            heir === '' || heir === succession.fallback
              ? ''
              : xml
                  .slice(child.start, child.end)
                  .replace(/(\s[A-Za-z_][\w.-]*:val\s*=\s*)("[^"]*"|[^"\s>]*)/, `$1"${heir}"`),
        });
      }
    }

    props = xml.slice(outer.start, outer.end);
    for (const cut of cuts.sort((a, b) => b.start - a.start)) {
      props = props.slice(0, cut.start - outer.start) + cut.text + props.slice(cut.end - outer.start);
    }

    // A `w:pPr` emptied of everything is noise; leave it out entirely.
    if (emptied(props)) props = '';
  }

  const rPr = runProperties(xml, lastRun);
  const body = `<${w}r>${rPr}<${w}t xml:space="preserve">${escapeXml(text)}</${w}t></${w}r>`;
  return `<${w}p>${props}${body}</${w}p>`;
}

/* ── removing a paragraph ────────────────────────────────────────────── */

/**
 * Ranges that must not be torn in half.
 *
 * Each of these opens somewhere and closes somewhere else, matched by `w:id`,
 * and removing a paragraph that holds one end but not the other leaves the
 * survivor orphaned. For `permStart`/`permEnd` that is not cosmetic: measured
 * with Word itself, a protected document whose `permEnd` is removed loses the
 * editable region on a paragraph the person never touched — Word discards the
 * unmatched half and the permission with it. Bookmarks are deliberately **not**
 * here: the same measurement showed Word opens a file with an orphaned
 * bookmark half cleanly, and the corpus is full of Word's own `_GoBack`.
 */
const PAIRED = [
  ['permStart', 'permEnd'],
  ['moveFromRangeStart', 'moveFromRangeEnd'],
  ['moveToRangeStart', 'moveToRangeEnd'],
  ['commentRangeStart', 'commentRangeEnd'],
] as const;

/**
 * Marks that may sit between two body paragraphs without being content.
 *
 * The question they answer is "would the document end with something that is
 * not a paragraph" — a bookmark half or a proofing mark between paragraphs is
 * an annotation of a place, not a block, and five real files keep a body-level
 * `bookmarkEnd` there. Anything else — a table, a content control — is content,
 * and a document may not end on it.
 */
const RANGE_MARKS = new Set([
  'bookmarkStart',
  'bookmarkEnd',
  'proofErr',
  'permStart',
  'permEnd',
  'moveFromRangeStart',
  'moveFromRangeEnd',
  'moveToRangeStart',
  'moveToRangeEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'customXmlInsRangeStart',
  'customXmlInsRangeEnd',
  'customXmlDelRangeStart',
  'customXmlDelRangeEnd',
]);

/** Whether anything that is genuinely content opens between two offsets. */
function blockContentBetween(xml: string, from: number, to: number): boolean {
  if (from >= to) return false;
  for (const tag of scanTags(xml.slice(from, to))) {
    if (!tag.closing && !RANGE_MARKS.has(localName(tag.name))) return true;
  }
  return false;
}

/** Whether a table opens between two offsets. */
function tableBetween(xml: string, from: number, to: number): boolean {
  if (from >= to) return false;
  for (const tag of scanTags(xml.slice(from, to))) {
    if (!tag.closing && localName(tag.name) === 'tbl') return true;
  }
  return false;
}

/**
 * Why this paragraph may not be removed; `null` when it may.
 *
 * The rules, each measured rather than argued:
 *
 * - **Only a body paragraph** — the boundary insertion keeps, kept here too.
 * - **Not a section marker.** A `w:pPr` holding `w:sectPr` is where a section
 *   ends; removing it rewires the page layout of everything before it.
 * - **Not half a field.** Over 1263 real body paragraphs no field crosses the
 *   boundary, so this defends a rare case — a reason to keep the rule, not a
 *   reason to trust it.
 * - **Not half a protected or tracked range** — see `PAIRED`.
 * - **Not the paragraph keeping two tables apart.** Word treats adjacent
 *   body-level tables as one: measured over COM, `Tables.Count` goes from 2 to
 *   1, while the preview here would keep showing two. Twelve real paragraphs
 *   sit in that sandwich.
 * - **Not the last paragraph standing.** Judged against `survivors` — the body
 *   paragraphs the plan still keeps — not against the file as opened, because
 *   taking them one at a time must not reach a place a single step refuses.
 *   And not the last one before the body's tail either: a document that would
 *   end on a table, or whose final section would be emptied, gets the missing
 *   paragraph silently resurrected by Word — measured, the paragraph count
 *   comes back unchanged — so the file written would not be the file read.
 */
export function removalRefusal(
  xml: string,
  paragraphs: ParagraphSpan[],
  index: number,
  survivors?: ReadonlySet<number>,
): string | null {
  const span = paragraphs.find((one) => one.index === index);
  if (!span) return 'there is no such paragraph';
  if (span.refusal) return span.refusal;
  if (span.section) return 'the paragraph ends a section';

  let begins = 0;
  let ends = 0;
  const halves = new Map<string, { starts: Set<string>; ends: Set<string> }>();
  for (const raw of scanTags(xml.slice(span.start, span.end))) {
    if (raw.closing) continue;
    const local = localName(raw.name);
    const tag = { start: raw.start + span.start, end: raw.end + span.start };
    if (local === 'fldChar') {
      const kind = tagAttr(xml, tag, 'fldCharType');
      if (kind === 'begin') begins++;
      else if (kind === 'end') ends++;
      continue;
    }
    for (const [open, close] of PAIRED) {
      if (local !== open && local !== close) continue;
      const pair = halves.get(open) ?? { starts: new Set<string>(), ends: new Set<string>() };
      (local === open ? pair.starts : pair.ends).add(tagAttr(xml, tag, 'id') ?? '');
      halves.set(open, pair);
    }
  }
  if (begins !== ends) return 'a field begins or ends here and continues elsewhere';
  for (const pair of halves.values()) {
    const crossed =
      [...pair.starts].some((id) => !pair.ends.has(id)) ||
      [...pair.ends].some((id) => !pair.starts.has(id));
    if (crossed) return 'a marked stretch continues outside the paragraph';
  }

  const body = paragraphs.filter((one) => one.refusal === null);
  const alive = survivors ?? new Set(body.map((one) => one.index));
  if (!alive.has(index)) return 'there is no such paragraph';

  /* The nearest body paragraphs the plan still keeps, on either side. Nothing
     before the body holds a `w:tbl`, so scanning from 0 when none survives on
     the left asks the right question anyway. */
  let before: ParagraphSpan | null = null;
  let after: ParagraphSpan | null = null;
  for (const one of body) {
    if (!alive.has(one.index) || one.index === index) continue;
    if (one.index < index) before = one;
    else if (!after) after = one;
  }

  if (!before && !after) return 'the last paragraph of the document';

  if (
    after &&
    tableBetween(xml, before ? before.end : 0, span.start) &&
    tableBetween(xml, span.end, after.start)
  ) {
    return 'the paragraph keeps two tables apart';
  }

  if (!after && (before!.section || blockContentBetween(xml, before!.end, span.start))) {
    return 'the document would end without a paragraph';
  }

  return null;
}

/* ── splitting a paragraph ───────────────────────────────────────────── */

/** Whether every field opened within `[from, to)` also closes within it, and the reverse. */
function fieldsBalanced(xml: string, from: number, to: number): boolean {
  let begins = 0;
  let ends = 0;
  for (const raw of scanTags(xml.slice(from, to))) {
    if (raw.closing || localName(raw.name) !== 'fldChar') continue;
    const kind = tagAttr(xml, { start: raw.start + from, end: raw.end + from }, 'fldCharType');
    if (kind === 'begin') begins++;
    else if (kind === 'end') ends++;
  }
  return begins === ends;
}

/** Whether every paired range (see `PAIRED`) opened within `[from, to)` also closes within it. */
function rangesBalanced(xml: string, from: number, to: number): boolean {
  const halves = new Map<string, { starts: Set<string>; ends: Set<string> }>();
  for (const raw of scanTags(xml.slice(from, to))) {
    if (raw.closing) continue;
    const local = localName(raw.name);
    for (const [open, close] of PAIRED) {
      if (local !== open && local !== close) continue;
      const tag = { start: raw.start + from, end: raw.end + from };
      const pair = halves.get(open) ?? { starts: new Set<string>(), ends: new Set<string>() };
      (local === open ? pair.starts : pair.ends).add(tagAttr(xml, tag, 'id') ?? '');
      halves.set(open, pair);
    }
  }
  for (const pair of halves.values()) {
    if ([...pair.starts].some((id) => !pair.ends.has(id))) return false;
    if ([...pair.ends].some((id) => !pair.starts.has(id))) return false;
  }
  return true;
}

/**
 * A run of the original part divided into pieces, each after the first
 * opening a paragraph of its own — which is what Enter does in the middle of
 * a sentence.
 *
 * `run` names a run of the **original** part and stays valid for the life of
 * the document, the same guarantee `ParagraphInsert.after` makes. `parts` is
 * its text in order: the first stays where the run stands, and every later
 * one begins a new paragraph carrying the run's own formatting and the
 * paragraph's own properties — both halves of a split heading are headings,
 * both halves of a list item are list items. Everything that followed the
 * run in its paragraph goes with the last part. The texts are carried rather
 * than the offsets that first divided them, because each piece can be
 * retyped afterwards on its own.
 */
export interface RunCut {
  run: number;
  parts: string[];
}

/**
 * Whether a run is a direct child of its paragraph.
 *
 * A cut closes the run and the paragraph where it falls and opens a new pair,
 * so anything else still open at that point — a `w:hyperlink`, an inline
 * content control, a tracked insertion's `w:ins`, a `w:fldSimple` — would be
 * opened in one paragraph and closed in the next, which is not XML. Such a
 * run is left whole.
 */
function directChild(xml: string, paragraph: ParagraphSpan, run: RunSpan): boolean {
  let depth = 0;
  for (const tag of scanTags(xml.slice(paragraph.start, run.start))) {
    if (tag.selfClosing) continue;
    depth += tag.closing ? -1 : 1;
  }
  return depth === 1;
}

/**
 * A `w:pPr` copied byte for byte, less what must not be copied — a section
 * break, and the tracked-change marks that would claim a reviewer made a
 * paragraph they never saw.
 *
 * The style is **not** resolved through `w:next`, and that is the difference
 * between copying properties and writing a new paragraph after another: Word
 * keeps both halves of a heading divided mid-sentence a heading, and gives a
 * row added under a cell styled `Heading 1` a cell styled `Heading 1` —
 * measured, both.
 */
function inheritedProps(xml: string, outer: { start: number; end: number } | null): string {
  if (!outer) return '';
  const cuts: { start: number; end: number }[] = [];
  for (const child of childRanges(xml, outer)) {
    const local = localName(child.name);
    if (NOT_INHERITED.has(local)) {
      cuts.push(child);
      continue;
    }
    if (local === 'rPr') {
      for (const mark of childRanges(xml, child)) {
        if (TRACKED.has(localName(mark.name))) cuts.push(mark);
      }
    }
  }
  let props = xml.slice(outer.start, outer.end);
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    props = props.slice(0, cut.start - outer.start) + props.slice(cut.end - outer.start);
  }
  return props;
}

/** The paragraph properties a new piece of a split paragraph carries: its own. */
function splitProps(xml: string, paragraph: ParagraphSpan): string {
  return inheritedProps(xml, paragraph.props);
}

/** An element written with nothing inside it — `<w:trPr></w:trPr>` or `<w:trPr/>`, which is noise either way. */
function emptied(markup: string): boolean {
  return markup.length === 0 || /^<[^>]*\/>$/.test(markup) || /^<[^>]*>\s*<\/[^>]*>$/.test(markup);
}

/**
 * Why the paragraph a run sits in may not be divided at that run; `null` when
 * it may.
 *
 * Unlike `removalRefusal`, the offset within the run's own text never matters:
 * a division falls inside the run, so which side of it everything else lands
 * on is decided by the run alone. A field or a marked stretch must close on
 * the side it opened, or the cut leaves half of it in each paragraph — which
 * is also what refuses a field's own result run, the case the design for
 * paragraph insertion first found: its `begin` is behind it and its `end`
 * ahead. A section-ending paragraph is refused outright rather than divided:
 * Word moves the `w:sectPr` to whichever piece ends up last, which means
 * rewriting the properties the first piece keeps, and three of the 49 real
 * documents hold one at all — a rare case not worth a page layout.
 */
export function splitRefusal(xml: string, paragraphs: ParagraphSpan[], run: RunSpan): string | null {
  const paragraph = paragraphOfRun(paragraphs, run);
  if (!paragraph || paragraph.refusal) {
    return paragraph?.refusal ?? 'the paragraph is not in the body of the document';
  }
  if (paragraph.section) return 'the paragraph ends a section';
  if (!directChild(xml, paragraph, run)) return 'the run is inside an element a cut would tear in two';
  if (!fieldsBalanced(xml, paragraph.start, run.start) || !fieldsBalanced(xml, run.end, paragraph.end)) {
    return 'a field begins or ends here and continues elsewhere';
  }
  if (!rangesBalanced(xml, paragraph.start, run.start) || !rangesBalanced(xml, run.end, paragraph.end)) {
    return 'a marked stretch continues outside the paragraph';
  }
  return null;
}

/* ── joining two paragraphs ──────────────────────────────────────────── */

/**
 * Where a paragraph's content lies — after its opening tag and its own
 * properties, up to its closing tag. Word writes an empty paragraph as
 * `<w:p/>`, which has neither, and is given an empty range at its end.
 */
interface Inside {
  start: number;
  end: number;
  selfClosing: boolean;
}

function insideOf(xml: string, paragraph: ParagraphSpan): Inside {
  const open = scanTags(xml.slice(paragraph.start, paragraph.end)).next().value;
  if (!open || open.selfClosing) return { start: paragraph.end, end: paragraph.end, selfClosing: true };
  /* The properties are the first child when there are any — `<w:pPr/>` too,
     which `findParagraphs` does not record and which must not be carried
     into the middle of another paragraph. */
  const first = childRanges(xml, paragraph)[0];
  return {
    start: first && localName(first.name) === 'pPr' ? first.end : paragraph.start + open.end,
    end: xml.lastIndexOf('<', paragraph.end - 1),
    selfClosing: false,
  };
}

/**
 * Whether a stretch of a paragraph shows nothing Word counts as a character,
 * as the plan leaves it.
 *
 * Measured with Word over COM, Backspace at the start of a paragraph each way:
 * a paragraph holding only a bookmark, a proofing mark, a run with nothing but
 * its formatting, an empty text element or the page break Word remembers from
 * its last layout is empty to it — the join deletes it, bookmark and all, and
 * the paragraph below keeps its own properties. A tab or a single space is
 * not. Anything this does not recognise counts as something, so an element
 * nobody listed can only ever make a paragraph count as holding text.
 */
function showsNothingIn(
  xml: string,
  from: number,
  to: number,
  byText: ReadonlyMap<number, RunSpan>,
  typed: ReadonlyMap<number, string>,
): boolean {
  /* Inside a `w:rPr`: how text looks, not what it is. Counted by depth,
     because a tracked formatting change holds a `w:rPr` of its own. */
  let skip = 0;
  for (const tag of scanTags(xml.slice(from, to))) {
    const local = localName(tag.name);
    if (skip > 0) {
      if (!tag.selfClosing) skip += tag.closing ? -1 : 1;
      continue;
    }
    if (tag.closing) continue;
    if (local === 'rPr') {
      if (!tag.selfClosing) skip = 1;
      continue;
    }
    if (local === 'r' || local === 'lastRenderedPageBreak' || RANGE_MARKS.has(local)) continue;
    if (local === 't') {
      if (tag.selfClosing) continue;
      const run = byText.get(from + tag.start);
      const text = run
        ? (typed.get(run.index) ?? runText(xml, run))
        : unescapeXml(xml.slice(from + tag.end, xml.indexOf('<', from + tag.end)));
      if (text.length > 0) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Whether a paragraph shows nothing Word counts as a character — with the
 * rewrites of its runs as the plan holds them, because a line whose text was
 * typed away is as empty to the person looking at it as one that never had
 * any.
 */
export function showsNothing(
  xml: string,
  paragraph: ParagraphSpan,
  runs: RunSpan[],
  edits: ReadonlyMap<number, string> = new Map(),
): boolean {
  const inside = insideOf(xml, paragraph);
  const byText = new Map(runs.filter((run) => run.text).map((run) => [run.text!.start, run]));
  return showsNothingIn(xml, inside.start, inside.end, byText, edits);
}

/**
 * The next paragraph of the body the plan keeps, and what stands between.
 *
 * A paragraph the plan removes is taken with the boundary rather than kept
 * beside it — Backspace twice after a blank line removes the line and then
 * joins across where it was. The range marks between two paragraphs are the
 * only other thing allowed there: Word itself carries a body-level
 * `w:bookmarkEnd` into the joined paragraph, at the join, and that is where it
 * goes here.
 */
function partnerOf(
  xml: string,
  body: ParagraphSpan[],
  span: ParagraphSpan,
  alive: ReadonlySet<number>,
): { next: ParagraphSpan; gap: string } | string {
  let gap = '';
  let from = span.end;
  for (const one of body) {
    if (one.index <= span.index) continue;
    if (blockContentBetween(xml, from, one.start)) return 'something stands between the two paragraphs';
    gap += xml.slice(from, one.start);
    if (alive.has(one.index)) return { next: one, gap };
    from = one.end;
  }
  return 'nothing follows the paragraph';
}

/** Whether a tracked change is recorded on a paragraph's mark — in its `w:pPr`, or in the mark's own `w:rPr`. */
function markRecorded(xml: string, span: ParagraphSpan): boolean {
  if (!span.props) return false;
  return childRanges(xml, span.props).some((child) => {
    const local = localName(child.name);
    if (local === 'pPrChange' || local === 'ins' || local === 'del') return true;
    return local === 'rPr' && childRanges(xml, child).some((mark) => TRACKED.has(localName(mark.name)));
  });
}

/**
 * Why a paragraph may not be joined with the next one the plan keeps — what
 * Delete does at the end of it, and Backspace at the start of the next;
 * `null` when it may.
 *
 * Joining tears nothing: a field or a comment that ran from one paragraph
 * into the next ends up inside one, which is better than it was. What it can
 * do is move a boundary somebody else's layout hangs on, and those are the
 * refusals:
 *
 * - **Only two body paragraphs**, with nothing between them but range marks
 *   and paragraphs the plan removes. A table between them is not a thing a
 *   join can pass, and neither is a block-level content control, which this
 *   view does not draw — the check is on the bytes, not on what is shown.
 * - **Not a section's end, on either side.** The joined paragraph keeps the
 *   first one's properties, so the second's `w:sectPr` would go and the first's
 *   would move past text that was in the next section.
 * - **Not a tracked change recorded on either paragraph's mark.** The mark
 *   between them is the one the join deletes, and a record claiming a reviewer
 *   inserted or formatted it would be left describing a different one.
 */
export function joinRefusal(
  xml: string,
  paragraphs: ParagraphSpan[],
  index: number,
  survivors?: ReadonlySet<number>,
): string | null {
  const span = paragraphs.find((one) => one.index === index);
  if (!span) return 'there is no such paragraph';
  if (span.refusal) return span.refusal;
  const body = paragraphs.filter((one) => one.refusal === null);
  const alive = survivors ?? new Set(body.map((one) => one.index));
  if (!alive.has(index)) return 'there is no such paragraph';

  const pair = partnerOf(xml, body, span, alive);
  if (typeof pair === 'string') return pair;
  if (span.section || pair.next.section) return 'the paragraph ends a section';
  if (markRecorded(xml, span) || markRecorded(xml, pair.next)) {
    return 'a tracked change is recorded where the paragraphs meet';
  }
  return null;
}

/**
 * Whether two paragraphs would write a new line with the same properties.
 *
 * A join gives the lines after it the first paragraph's properties where they
 * had the second's, and Word, doing the same things one after another, would
 * have left the lines made before the join as they were. Where the two are
 * the same bytes, nobody can tell which happened — and over the real corpus
 * adjacent body paragraphs mostly are.
 */
export function propertiesAlike(xml: string, a: ParagraphSpan, b: ParagraphSpan): boolean {
  return splitProps(xml, a) === splitProps(xml, b);
}

/** The run a new paragraph after this one takes its formatting from; `null` when it has none of its own. */
export function continuedRun(xml: string, paragraph: ParagraphSpan, runs: RunSpan[]): RunSpan | null {
  return lastRunOf(xml, paragraph, runs);
}

/* ── a new row in a table ────────────────────────────────────────────── */

export interface RowSpan {
  /** The ordinal among all `w:tr` in the part, in document order. */
  index: number;
  start: number;
  end: number;
  /** Where the table this row belongs to begins; the rows of one table share it. */
  table: number;
  /** Why no new row may follow this one; `null` when one may. */
  refusal: string | null;
}

/**
 * What may stand between a row and the body of the document.
 *
 * A table inside a table is still a table: its grid is declared by its own
 * `w:tblGrid`, its rows hold its own cells, and Word adds a row to it exactly
 * as it does to any other — measured. A table inside a text box, a header, a
 * footnote or a content control is a different question, each with its own
 * answer, and none of them is this one.
 */
const ROW_REGION = new Set(['tbl', 'tr', 'tc']);

/**
 * Finds every `w:tr` in the part, in document order.
 *
 * The ordinals count **every** row, the rows of nested tables included, so an
 * index is a stable name for a row for the life of the document — the same
 * promise `findParagraphs` makes, and for the same reason: a row added after
 * the wrong one is worse than no row at all.
 */
export function findRows(xml: string): RowSpan[] {
  const rows: RowSpan[] = [];
  /** Every open element, so nesting is read rather than guessed. */
  const stack: { local: string; start: number }[] = [];
  /** The rows currently open; the innermost is last. */
  const open: RowSpan[] = [];

  const begin = (start: number, end: number): RowSpan => {
    const parent = stack[stack.length - 1];
    /* The row's own table, and then out through whatever holds it: only
       tables, rows and cells may stand between it and the body. */
    let where = '';
    for (let i = stack.length - 1; i >= 0; i--) {
      const local = stack[i]!.local;
      if (ROW_REGION.has(local)) continue;
      where = local;
      break;
    }
    const span: RowSpan = {
      index: rows.length,
      start,
      end,
      table: parent?.local === 'tbl' ? parent.start : -1,
      refusal:
        parent?.local !== 'tbl'
          ? 'the row is not a row of a table'
          : where === 'body'
            ? null
            : 'the table is not in the body of the document',
    };
    rows.push(span);
    return span;
  };

  for (const tag of scanTags(xml)) {
    const local = localName(tag.name);

    if (tag.closing) {
      const popped = stack.pop();
      if (popped?.local === 'tr') {
        const span = open.pop();
        if (span) span.end = tag.end;
      }
      continue;
    }

    if (tag.selfClosing) {
      /* `<w:tr/>` is a row with no cells at all. It is counted, because the
         ordinals have to match the view's, and refused by the rule that
         refuses any row with no cells to copy. */
      if (local === 'tr') begin(tag.start, tag.end);
      continue;
    }

    if (local === 'tr') open.push(begin(tag.start, tag.end));
    stack.push({ local, start: tag.start });
  }

  return rows;
}

/** The cells of a row — its own `w:tc` children, never a nested table's. */
function cellsOf(xml: string, row: RowSpan): Tag[] {
  return childRanges(xml, row).filter((child) => localName(child.name) === 'tc');
}

/** Whether a cell carries on a vertical merge begun in a row above it. */
function continuesMerge(xml: string, cell: Tag): boolean {
  const props = childRanges(xml, cell).find((child) => localName(child.name) === 'tcPr');
  if (!props) return false;
  const merge = childRanges(xml, props).find((child) => localName(child.name) === 'vMerge');
  return merge !== undefined && (tagAttr(xml, merge, 'val') ?? 'continue') !== 'restart';
}

/** The next row of the same table; `null` at its end. A nested table's rows are not its own. */
function nextRow(rows: RowSpan[], row: RowSpan): RowSpan | null {
  for (let i = row.index + 1; i < rows.length; i++) {
    const one = rows[i]!;
    if (one.table === row.table) return one;
    if (one.start > row.end) return null;
  }
  return null;
}

/**
 * The row a new one actually follows.
 *
 * Word puts it **below the last row a vertical merge covers**, not inside the
 * merge: measured over COM, a row asked for below a cell merged down two rows
 * arrives below both of them, and the merge is left exactly as it was. That
 * is not Word being clever about tables — a merged cell genuinely stands in
 * every row it spans, so "below this row" means below the last of them. A new
 * row written between the two halves of a merge would leave a `w:vMerge`
 * carrying on from a row that no longer starts one.
 */
export function anchorRow(xml: string, rows: RowSpan[], row: RowSpan): RowSpan {
  let at = row;
  for (let next = nextRow(rows, at); next !== null; next = nextRow(rows, at)) {
    if (!cellsOf(xml, next).some((cell) => continuesMerge(xml, cell))) break;
    at = next;
  }
  return at;
}

/** Children of a `w:trPr` that must not be carried into a new row — a row Word records as inserted or deleted. */
const ROW_NOT_INHERITED = new Set(['ins', 'del', 'trPrChange']);

/**
 * And of a `w:tcPr`: the vertical merge, which the new cell is not part of —
 * measured, Word writes the cell below a merged one unmerged — and the marks
 * recording a change to the cell this one is only a copy of.
 */
const CELL_NOT_INHERITED = new Set(['vMerge', 'tcPrChange', 'cellIns', 'cellDel', 'cellMerge']);

/** Whether a tracked change is recorded on a row's own mark. */
function rowRecorded(xml: string, row: RowSpan): boolean {
  const props = childRanges(xml, row).find((child) => localName(child.name) === 'trPr');
  return props !== undefined && childRanges(xml, props).some((mark) => ROW_NOT_INHERITED.has(localName(mark.name)));
}

/**
 * Why no new row may follow this one; `null` when one may.
 *
 * - **Only a row of a table in the body**, nested tables included — see
 *   `ROW_REGION`.
 * - **Not a row with no cells**, which has no structure to copy.
 * - **Not a row a tracked change is recorded on.** `w:trPr > w:ins` is how
 *   Word records a row somebody inserted with track changes on; copying it
 *   would claim that reviewer inserted this one too.
 *
 * Asked of the row the new one would follow as well as of the row the cursor
 * is in, because a merge makes those two different rows.
 */
export function rowRefusal(xml: string, rows: RowSpan[], index: number): string | null {
  const span = rows.find((one) => one.index === index);
  if (!span) return 'there is no such row';
  if (span.refusal) return span.refusal;
  const anchor = anchorRow(xml, rows, span);
  if (anchor.refusal) return anchor.refusal;
  if (cellsOf(xml, anchor).length === 0) return 'the row has no cells';
  if (rowRecorded(xml, span) || rowRecorded(xml, anchor)) return 'a tracked change is recorded on the row';
  return null;
}

/** The `w:rPr` of a paragraph mark — the formatting Word gives text typed into that paragraph. */
function markProperties(xml: string, props: { start: number; end: number } | null): string {
  if (!props) return '';
  const first = childRanges(xml, props).find((child) => localName(child.name) === 'rPr');
  return first ? cutChildren(xml, first, TRACKED) : '';
}

/** How wide each cell of a row is, in columns of the table's grid. */
export function rowShape(xml: string, row: RowSpan): number[] {
  return cellsOf(xml, row).map((cell) => {
    const props = childRanges(xml, cell).find((child) => localName(child.name) === 'tcPr');
    const span = props ? childRanges(xml, props).find((child) => localName(child.name) === 'gridSpan') : undefined;
    return span ? Math.max(1, Number(tagAttr(xml, span, 'val') ?? 1) || 1) : 1;
  });
}

/** One cell of a new row: the cell above it, emptied, with whatever was typed into it. */
function cellMarkup(xml: string, cell: Tag, text: string, w: string): string {
  const inside = childRanges(xml, cell);
  const props = inside.find((child) => localName(child.name) === 'tcPr');
  const first = inside.find((child) => localName(child.name) === 'p');

  const tcPr = props ? cutChildren(xml, props, CELL_NOT_INHERITED) : '';
  /* The cell's own first paragraph — its own, never one inside a table the
     cell holds, which belongs to a grid of its own. */
  const own = first ? (childRanges(xml, first).find((child) => localName(child.name) === 'pPr') ?? null) : null;
  const pPr = inheritedProps(xml, own);
  /* Text typed into the new cell takes the paragraph mark's formatting, which
     is what Word gives it — measured: a row added under a bold heading row
     writes `<w:r><w:rPr><w:b/></w:rPr>` around what is typed there. */
  const body =
    text.length > 0
      ? `<${w}r>${markProperties(xml, own)}<${w}t xml:space="preserve">${escapeXml(text)}</${w}t></${w}r>`
      : '';
  const paragraph = emptied(pPr) && body === '' ? `<${w}p/>` : `<${w}p>${emptied(pPr) ? '' : pPr}${body}</${w}p>`;
  return `<${w}tc>${emptied(tcPr) ? '' : tcPr}${paragraph}</${w}tc>`;
}

/**
 * The markup for one new row: **the row above it, emptied of its content.**
 *
 * That sentence is Word's, not a guess. Asked over COM on rows Word had made
 * itself — a heading row, a row with a fixed height that may not break across
 * pages, a row of cells with a shading, a width, a horizontal merge, a
 * centred paragraph, a list, a `Heading 1` style — Word's own inserted row
 * carries every one of them and nothing else: the `w:tblPrEx`, the `w:trPr`,
 * each cell's `w:tcPr`, and each cell's first paragraph's `w:pPr`, each byte
 * for byte. What it does not carry is content: no runs, no bookmarks, no
 * drawings, and no vertical merge. A cell whose paragraph had no properties
 * of its own is written `<w:p/>`, which is what Word writes there.
 */
export function rowMarkup(xml: string, row: RowSpan, cells: readonly string[]): string {
  const w = prefixOf(xml, row);
  let out = '';
  let at = 0;

  for (const child of childRanges(xml, row)) {
    const local = localName(child.name);
    if (local === 'tblPrEx') {
      out += xml.slice(child.start, child.end);
      continue;
    }
    if (local === 'trPr') {
      const props = cutChildren(xml, child, ROW_NOT_INHERITED);
      if (!emptied(props)) out += props;
      continue;
    }
    if (local === 'tc') out += cellMarkup(xml, child, cells[at++] ?? '', w);
  }

  return `<${w}tr>${out}</${w}tr>`;
}

/**
 * A row that is not in the file yet.
 *
 * The same kind of plan as `ParagraphInsert`, over a different unit: `after`
 * names a row of the **original** part and stays valid for the life of the
 * document, and `cells` is what was typed into each cell of the new row, in
 * order. A row nobody typed into anywhere is a row nobody added — the rule a
 * new paragraph keeps, for the same reason.
 */
export interface TableRowInsert {
  after: number;
  cells: string[];
}

/** Everything a save needs to know about the paragraphs the plan reshapes. */
export interface Reshaping {
  paragraphs: ParagraphSpan[];
  succession: Succession;
  inserts: ParagraphInsert[];
  /** Ordinals of paragraphs of the original part the plan removes. */
  removals?: number[];
  /** The runs the plan divides, each piece after the first a paragraph of its own. */
  cuts?: RunCut[];
  /**
   * Ordinals of paragraphs of the original part the plan joins with the next
   * paragraph it keeps — the boundary between them taken away, the joined
   * paragraph keeping the first one's properties, as Word keeps them.
   */
  joins?: number[];
  /** The rows of the original part, for the new rows to name and be copied from. */
  rows?: RowSpan[];
  /** The rows the plan adds to a table, each after a row of the original part. */
  rowInserts?: TableRowInsert[];
}

/**
 * Every rewrite, every new paragraph, every removal, every division, every
 * join and every new table row, written into the original in one pass.
 *
 * Back to front, so no offset moves under the next operation. Two new
 * paragraphs after the same one keep the order they were added in: at an equal
 * offset the later step is written first, which leaves it second on the page.
 *
 * **At an equal offset, a removal goes before an insertion.** The case is the
 * normal one, not a corner: 1187 of 1214 consecutive body paragraphs in the
 * real corpus touch with not a byte between them, so inserting after one
 * paragraph and removing the next puts both operations at the same offset. The
 * removal consumes a range and the insertion consumes nothing; applied the
 * other way round, the removal's range would cut the head off the markup the
 * insertion just wrote. Measured both ways over the 45 real files that have
 * such a pair: this order is byte-exact in all 45, the other wrong in all 45.
 *
 * **A step with no text is not written.** An empty new paragraph is one the
 * person could never click into again — it draws as a blank line with no run
 * inside it, and the way back into editing is a run. Rather than leave that trap
 * in somebody's document, a paragraph nobody typed into is a paragraph nobody
 * added.
 *
 * **The removals are re-judged here**, against the survivors of the removals
 * before them, in ordinal order — the writer enforces the policy, not only the
 * view above it. A duplicate ordinal, an ordinal that would empty the body, an
 * ordinal whose paragraph a single-step rule refuses: each is skipped rather
 * than trusted, because a caller of this function is not obliged to have asked
 * first. And a rewrite whose run sits inside a removed paragraph — a caption in
 * a text box the paragraph carries included — is dropped with the paragraph:
 * two operations over the same bytes is how offsets move under each other.
 */
export function applyDocxEdits(
  xml: string,
  runs: RunSpan[],
  edits: RunEdit[],
  reshaping?: Reshaping,
): string {
  const byIndex = new Map(runs.map((run) => [run.index, run]));

  const operations: { at: number; end: number; text: string; order: number }[] = [];

  /*
   * The removals are settled first because the rewrites and the insertions
   * both need to know about them — but their operations are pushed **last**,
   * deliberately. A stable sort would otherwise leave them ahead of a
   * colliding insertion by accident of the order they were added in, and the
   * tie-break below would be correct without ever being load-bearing. Code
   * that is right for a reason nobody can break is code nobody can check.
   */
  const removed: ParagraphSpan[] = [];
  if (reshaping?.removals?.length) {
    const body = reshaping.paragraphs.filter((span) => span.refusal === null);
    const alive = new Set(body.map((span) => span.index));
    /* Ascending, so each is judged against what the ones before it left. An
       ordinal repeated is refused the second time round by the same rule that
       judges every other: it is no longer among the survivors. */
    for (const index of [...reshaping.removals].sort((a, b) => a - b)) {
      if (removalRefusal(xml, reshaping.paragraphs, index, alive) !== null) continue;
      alive.delete(index);
      const span = reshaping.paragraphs.find((one) => one.index === index);
      if (span) removed.push(span);
    }
  }

  /*
   * The cuts are settled next, for the same reason: everything after them has
   * to know which bytes they claim. A divided paragraph is rewritten as ONE
   * operation, from inside its first divided run to its own end, so nothing
   * else may touch that range — the byte-range technique requires operations
   * not to overlap. A rewrite of an ordinary run inside it is applied within
   * the cut's own text instead; a paragraph a removal takes is not divided as
   * well; a run named twice is divided once, and a cut with fewer than two
   * parts is no cut. Each is re-judged against the original, because a caller
   * is not obliged to have asked first.
   */
  const cutByRun = new Map<number, RunCut>();
  const divided = new Map<number, RunSpan[]>();
  const paragraphByIndex = new Map((reshaping?.paragraphs ?? []).map((span) => [span.index, span]));
  for (const cut of reshaping?.cuts ?? []) {
    const run = byIndex.get(cut.run);
    if (!run?.text || run.refusal || cut.parts.length < 2 || cutByRun.has(cut.run)) continue;
    const paragraph = paragraphOfRun(reshaping!.paragraphs, run);
    if (!paragraph) continue;
    if (removed.some((span) => paragraph.start >= span.start && paragraph.end <= span.end)) continue;
    if (splitRefusal(xml, reshaping!.paragraphs, run) !== null) continue;
    cutByRun.set(cut.run, cut);
    divided.set(paragraph.index, [...(divided.get(paragraph.index) ?? []), run]);
  }
  const claimed = [...divided].map(([index, cut]) => ({
    from: Math.min(...cut.map((run) => run.text!.start)),
    to: paragraphByIndex.get(index)!.end,
  }));

  const typed = new Map(edits.map((edit) => [edit.index, edit.text]));
  const byText = new Map(runs.filter((run) => run.text).map((run) => [run.text!.start, run]));

  /*
   * The joins are settled after the cuts, because what the line before a
   * boundary shows depends on how the cuts left it, and in ordinal order, so
   * a chain of them — Delete, Delete — is judged link by link against the
   * links before it. Each is re-judged against the original and the plan's
   * survivors, because a caller is not obliged to have asked first; and each
   * yields to a paragraph the plan adds after its first paragraph, or after
   * one its boundary takes, since that paragraph would land inside the range
   * the join removes.
   *
   * **An empty first paragraph is not joined.** Measured with Word, Backspace
   * at the start of a paragraph after an empty one deletes the empty one, and
   * the paragraph below keeps its own properties — a heading stays a heading.
   * A join keeps the first one's properties by construction, so it would
   * make that heading body text: what Word does there is a removal, and the
   * plan says so with a removal. "Empty" is the line that ends at the
   * boundary, not the paragraph alone: a paragraph whose text was typed away
   * after something was joined onto its front still ends a line with text.
   */
  const joinedTo = new Map<number, number>();
  const joins: { first: ParagraphSpan; next: ParagraphSpan; gap: string }[] = [];
  const lineShowsNothing = (span: ParagraphSpan): boolean => {
    const cut = divided.get(span.index);
    if (cut) {
      const last = [...cut].sort((a, b) => b.start - a.start)[0]!;
      if (cutByRun.get(last.index)!.parts.at(-1)!.length > 0) return false;
      return showsNothingIn(xml, last.text!.end, insideOf(xml, span).end, byText, typed);
    }
    const inside = insideOf(xml, span);
    if (!showsNothingIn(xml, inside.start, inside.end, byText, typed)) return false;
    const before = joinedTo.get(span.index);
    return before === undefined || lineShowsNothing(paragraphByIndex.get(before)!);
  };
  if (reshaping?.joins?.length) {
    const body = reshaping.paragraphs.filter((span) => span.refusal === null);
    const alive = new Set(body.filter((span) => !removed.includes(span)).map((span) => span.index));
    const followed = new Set(reshaping.inserts.filter((insert) => insert.text.length > 0).map((insert) => insert.after));
    for (const index of [...new Set(reshaping.joins)].sort((a, b) => a - b)) {
      if (joinRefusal(xml, reshaping.paragraphs, index, alive) !== null) continue;
      const first = paragraphByIndex.get(index)!;
      const pair = partnerOf(xml, body, first, alive) as { next: ParagraphSpan; gap: string };
      const crossed = body.filter((span) => span.index >= index && span.index < pair.next.index);
      if (crossed.some((span) => followed.has(span.index))) continue;
      if (lineShowsNothing(first)) continue;
      joinedTo.set(pair.next.index, index);
      joins.push({ first, next: pair.next, gap: pair.gap });
    }
  }
  /** The paragraph whose properties the line holding this one's end is written with. */
  const headOf = (index: number): ParagraphSpan => {
    let at = index;
    while (joinedTo.has(at)) at = joinedTo.get(at)!;
    return paragraphByIndex.get(at)!;
  };
  /** The run a new line after this paragraph continues: its own last, or the last of the line it was joined onto. */
  const lineRun = (index: number): RunSpan | null => {
    for (let at: number | undefined = index; at !== undefined; at = joinedTo.get(at)) {
      const found = lastRunOf(xml, paragraphByIndex.get(at)!, runs);
      if (found) return found;
    }
    return null;
  };

  const rewrite = (text: string): string => `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;

  for (const edit of edits) {
    const run = byIndex.get(edit.index);
    if (!run?.text || run.refusal) continue;
    if (removed.some((span) => run.start >= span.start && run.end <= span.end)) continue;
    /* A divided run's own text is inside the range too, so a rewrite of it
       yields to its parts by this same rule. */
    if (claimed.some((range) => run.text!.start >= range.from && run.text!.end <= range.to)) continue;
    operations.push({
      at: run.text.start,
      end: run.text.end,
      /* Without `xml:space="preserve"` Word discards leading and trailing
         spaces, so "name " would quietly become "name". */
      text: rewrite(edit.text),
      order: 0,
    });
  }

  if (reshaping) {
    reshaping.inserts.forEach((insert, order) => {
      const paragraph = paragraphByIndex.get(insert.after);
      if (!paragraph || paragraph.refusal || insert.text.length === 0) return;
      /* After a divided paragraph too: its range ends where this begins, so
         the two touch without overlapping, and the new paragraph lands after
         the last piece — which is where the view draws it. After a joined one
         it continues the line the join made: that line's properties, handed
         on through `w:next`, and the formatting of its last run. */
      operations.push({
        at: paragraph.end,
        end: paragraph.end,
        text: paragraphMarkup(
          xml,
          paragraph,
          runs,
          reshaping.succession,
          insert.text,
          headOf(paragraph.index),
          lineRun(paragraph.index),
        ),
        order,
      });
    });

    /* A stretch of the original carried into a divided paragraph unread, with
       the rewrites of the ordinary runs inside it applied as it goes. */
    const carried = (from: number, to: number): string => {
      const inside = runs
        .filter(
          (run) =>
            run.text &&
            !run.refusal &&
            typed.has(run.index) &&
            run.text.start >= from &&
            run.text.end <= to,
        )
        .sort((a, b) => b.text!.start - a.text!.start);
      let text = xml.slice(from, to);
      for (const run of inside) {
        text = text.slice(0, run.text!.start - from) + rewrite(typed.get(run.index)!) + text.slice(run.text!.end - from);
      }
      return text;
    };

    /*
     * A divided paragraph, written whole. Its first piece keeps the opening
     * the file already has — the same `w:p`, the same properties, every run
     * before the first cut untouched — and each cut closes the run and the
     * paragraph where it falls and opens a new pair carrying the run's own
     * formatting and the properties of the line it divides: the paragraph's
     * own, or, where the paragraph was joined onto another, the one the
     * joined line is written with — Word divides the line it shows. What
     * followed the last cut is carried across as it was, up to the
     * paragraph's closing tag, which stays where it stands: it becomes the
     * last piece's end.
     */
    for (const [index, cut] of divided) {
      const paragraph = paragraphByIndex.get(index)!;
      const end = insideOf(xml, paragraph).end;
      const ordered = [...cut].sort((a, b) => a.start - b.start);
      const w = prefixOf(xml, paragraph);
      const props = splitProps(xml, headOf(index));
      const piece = (text: string): string =>
        `<${w}t xml:space="preserve">${escapeXml(text)}</${w}t>`;

      let text = '';
      ordered.forEach((run, k) => {
        if (k > 0) text += carried(ordered[k - 1]!.text!.end, run.text!.start);
        const [first, ...rest] = cutByRun.get(run.index)!.parts;
        const rPr = runProperties(xml, run);
        text += piece(first!);
        for (const part of rest) text += `</${w}r></${w}p><${w}p>${props}<${w}r>${rPr}${piece(part)}`;
      });
      text += carried(ordered[ordered.length - 1]!.text!.end, end);

      operations.push({ at: ordered[0]!.text!.start, end, text, order: 0 });
    }

    /*
     * A join, written as the boundary it removes: from the first paragraph's
     * closing tag to the end of the next one's properties, so the joined
     * paragraph opens with the first one's tag and properties and closes with
     * the next one's tag, and nothing either holds is rewritten. The range
     * marks that stood between them are carried to the join. A `<w:p/>` has
     * no closing tag of its own to finish the line with, so where the chain
     * ends on one, one is written.
     */
    /*
     * A new row in a table, written after the row it follows and nowhere
     * else — the one operation here that touches no byte of anything that
     * was already in the file. Re-judged against the original, because a
     * caller of this function is not obliged to have asked first, and a row
     * nobody typed a single character into is not written at all: a new
     * paragraph keeps that rule for its own reason, and a row keeps it for
     * this one — an empty row of empty cells has nothing in it a person
     * could ever put a cursor in again.
     */
    const rows = reshaping.rows ?? [];
    (reshaping.rowInserts ?? []).forEach((insert, order) => {
      if (insert.cells.every((text) => text.length === 0)) return;
      if (rowRefusal(xml, rows, insert.after) !== null) return;
      const anchor = anchorRow(xml, rows, rows.find((one) => one.index === insert.after)!);
      operations.push({
        at: anchor.end,
        end: anchor.end,
        text: rowMarkup(xml, anchor, insert.cells),
        /* Two rows added after one row keep the order they were added in:
           the later step is written first, which leaves it second. */
        order,
      });
    });

    const firsts = new Set(joins.map((join) => join.first.index));
    for (const join of joins) {
      const from = insideOf(xml, join.first);
      const to = insideOf(xml, join.next);
      const closing = to.selfClosing && !firsts.has(join.next.index) ? `</${prefixOf(xml, headOf(join.first.index))}p>` : '';
      operations.push({ at: from.end, end: to.start, text: join.gap + closing, order: 0 });
    }
  }

  /* A paragraph a join's boundary takes is taken by the join. */
  for (const span of removed) {
    if (joins.some((join) => span.start >= join.first.end && span.end <= join.next.start)) continue;
    operations.push({ at: span.start, end: span.end, text: '', order: 0 });
  }

  /* Descending offset; at an equal offset the consuming operation first —
     which is the tie-break the comment above measures — and then the later
     step first, which leaves it second on the page. */
  operations.sort(
    (a, b) => b.at - a.at || (b.end - b.at) - (a.end - a.at) || b.order - a.order,
  );

  let out = xml;
  for (const operation of operations) {
    out = out.slice(0, operation.at) + operation.text + out.slice(operation.end);
  }
  return out;
}
