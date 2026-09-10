/**
 * DOCX → an HTML view (read-only).
 *
 * The aim is not a perfect reproduction of Word's layout — that is the job of
 * phase 2 and a real fidelity harness. The aim is for a person to open a `.docx`
 * and **read it**: headings, paragraphs, bold, lists, tables and images in their
 * places.
 *
 * Everything not carried across is collected into `notes` and displayed above
 * the document. A view that stays silent about what it lost is worse than one
 * that says so.
 */

import {
  attr,
  attrNum,
  child,
  children,
  emuToPx,
  imageUrl,
  openArchive,
  readRelationships,
  readText,
  readXml,
  tag,
  tags,
  type Archive,
  type Relationships,
} from './ooxml.js';
import {
  findParagraphs,
  findRuns,
  paragraphOfRun,
  readStyleSuccession,
  runText,
  writeDocx,
  type ParagraphSpan,
  type RunSpan,
  type Succession,
} from './docx-edit.js';
import { t } from '@uleditor/i18n';

export interface PreviewOutline {
  id: string;
  label: string;
  depth: number;
}

export interface Preview {
  title: string;
  body: HTMLElement;
  text: string;
  outline: PreviewOutline[];
  notes: string[];
  release(): void;

  /**
   * The seam an edit is written through.
   *
   * **Absent means read-only**, and the view is expected to say so. The same
   * reading room serves formats that can only be shown — the old binary `.doc`
   * and Rich Text — and a missing seam is a better way to express that than an
   * `edit` that throws at the moment of saving.
   */
  source?: PreviewSource;
}

export interface PreviewEdit {
  /** The ordinal of the piece of text being rewritten, as the view marked it. */
  index: number;
  text: string;
}

/**
 * A paragraph that is not in the file yet, as the editor holds it.
 *
 * `after` is the ordinal the view marked the source paragraph with — the same
 * one `data-paragraph` carries — and it names a paragraph of the file **as it
 * was opened**. It stays valid for the life of the document because nothing
 * here ever advances that file.
 */
export interface NewParagraph {
  after: number;
  text: string;
}

/**
 * What every in-place text editor here has in common, and no more than that.
 *
 * A Word document is rewritten a `w:r` at a time and an OpenDocument text a
 * stretch of character data at a time; the two agree on nothing below this
 * interface — not the unit, not the part being written, not even what makes a
 * piece un-rewritable. They agree on exactly this much, so one editor drives
 * both without a line that asks which format it is looking at.
 */
export interface PreviewSource {
  /** The text of a piece as the file was opened with — what an undo returns to. */
  textOf(index: number): string;
  /**
   * The whole file with those rewrites and those new paragraphs in it.
   *
   * **Always from the file as it was opened.** Nothing here is applied and then
   * built upon: a save writes the original with the whole plan against it, so
   * saving twice writes the same bytes, and changing your mind after a save is
   * still something a person can do. It is the shape
   * [`editor-pdf`](../../editor-pdf/src/document.ts) settled on for pages, and
   * an insertion is the change that makes the difference matter — a rewrite that
   * is applied and committed merely moves ranges, while an insertion that is
   * applied and committed can never be taken back.
   */
  write(edits: PreviewEdit[], added?: NewParagraph[]): Uint8Array;

  /**
   * Absent means this format can rewrite the text it has and not add to it.
   *
   * The capability sits on the seam rather than in the editor above it, and that
   * is the whole reason one class can drive four formats without ever asking
   * which one it is looking at: an OpenDocument text has no answer to this yet,
   * so it offers none, and the editor offers the person nothing rather than a
   * command that quietly does nothing.
   */
  paragraphs?: ParagraphSeam;
}

export interface ParagraphSeam {
  /**
   * Why no new paragraph may follow the one this piece of text sits in.
   *
   * `null` when one may. The reason is a sentence for a person to read, because
   * a command that is unavailable without saying why teaches people that the
   * program is unreliable rather than that a table cell is a different problem.
   */
  refusalNear(index: number): string | null;
}

const HEADING = /^heading\s*([1-6])$/i;

/* ── numeriranje ─────────────────────────────────────────────────────── */

/** `numId` → whether the level is marked with a bullet or a number. */
function readNumbering(archive: Archive): Map<string, boolean> {
  const doc = readXml(archive, 'word/numbering.xml');
  const ordered = new Map<string, boolean>();
  if (!doc) return ordered;

  const abstract = new Map<string, boolean>();
  for (const node of tags(doc, 'abstractNum')) {
    const id = attr(node, 'abstractNumId');
    if (!id) continue;
    const first = children(node, 'lvl')[0];
    const format = attr(child(first ?? node, 'numFmt'), 'val') ?? 'decimal';
    abstract.set(id, format !== 'bullet' && format !== 'none');
  }

  for (const node of tags(doc, 'num')) {
    const id = attr(node, 'numId');
    const ref = attr(child(node, 'abstractNumId'), 'val');
    if (id && ref) ordered.set(id, abstract.get(ref) ?? false);
  }
  return ordered;
}

/* ── text ────────────────────────────────────────────────────────────── */

interface Context {
  archive: Archive;
  rels: Relationships;
  urls: string[];
  notes: Set<string>;
  /** The ordinal of each `w:r`, the same one `findRuns` counts them by. */
  runIndex: Map<Element, number>;
  /** The runs that can be rewritten; the rest are displayed but not offered. */
  editable: Set<number>;
  /** The ordinal of each `w:p`, the same one `findParagraphs` counts them by. */
  paraIndex: Map<Element, number>;
  /** The paragraphs a new one may follow; empty when the two counts disagree. */
  insertable: Set<number>;
}

/** A single `w:r` — the carrier of its own formatting. */
function buildRun(run: Element, ctx: Context): Node[] {
  const props = child(run, 'rPr');
  const out: Node[] = [];

  for (const node of [...run.children]) {
    switch (node.localName) {
      case 't':
        out.push(document.createTextNode(node.textContent ?? ''));
        break;
      case 'br':
        out.push(document.createElement('br'));
        break;
      case 'tab':
        out.push(document.createTextNode(' '));
        break;
      case 'drawing':
      case 'pict': {
        const image = buildImage(node, ctx);
        if (image) out.push(image);
        break;
      }
      case 'footnoteReference':
      case 'endnoteReference':
        ctx.notes.add('Footnotes and endnotes are not shown.');
        break;
      case 'object':
        ctx.notes.add('Embedded objects (equations, OLE) are not shown.');
        break;
      default:
        break;
    }
  }

  if (out.length === 0 || !props) return out;

  const on = (local: string): boolean => {
    const el = child(props, local);
    if (!el) return false;
    const value = attr(el, 'val');
    return value !== '0' && value !== 'false' && value !== 'none';
  };

  let wrapper: HTMLElement | null = null;
  const wrap = (tagName: string) => {
    const el = document.createElement(tagName);
    if (wrapper) el.appendChild(wrapper);
    else for (const node of out) el.appendChild(node);
    wrapper = el;
  };

  if (on('b')) wrap('strong');
  if (on('i')) wrap('em');
  if (on('u')) wrap('u');
  if (on('strike') || on('dstrike')) wrap('s');

  const vertical = attr(child(props, 'vertAlign'), 'val');
  if (vertical === 'superscript') wrap('sup');
  if (vertical === 'subscript') wrap('sub');

  const color = attr(child(props, 'color'), 'val');
  const highlight = attr(child(props, 'highlight'), 'val');
  if ((color && color !== 'auto') || highlight) {
    wrap('span');
    const span = wrapper as unknown as HTMLElement;
    if (color && color !== 'auto') span.style.color = `#${color}`;
    if (highlight && highlight !== 'none') span.style.background = highlight;
  }

  return wrapper ? [wrapper] : out;
}

/**
 * Marks a run in the view so we know which piece of XML it belongs to.
 *
 * A wrapper is given **only to runs that can genuinely be rewritten**. Offering
 * an edit where it cannot be carried out means making a promise that goes unkept
 * until the moment of saving.
 */
function tagRun(run: Element, ctx: Context, nodes: Node[]): Node[] {
  const index = ctx.runIndex.get(run);
  if (index === undefined || !ctx.editable.has(index) || nodes.length === 0) return nodes;

  const span = document.createElement('span');
  span.className = 'ul-office-run';
  span.dataset.run = String(index);
  span.append(...nodes);
  return [span];
}

function buildImage(node: Element, ctx: Context): HTMLElement | null {
  const blip = tag(node, 'blip');
  const id = attr(blip, 'embed') ?? attr(blip, 'link');
  const target = id ? ctx.rels.get(id) : undefined;

  if (!target || target.external) {
    ctx.notes.add('Images linked from outside the document are not loaded.');
    return null;
  }

  const url = imageUrl(ctx.archive, target.target);
  if (!url) {
    ctx.notes.add('Some images use a format the browser cannot render (EMF/WMF).');
    return null;
  }
  ctx.urls.push(url);

  const img = document.createElement('img');
  img.src = url;
  img.alt = attr(tag(node, 'docPr'), 'descr') ?? '';

  const extent = tag(node, 'extent');
  const cx = attrNum(extent, 'cx');
  if (cx) img.style.width = `${emuToPx(cx)}px`;

  return img;
}

/** The content of one `w:p` — runs, links and tracked changes. */
function paragraphContent(paragraph: Element, ctx: Context): Node[] {
  const out: Node[] = [];

  for (const node of [...paragraph.children]) {
    switch (node.localName) {
      case 'r':
        out.push(...tagRun(node, ctx, buildRun(node, ctx)));
        break;
      case 'hyperlink': {
        const id = attr(node, 'id');
        const rel = id ? ctx.rels.get(id) : undefined;
        const link = document.createElement('a');
        if (rel) {
          link.href = rel.target;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        for (const run of children(node, 'r')) link.append(...tagRun(run, ctx, buildRun(run, ctx)));
        if (link.textContent) out.push(link);
        break;
      }
      case 'ins':
        // An accepted tracked change — the text belongs to the document.
        for (const run of children(node, 'r')) out.push(...tagRun(run, ctx, buildRun(run, ctx)));
        break;
      case 'del':
        ctx.notes.add('Tracked changes are shown as accepted; deleted text is not visible.');
        break;
      case 'fldSimple':
      case 'sdt':
        // Fields (page number, table of contents) make no sense outside Word's layout.
        for (const run of tags(node, 'r')) out.push(...tagRun(run, ctx, buildRun(run, ctx)));
        break;
      default:
        break;
    }
  }

  return out;
}

/* ── tables ──────────────────────────────────────────────────────────── */

function buildTable(node: Element, ctx: Context): HTMLElement {
  const table = document.createElement('table');
  /** The cell that "holds" a vertical merge — the rowspan goes on it. */
  const open = new Map<number, HTMLTableCellElement>();

  for (const rowNode of children(node, 'tr')) {
    const row = document.createElement('tr');
    const header = child(child(rowNode, 'trPr') ?? rowNode, 'tblHeader') !== null;
    let column = 0;

    for (const cellNode of children(rowNode, 'tc')) {
      const props = child(cellNode, 'tcPr');
      const span = attrNum(child(props ?? cellNode, 'gridSpan'), 'val') ?? 1;
      const merge = child(props ?? cellNode, 'vMerge');
      const continuing = merge !== null && (attr(merge, 'val') ?? 'continue') !== 'restart';

      if (continuing) {
        const owner = open.get(column);
        if (owner) owner.rowSpan += 1;
        column += span;
        continue;
      }

      const cell = document.createElement(header ? 'th' : 'td');
      if (span > 1) cell.colSpan = span;

      for (const inner of [...cellNode.children]) {
        if (inner.localName === 'p') {
          const p = document.createElement('p');
          p.append(...paragraphContent(inner, ctx));
          cell.appendChild(p);
        } else if (inner.localName === 'tbl') {
          cell.appendChild(buildTable(inner, ctx));
        }
      }

      if (merge) open.set(column, cell);
      else open.delete(column);

      row.appendChild(cell);
      column += span;
    }

    table.appendChild(row);
  }

  return table;
}

/* ── dokument ────────────────────────────────────────────────────────── */

export function renderDocx(bytes: Uint8Array): Preview {
  const archive = openArchive(bytes);
  const doc = readXml(archive, 'word/document.xml');
  if (!doc) {
    /* The old binary `.doc` no longer reaches here — it has its own id, its own
       provider and its own reader (see `doc.ts`). What is left is a file that
       claims to be a `.docx` and is not one. */
    throw new Error(t('The file has no `word/document.xml` — this is not a Word document.'));
  }

  /*
   * Runs are counted over the raw XML and mapped into the view by element order.
   * Both traversals follow document order, so the `n`-th `w:r` in one matches
   * the `n`-th in the other — without that, an edit could land in the wrong
   * piece of text.
   */
  const xml = readText(archive, 'word/document.xml') ?? '';
  const runs = findRuns(xml);
  const paragraphs = findParagraphs(xml);
  const succession = readStyleSuccession(readText(archive, 'word/styles.xml'));

  const runIndex = new Map<Element, number>();
  const paraIndex = new Map<Element, number>();
  let seen = 0;
  let seenParagraphs = 0;
  for (const el of doc.querySelectorAll('*')) {
    if (el.localName === 'r') runIndex.set(el, seen++);
    else if (el.localName === 'p') paraIndex.set(el, seenParagraphs++);
  }

  const ctx: Context = {
    archive,
    rels: readRelationships(archive, 'word/document.xml'),
    urls: [],
    notes: new Set(),
    runIndex,
    /* The counts must match; if they do not, nothing is offered rather than
       guessing at the wrong run. */
    editable:
      seen === runs.length
        ? new Set(runs.filter((run) => !run.refusal).map((run) => run.index))
        : new Set(),
    paraIndex,
    /* And the same guard for paragraphs, for the same reason: a new paragraph
       written after the wrong one is worse than no new paragraph at all. */
    insertable:
      seenParagraphs === paragraphs.length
        ? new Set(paragraphs.filter((span) => !span.refusal).map((span) => span.index))
        : new Set(),
  };

  const ordered = readNumbering(archive);
  const bodyNode = tag(doc, 'body');
  const body = document.createElement('div');
  body.className = 'ul-office-doc';

  const outline: PreviewOutline[] = [];
  let list: HTMLElement | null = null;
  let listKey = '';

  const closeList = () => {
    list = null;
    listKey = '';
  };

  for (const node of bodyNode ? [...bodyNode.children] : []) {
    if (node.localName === 'tbl') {
      closeList();
      body.appendChild(buildTable(node, ctx));
      continue;
    }
    if (node.localName !== 'p') continue;

    /*
     * The element that shows this paragraph carries its ordinal, so a new
     * paragraph knows where in the view to appear — and, just as importantly,
     * so a paragraph that may NOT be followed by a new one carries nothing and
     * is never offered. A `w:p` in a table cell falls out here by itself.
     */
    const mark = <T extends HTMLElement>(element: T): T => {
      const index = ctx.paraIndex.get(node);
      if (index !== undefined && ctx.insertable.has(index)) element.dataset.paragraph = String(index);
      return element;
    };

    const props = child(node, 'pPr');
    const style = attr(child(props ?? node, 'pStyle'), 'val') ?? '';
    const numbering = props ? child(props, 'numPr') : null;
    const content = paragraphContent(node, ctx);

    /* Lists: consecutive paragraphs with the same `numId` form one list. */
    if (numbering) {
      const numId = attr(child(numbering, 'numId'), 'val') ?? '0';
      const level = attrNum(child(numbering, 'ilvl'), 'val') ?? 0;
      const key = `${numId}:${level}`;

      if (!list || key !== listKey) {
        list = document.createElement(ordered.get(numId) ? 'ol' : 'ul');
        if (level > 0) list.dataset.level = String(Math.min(level, 4));
        body.appendChild(list);
        listKey = key;
      }

      const item = mark(document.createElement('li'));
      item.append(...content);
      list.appendChild(item);
      continue;
    }

    closeList();

    if (content.length === 0) {
      // An empty paragraph in Word is deliberate spacing, not junk.
      const spacer = mark(document.createElement('p'));
      spacer.className = 'ul-office-blank';
      body.appendChild(spacer);
      continue;
    }

    const heading = HEADING.exec(style);
    const outlineLevel = attrNum(child(props ?? node, 'outlineLvl'), 'val');
    const level = heading
      ? Number(heading[1])
      : /^title$/i.test(style)
        ? 1
        : /^subtitle$/i.test(style)
          ? 2
          : outlineLevel !== null
            ? Math.min(outlineLevel + 1, 6)
            : 0;

    if (level > 0) {
      const element = mark(document.createElement(`h${level}`));
      element.append(...content);
      element.id = `naslov-${outline.length}`;
      outline.push({
        id: element.id,
        label: (element.textContent ?? '').trim().slice(0, 120),
        depth: Math.min(level - 1, 3),
      });
      body.appendChild(element);
      continue;
    }

    const p = mark(document.createElement('p'));
    const align = attr(child(props ?? node, 'jc'), 'val');
    if (align === 'center' || align === 'right' || align === 'both') {
      p.style.textAlign = align === 'both' ? 'justify' : align;
    }
    if (/^quote$/i.test(style) || /^intensequote$/i.test(style)) p.className = 'ul-office-quote';
    p.append(...content);
    body.appendChild(p);
  }

  /* The parts of the document the view does not show. */
  if (Object.keys(archive).some((name) => /^word\/(header|footer)\d*\.xml$/.test(name))) {
    ctx.notes.add('Page headers and footers are not shown.');
  }
  if (archive['word/comments.xml']) ctx.notes.add('Comments are not shown.');

  const core = readXml(archive, 'docProps/core.xml');
  const title = (core ? tag(core, 'title')?.textContent : '')?.trim() ?? '';

  return {
    title,
    body,
    text: (body.textContent ?? '').replace(/\s+/g, ' ').trim(),
    outline,
    notes: [...ctx.notes],
    release: () => {
      for (const url of ctx.urls) URL.revokeObjectURL(url);
      ctx.urls.length = 0;
    },
    /* No piece could be paired with the text on the page, so there is nothing
       to offer and the bar says so — the same answer the OpenDocument reader
       gives, rather than a promise of editing that has no target. */
    source:
      ctx.editable.size > 0
        ? docxSource(archive, xml, runs, paragraphs, succession, ctx.insertable)
        : undefined,
  };
}

/**
 * The seam the editor writes a Word document through.
 *
 * Nothing here changes for the life of the document. The part, the runs and the
 * paragraphs are the ones the file was opened with, and every save applies the
 * whole plan to them again — so an ordinal means the same thing an hour and
 * three saves later as it did at the start, and no rebasing arithmetic stands
 * between a person and the paragraph they are pointing at.
 */
function docxSource(
  archive: Archive,
  xml: string,
  runs: RunSpan[],
  paragraphs: ParagraphSpan[],
  succession: Succession,
  insertable: Set<number>,
): PreviewSource {
  return {
    textOf: (index) => {
      const run = runs[index];
      return run ? runText(xml, run) : '';
    },
    write: (edits, added) =>
      writeDocx(archive, runs, xml, edits, {
        paragraphs,
        succession,
        inserts: (added ?? []).map((one) => ({ after: one.after, text: one.text })),
      }),

    /* Offered only when the view and the raw scan agreed on how many paragraphs
       there are — the same guard the runs get, for the same reason. */
    paragraphs:
      insertable.size > 0
        ? {
            refusalNear: (index) => {
              const run = runs[index];
              if (!run) return t('This piece of text is not in a paragraph of the document.');
              const paragraph = paragraphOfRun(paragraphs, run);
              if (!paragraph) return t('This piece of text is not in a paragraph of the document.');
              return paragraph.refusal
                ? t('A new paragraph can only go into the body of the document — not into a table cell or a text box.')
                : null;
            },
          }
        : undefined,
  };
}
