/**
 * DOCX → HTML pregled (samo čitanje).
 *
 * Cilj nije savršena reprodukcija Wordovog prijeloma — to je posao faze 2 i
 * pravog fidelity harnessa. Cilj je da čovjek otvori `.docx` i **pročita ga**:
 * naslovi, odlomci, podebljano, liste, tablice i slike na svom mjestu.
 *
 * Sve što se ne prenosi skuplja se u `notes` i prikazuje iznad dokumenta.
 * Pregled koji šuti o tome što je izgubio je gori od pregleda koji to kaže.
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
import { findRuns, type RunSpan } from './docx-edit.js';
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

  /** Sve što treba da se izmjena upiše natrag u datoteku. */
  source: {
    archive: Archive;
    /** Sirovi `word/document.xml`; izmjene se rade nad njim, ne nad DOM-om. */
    xml: string;
    runs: RunSpan[];
  };
}

const HEADING = /^heading\s*([1-6])$/i;

/* ── numeriranje ─────────────────────────────────────────────────────── */

/** `numId` → je li razina označena kuglicom ili brojem. */
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

/* ── tekst ───────────────────────────────────────────────────────────── */

interface Context {
  archive: Archive;
  rels: Relationships;
  urls: string[];
  notes: Set<string>;
  /** Redni broj svakog `w:r`, isti kojim ih broji `findRuns`. */
  runIndex: Map<Element, number>;
  /** Runovi koji se daju prepisati; ostali se prikazuju, ali ne nude. */
  editable: Set<number>;
}

/** Jedan `w:r` — nosilac svog formatiranja. */
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
 * Označava run u pregledu tako da se zna kojem komadu XML-a pripada.
 *
 * Omotač dobivaju **samo runovi koje se stvarno da prepisati**. Ponuditi
 * izmjenu ondje gdje se ne može provesti znači obećati nešto što se ne
 * ispuni tek pri spremanju.
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

/** Sadržaj jednog `w:p` — runovi, veze i praćene promjene. */
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
        // Prihvaćena praćena promjena — tekst pripada dokumentu.
        for (const run of children(node, 'r')) out.push(...tagRun(run, ctx, buildRun(run, ctx)));
        break;
      case 'del':
        ctx.notes.add('Tracked changes are shown as accepted; deleted text is not visible.');
        break;
      case 'fldSimple':
      case 'sdt':
        // Polja (broj stranice, sadržaj) nemaju smisla izvan Wordovog prijeloma.
        for (const run of tags(node, 'r')) out.push(...tagRun(run, ctx, buildRun(run, ctx)));
        break;
      default:
        break;
    }
  }

  return out;
}

/* ── tablice ─────────────────────────────────────────────────────────── */

function buildTable(node: Element, ctx: Context): HTMLElement {
  const table = document.createElement('table');
  /** Ćelija koja "drži" spajanje po stupcima — na nju ide rowspan. */
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
    throw new Error(
      t('The file has no `word/document.xml`. The older binary `.doc` is not supported — save it as .docx.'),
    );
  }

  /*
   * Runovi se broje nad sirovim XML-om, a u pregled se preslikavaju preko
   * poretka elemenata. Oba obilaska idu redoslijedom dokumenta, pa se
   * `n`-ti `w:r` u jednom poklapa s `n`-tim u drugom — bez toga bi izmjena
   * mogla završiti u krivom komadu teksta.
   */
  const xml = readText(archive, 'word/document.xml') ?? '';
  const runs = findRuns(xml);

  const runIndex = new Map<Element, number>();
  let seen = 0;
  for (const el of doc.querySelectorAll('*')) {
    if (el.localName === 'r') runIndex.set(el, seen++);
  }

  const ctx: Context = {
    archive,
    rels: readRelationships(archive, 'word/document.xml'),
    urls: [],
    notes: new Set(),
    runIndex,
    /* Broj se mora poklopiti; ako se ne poklapa, ne nudi se ništa umjesto da
       se pogodi krivi run. */
    editable:
      seen === runs.length
        ? new Set(runs.filter((run) => !run.refusal).map((run) => run.index))
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

    const props = child(node, 'pPr');
    const style = attr(child(props ?? node, 'pStyle'), 'val') ?? '';
    const numbering = props ? child(props, 'numPr') : null;
    const content = paragraphContent(node, ctx);

    /* Liste: uzastopni odlomci s istim `numId` čine jedan popis. */
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

      const item = document.createElement('li');
      item.append(...content);
      list.appendChild(item);
      continue;
    }

    closeList();

    if (content.length === 0) {
      // Prazan odlomak u Wordu je namjeran razmak, ne smeće.
      const spacer = document.createElement('p');
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
      const element = document.createElement(`h${level}`);
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

    const p = document.createElement('p');
    const align = attr(child(props ?? node, 'jc'), 'val');
    if (align === 'center' || align === 'right' || align === 'both') {
      p.style.textAlign = align === 'both' ? 'justify' : align;
    }
    if (/^quote$/i.test(style) || /^intensequote$/i.test(style)) p.className = 'ul-office-quote';
    p.append(...content);
    body.appendChild(p);
  }

  /* Dijelovi dokumenta koje pregled ne pokazuje. */
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
    source: { archive, xml, runs },
  };
}
