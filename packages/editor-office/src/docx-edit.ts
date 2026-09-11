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
): string {
  const w = prefixOf(xml, paragraph);

  let props = '';
  if (paragraph.props) {
    const outer = paragraph.props;

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
    if (/^<[^>]*>\s*<\/[^>]*>$/.test(props)) props = '';
  }

  const rPr = runProperties(xml, lastRunOf(xml, paragraph, runs));
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

/** Everything a save needs to know about the paragraphs the plan reshapes. */
export interface Reshaping {
  paragraphs: ParagraphSpan[];
  succession: Succession;
  inserts: ParagraphInsert[];
  /** Ordinals of paragraphs of the original part the plan removes. */
  removals?: number[];
}

/**
 * Every rewrite, every new paragraph and every removal, written into the
 * original in one pass.
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

  for (const edit of edits) {
    const run = byIndex.get(edit.index);
    if (!run?.text || run.refusal) continue;
    if (removed.some((span) => run.start >= span.start && run.end <= span.end)) continue;
    operations.push({
      at: run.text.start,
      end: run.text.end,
      /* Without `xml:space="preserve"` Word discards leading and trailing
         spaces, so "name " would quietly become "name". */
      text: `<w:t xml:space="preserve">${escapeXml(edit.text)}</w:t>`,
      order: 0,
    });
  }

  if (reshaping) {
    const paragraphs = new Map(reshaping.paragraphs.map((span) => [span.index, span]));
    reshaping.inserts.forEach((insert, order) => {
      const paragraph = paragraphs.get(insert.after);
      if (!paragraph || paragraph.refusal || insert.text.length === 0) return;
      operations.push({
        at: paragraph.end,
        end: paragraph.end,
        text: paragraphMarkup(xml, paragraph, runs, reshaping.succession, insert.text),
        order,
      });
    });
  }

  for (const span of removed) {
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
