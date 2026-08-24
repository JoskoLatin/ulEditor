/**
 * The old binary Word — `.doc`, Word 97–2003 — read into the same reading room.
 *
 * Until now this file gave the worst message in the program: *"This is not a
 * valid Office archive — it is probably damaged or incompletely downloaded."*
 * The file was neither. It was simply from before 2007, which is where a great
 * deal of what people actually keep still lives — contracts, minutes, court
 * filings, everything an office wrote in the years the format was the default.
 *
 * Nothing about it resembles a `.docx`. There is no XML and no archive of
 * parts; there is [an OLE2 compound file](./cfb.ts) holding a `WordDocument`
 * stream and a table stream beside it, and the text is not stored in reading
 * order at all. Three things have to be understood before a single letter comes
 * out right:
 *
 * **The piece table.** The characters of the document lie scattered through the
 * stream in whatever order successive fast saves left them, and a table of
 * *pieces* in the table stream says which run of bytes holds which run of
 * characters. Each piece also declares its own width: a piece whose bit 30 is
 * set is one byte per character in **CP1252**, and one whose bit is clear is
 * two bytes per character in UTF-16. A Croatian document is routinely both at
 * once — `ž` and `š` exist in CP1252 and `č`, `ć` and `đ` do not, so Word
 * writes the paragraphs that need them wide and the rest narrow, in the same
 * file. Reading it as one encoding garbles exactly the documents written here.
 *
 * **Properties live in a second index, keyed by byte position.** Which
 * paragraph is a heading, which words are bold — none of that sits beside the
 * text. It sits in *FKPs*, 512-byte pages elsewhere in the same stream, each
 * mapping byte ranges to property lists. So every character has to be converted
 * back from its position in the reading order to its position in the file
 * before its formatting can be looked up.
 *
 * **A table is punctuation.** There is no table element. There is a paragraph
 * ending in `\x07` instead of `\r`, which means "this was a cell", and a
 * paragraph carrying `sprmPFTtp`, which means "the row ended here". The grid is
 * inferred, not read.
 *
 * **Read-only, deliberately** — the same judgement as [`xls.ts`](./xls.ts), and
 * for a stronger reason. Everything above is positional: the piece table, the
 * FKPs and the field boundaries all point at byte offsets, so inserting a
 * single character means rewriting every index that points past it. There is no
 * seam to cut along, and no `edit` is claimed. The `Preview` is handed over
 * without a `source`, which is how this codebase says read-only, and the bar
 * above the document says it in words.
 */

import { t } from '@uleditor/i18n';

import { Cfb } from './cfb.js';
import type { Preview, PreviewOutline } from './docx.js';

/**
 * The characters CP1252 puts where Latin-1 keeps control codes.
 *
 * Word's narrow pieces are CP1252 whatever the machine's locale was, so this is
 * not a guess: `0x9E` is `ž` in a Zagreb document and in a Lisbon one alike.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/**
 * The two hyphens Word stores as codes rather than as characters: one that a
 * line may not be broken at, and one that is drawn only where a line breaks.
 * Written as code points because both are invisible in an editor — a soft
 * hyphen pasted into source looks exactly like nothing at all.
 */
const NO_BREAK_HYPHEN = String.fromCharCode(0x2011);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);

/** A document longer than this is shown to the cap; past it the browser stops being usable. */
const MAX_CHARS = 2_000_000;

/* ── the pieces ──────────────────────────────────────────────────────── */

interface Piece {
  /** The first character position this piece holds. */
  cp: number;
  cpEnd: number;
  /** Where its bytes begin in the `WordDocument` stream. */
  fc: number;
  /** One byte per character (CP1252) rather than two (UTF-16). */
  narrow: boolean;
}

/**
 * The piece table out of the `Clx`.
 *
 * The `Clx` is a run of `Prc` blocks (tag `0x01`) that we skip, followed by the
 * `Pcdt` (tag `0x02`) we want: a `PlcPcd`, which is the shape every `Plc` in
 * this format has — `n + 1` character positions first, then `n` fixed-size
 * records. Twelve bytes per piece: four of position, eight of descriptor.
 */
function readPieces(table: DataView, fc: number, lcb: number): Piece[] {
  let at = fc;
  const end = fc + lcb;

  while (at < end) {
    const tag = table.getUint8(at);
    if (tag === 0x01) {
      // A Prc: two bytes of length, then that many bytes of properties we do
      // not need — the pieces are what this is being read for.
      const size = table.getInt16(at + 1, true);
      at += 3 + size;
      continue;
    }
    if (tag === 0x02) break;
    return [];
  }
  if (at >= end) return [];

  const size = table.getUint32(at + 1, true);
  const plc = at + 5;
  const count = Math.floor((size - 4) / 12);
  if (count <= 0) return [];

  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const cp = table.getUint32(plc + i * 4, true);
    const cpEnd = table.getUint32(plc + (i + 1) * 4, true);
    const pcd = plc + (count + 1) * 4 + i * 8;
    const raw = table.getUint32(pcd + 2, true);

    /* Bit 30 set means the piece is *not* Unicode: clear it and halve, and the
       result is the byte offset of one-byte-per-character text. It reads
       backwards until you remember the bit was carved out of an offset field
       that was already there. */
    const narrow = (raw & 0x40000000) !== 0;
    pieces.push({ cp, cpEnd, fc: narrow ? (raw & 0x3fffffff) >>> 1 : raw & 0x3fffffff, narrow });
  }
  return pieces;
}

/* ── sprms: the property lists ───────────────────────────────────────── */

/**
 * How many bytes of operand a single `sprm` carries.
 *
 * The size is encoded in the sprm's own top three bits, which is what makes a
 * property list walkable without knowing what any of the properties mean — a
 * reader can skip what it does not understand and still find what it does.
 */
function operandLength(sprm: number, data: DataView, at: number): number {
  switch (sprm >> 13) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    default:
      /* Variable. The length is in the first byte of the operand — except for
         the two sprms that carry a whole table definition or tab-stop list,
         where it is the first two. */
      return sprm === 0xd608 || sprm === 0xc615
        ? 2 + data.getUint16(at, true)
        : 1 + data.getUint8(at);
  }
}

/** Walks a property list, handing each sprm and the position of its operand to `visit`. */
function eachSprm(data: DataView, from: number, to: number, visit: (sprm: number, at: number) => void): void {
  let at = from;
  while (at + 2 <= to) {
    const sprm = data.getUint16(at, true);
    if (sprm === 0) break;
    const operand = at + 2;
    const length = operandLength(sprm, data, operand);
    if (length < 0 || operand + length > to) break;
    visit(sprm, operand);
    at = operand + length;
  }
}

/* ── the property pages ──────────────────────────────────────────────── */

/** Paragraph properties, as far as a reading view needs them. */
export interface Pap {
  /** The style index — how a heading is recognised. */
  istd: number;
  inTable: boolean;
  /** This paragraph is the mark that ends a table row. */
  rowEnd: boolean;
  /** 0 left, 1 centre, 2 right, 3 justified. */
  jc: number;
  /** A list reference; anything but zero means the paragraph is a list item. */
  ilfo: number;
  ilvl: number;
}

/** Character properties — the four a reader can honestly show. */
export interface Chp {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

const PLAIN: Chp = { bold: false, italic: false, underline: false, strike: false };

/** A byte range of the stream and the properties that hold over it. */
interface Span<T> {
  fc: number;
  lim: number;
  props: T;
}

/**
 * The page numbers of the property pages, out of a `PlcBte`.
 *
 * Another `Plc`: byte positions first, then one four-byte entry per page whose
 * low 22 bits are the number of a 512-byte page in the `WordDocument` stream.
 */
function pagesOf(table: DataView, fc: number, lcb: number): number[] {
  if (lcb < 12) return [];
  const count = Math.floor((lcb - 4) / 8);
  const base = fc + (count + 1) * 4;
  const pages: number[] = [];
  for (let i = 0; i < count; i++) pages.push(table.getUint32(base + i * 4, true) & 0x003fffff);
  return pages;
}

/**
 * One FKP page — 512 bytes ending in a count, holding `n + 1` byte positions,
 * `n` fixed-size entries pointing at property lists, and the lists themselves
 * packed into whatever space is left.
 *
 * Paragraphs and characters use the same page layout with two differences: the
 * entry is thirteen bytes for a paragraph and one for a character, and a
 * paragraph's list begins with a two-byte style index that a character's does
 * not have. Everything else — including the odd little length convention,
 * where a leading zero means "the real length is in the next byte, doubled" —
 * is shared, so the two readers below differ only where the format does.
 */
function papxPage(doc: DataView, page: number, out: Span<Pap>[]): void {
  const base = page * 512;
  if (base + 512 > doc.byteLength) return;
  const count = doc.getUint8(base + 511);
  if (count === 0) return;

  for (let i = 0; i < count; i++) {
    const fc = doc.getUint32(base + i * 4, true);
    const lim = doc.getUint32(base + (i + 1) * 4, true);
    const word = doc.getUint8(base + (count + 1) * 4 + i * 13);

    const props: Pap = { istd: 0, inTable: false, rowEnd: false, jc: 0, ilfo: 0, ilvl: 0 };
    if (word !== 0) {
      const at = base + word * 2;
      const first = doc.getUint8(at);
      const start = first === 0 ? at + 2 : at + 1;
      const length = first === 0 ? doc.getUint8(at + 1) * 2 : first * 2 - 1;
      const end = Math.min(start + length, base + 511);

      if (start + 2 <= end) {
        props.istd = doc.getUint16(start, true);
        eachSprm(doc, start + 2, end, (sprm, operand) => {
          switch (sprm) {
            case 0x4600: // sprmPIstd — the style, said again
              props.istd = doc.getUint16(operand, true);
              break;
            case 0x2403: // sprmPJc80 — alignment
              props.jc = doc.getUint8(operand);
              break;
            case 0x2416: // sprmPFInTable
              props.inTable = doc.getUint8(operand) !== 0;
              break;
            case 0x2417: // sprmPFTtp — the row ends here
              props.rowEnd = doc.getUint8(operand) !== 0;
              break;
            case 0x460b: // sprmPIlfo — which list
              props.ilfo = doc.getUint16(operand, true);
              break;
            case 0x260a: // sprmPIlvl — how deep in it
              props.ilvl = doc.getUint8(operand);
              break;
            default:
              break;
          }
        });
      }
    }

    out.push({ fc, lim, props });
  }
}

function chpxPage(doc: DataView, page: number, out: Span<Chp>[]): void {
  const base = page * 512;
  if (base + 512 > doc.byteLength) return;
  const count = doc.getUint8(base + 511);
  if (count === 0) return;

  for (let i = 0; i < count; i++) {
    const fc = doc.getUint32(base + i * 4, true);
    const lim = doc.getUint32(base + (i + 1) * 4, true);
    const word = doc.getUint8(base + (count + 1) * 4 + i);

    const props: Chp = { ...PLAIN };
    if (word !== 0) {
      const at = base + word * 2;
      const length = doc.getUint8(at);
      const end = Math.min(at + 1 + length, base + 511);

      eachSprm(doc, at + 1, end, (sprm, operand) => {
        /* These four are toggles: 0 off, 1 on, and 128/129 meaning "whatever
           the style said" and "the opposite of it". Without the full style
           chain the honest reading of an inherit is the style's own value,
           which for the styles a reader shows is off. */
        const flag = (value: number) => value === 1;
        switch (sprm) {
          case 0x0835: // sprmCFBold
            props.bold = flag(doc.getUint8(operand));
            break;
          case 0x0836: // sprmCFItalic
            props.italic = flag(doc.getUint8(operand));
            break;
          case 0x0837: // sprmCFStrike
            props.strike = flag(doc.getUint8(operand));
            break;
          case 0x2a3e: // sprmCKul — a kind of underline, not a toggle
            props.underline = doc.getUint8(operand) !== 0;
            break;
          default:
            break;
        }
      });
    }

    out.push({ fc, lim, props });
  }
}

/** The last span starting at or before `fc` and reaching past it. */
function spanAt<T>(spans: Span<T>[], fc: number): T | null {
  let low = 0;
  let high = spans.length - 1;
  let found: Span<T> | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const span = spans[mid]!;
    if (span.lim <= fc) low = mid + 1;
    else if (span.fc > fc) high = mid - 1;
    else {
      found = span;
      break;
    }
  }
  return found ? found.props : null;
}

/* ── the stylesheet ──────────────────────────────────────────────────── */

/**
 * Style names, so a heading can be recognised as one.
 *
 * Two ways, because files disagree. A built-in style carries an `sti` — a
 * number Word assigns to styles it knows about, where 1 to 9 are the heading
 * levels — and that number is right whatever language the document was written
 * in. Styles a person made carry only a name, which is then all there is to go
 * on, and a document written in Croatian names its heading style `Naslov 1`.
 */
export interface Styles {
  /** Style index → the built-in identity, or -1. */
  sti: number[];
  names: string[];
}

function readStyles(table: DataView, fc: number, lcb: number): Styles {
  const out: Styles = { sti: [], names: [] };
  if (lcb < 4) return out;

  const cbStshi = table.getUint16(fc, true);
  const count = table.getUint16(fc + 2, true);
  /* How long the fixed part of a style record is. It has grown between Word
     versions, and the name sits right after it — reading the file's own number
     rather than assuming ten is the difference between names and mojibake. */
  const baseSize = cbStshi >= 4 ? table.getUint16(fc + 4, true) : 10;

  let at = fc + 2 + cbStshi;
  const end = fc + lcb;

  for (let i = 0; i < count && at + 2 <= end; i++) {
    const size = table.getUint16(at, true);
    if (size === 0) {
      // An empty slot: the index stays, the style does not exist.
      out.sti.push(-1);
      out.names.push('');
      at += 2;
      continue;
    }
    if (at + 2 + size > end) break;

    const std = at + 2;
    out.sti.push(table.getUint16(std, true) & 0x0fff);

    let name = '';
    const nameAt = std + baseSize;
    if (nameAt + 2 <= end) {
      const length = table.getUint16(nameAt, true);
      if (length > 0 && length < 256 && nameAt + 2 + length * 2 <= end) {
        for (let c = 0; c < length; c++) name += String.fromCharCode(table.getUint16(nameAt + 2 + c * 2, true));
      }
    }
    out.names.push(name);

    at += 2 + size + (size % 2);
  }

  return out;
}

/** Which heading level a style is, or 0 for none. */
export function headingLevel(styles: Styles, istd: number): number {
  const sti = styles.sti[istd];
  if (sti !== undefined && sti >= 1 && sti <= 9) return Math.min(sti, 6);

  /* A style somebody made themselves has no `sti`, and then its name is all
     there is. The names are the ones Word writes into a document authored in
     that language — a Croatian `.doc` really does say `Naslov 1`. */
  const match = /^(?:heading|naslov|überschrift|titre|título)\s*([1-9])$/i.exec((styles.names[istd] ?? '').trim());
  return match ? Math.min(Number(match[1]), 6) : 0;
}

/* ── reading the document ────────────────────────────────────────────── */

/** One paragraph as the walk over the text produces it, before it becomes HTML. */
export interface Para {
  runs: { text: string; chp: Chp }[];
  /** The paragraph ended at a cell mark rather than at an ordinary one. */
  cell: boolean;
  pap: Pap;
}

/** Everything read out of the file, before any of it becomes an element. */
export interface ParsedDoc {
  paragraphs: Para[];
  styles: Styles;
  notes: Set<string>;
}

const damaged = () =>
  new Error(t('This is not a valid Office file — it is probably damaged or incompletely downloaded.'));

/**
 * The file, read.
 *
 * Split from the view below it so the checks can run the hard half without a
 * browser: everything above this line is arithmetic over bytes, and it is where
 * every mistake in reading this format actually lives. What follows the split
 * builds elements and needs a DOM, so it is checked where one exists.
 */
export function parseDoc(bytes: Uint8Array): ParsedDoc {
  if (bytes.length < 512) throw damaged();

  let word: Uint8Array | null;
  let cfb: Cfb;
  try {
    cfb = new Cfb(bytes);
    word = cfb.stream('WordDocument');
  } catch {
    throw damaged();
  }
  if (!word) {
    throw new Error(t('The file has no Word document inside — it may be an old Excel or PowerPoint file.'));
  }

  const doc = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (doc.byteLength < 0x200 || doc.getUint16(0, true) !== 0xa5ec) throw damaged();

  /* Word 6 and 95 kept a different block at the front of this stream, with the
     pointers we are about to read at other offsets entirely. Saying so beats
     reading the wrong four bytes and drawing whatever they happen to mean. */
  const nFib = doc.getUint16(2, true);
  if (nFib < 0x00c1) {
    throw new Error(t('This is a Word 6 or 95 document, older still than Word 97 — it is not supported yet.'));
  }

  /* Which of the two table streams this file used. Both names exist in the
     wild; the bit says which one the pointers below refer to. */
  const flags = doc.getUint16(0x0a, true);
  const tableName = (flags & 0x0200) !== 0 ? '1Table' : '0Table';
  const tableBytes = cfb.stream(tableName) ?? cfb.stream('1Table', '0Table');
  if (!tableBytes) throw damaged();
  const table = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);

  /* The FIB is three variable-length arrays after a fixed head, each preceded
     by its own count — so the offsets of the pointers depend on the file. */
  const csw = doc.getUint16(0x20, true);
  const rgLwAt = 0x22 + csw * 2 + 2;
  const cslw = doc.getUint16(rgLwAt - 2, true);
  const rgFcLcbAt = rgLwAt + cslw * 4 + 2;
  const cbRgFcLcb = doc.getUint16(rgFcLcbAt - 2, true);
  if (cbRgFcLcb < 0x005d || rgFcLcbAt + cbRgFcLcb * 8 > doc.byteLength) throw damaged();

  const lw = (index: number) => (index < cslw ? doc.getUint32(rgLwAt + index * 4, true) : 0);
  const pair = (index: number): [number, number] => [
    doc.getUint32(rgFcLcbAt + index * 8, true),
    doc.getUint32(rgFcLcbAt + index * 8 + 4, true),
  ];

  const ccpText = lw(3);
  const ccpFtn = lw(4);
  const ccpHdd = lw(5);
  const ccpAtn = lw(7);

  const [fcStshf, lcbStshf] = pair(1);
  const [fcPlcfBteChpx, lcbPlcfBteChpx] = pair(12);
  const [fcPlcfBtePapx, lcbPlcfBtePapx] = pair(13);
  const [fcClx, lcbClx] = pair(33);

  if (lcbClx === 0 || fcClx + lcbClx > table.byteLength) throw damaged();

  const pieces = readPieces(table, fcClx, lcbClx);
  if (pieces.length === 0) throw damaged();

  const styles = readStyles(table, fcStshf, Math.min(lcbStshf, table.byteLength - fcStshf));

  const papx: Span<Pap>[] = [];
  for (const page of pagesOf(table, fcPlcfBtePapx, lcbPlcfBtePapx)) papxPage(doc, page, papx);
  papx.sort((a, b) => a.fc - b.fc);

  const chpx: Span<Chp>[] = [];
  for (const page of pagesOf(table, fcPlcfBteChpx, lcbPlcfBteChpx)) chpxPage(doc, page, chpx);
  chpx.sort((a, b) => a.fc - b.fc);

  const notes = new Set<string>();
  if (ccpHdd > 0) notes.add('Page headers and footers are not shown.');
  if (ccpFtn > 0) notes.add('Footnotes and endnotes are not shown.');
  if (ccpAtn > 0) notes.add('Comments are not shown.');

  /* ── the walk over the text ────────────────────────────────────────── */

  const limit = Math.min(ccpText, MAX_CHARS);
  if (ccpText > MAX_CHARS) notes.add('The document is very long — only its beginning is shown.');

  const paragraphs: Para[] = [];
  let runs: { text: string; chp: Chp }[] = [];
  let current = '';
  let chp: Chp = PLAIN;

  /* Fields — a page number, a cross-reference, a table of contents — are stored
     twice over: the instruction that computes them and the text Word last drew.
     Only the second is worth showing; the first is machinery. */
  let field = 0;
  let skipping = false;

  const closeRun = () => {
    if (current) runs.push({ text: current, chp });
    current = '';
  };

  const closePara = (cell: boolean, fc: number) => {
    closeRun();
    paragraphs.push({
      runs,
      cell,
      pap: spanAt(papx, fc) ?? { istd: 0, inTable: false, rowEnd: false, jc: 0, ilfo: 0, ilvl: 0 },
    });
    runs = [];
  };

  for (const piece of pieces) {
    if (piece.cp >= limit) break;
    const upto = Math.min(piece.cpEnd, limit);

    for (let cp = piece.cp; cp < upto; cp++) {
      const at = piece.fc + (cp - piece.cp) * (piece.narrow ? 1 : 2);
      if (at + (piece.narrow ? 1 : 2) > doc.byteLength) break;

      const code = piece.narrow ? doc.getUint8(at) : doc.getUint16(at, true);

      if (code === 0x13) {
        field++;
        skipping = true;
        continue;
      }
      if (code === 0x14) {
        /* The separator of the outermost field: what follows it is the result.
           One nested inside an instruction is still part of the instruction. */
        if (field <= 1) skipping = false;
        continue;
      }
      if (code === 0x15) {
        field = Math.max(0, field - 1);
        if (field === 0) skipping = false;
        continue;
      }

      if (code === 0x0d || code === 0x07) {
        closePara(code === 0x07, at);
        continue;
      }

      if (skipping) continue;

      const next = spanAt(chpx, at) ?? PLAIN;
      if (
        next.bold !== chp.bold ||
        next.italic !== chp.italic ||
        next.underline !== chp.underline ||
        next.strike !== chp.strike
      ) {
        closeRun();
        chp = next;
      }

      switch (code) {
        case 0x00:
        case 0x0c: // a page or section break — the view has no pages to break
          break;
        case 0x01:
        case 0x08:
          notes.add('Pictures and drawings in the old Word file are not shown.');
          break;
        case 0x02:
          notes.add('Footnotes and endnotes are not shown.');
          break;
        case 0x05:
          notes.add('Comments are not shown.');
          break;
        case 0x09:
          current += ' ';
          break;
        case 0x0b:
          // A line break inside a paragraph. Kept as a character and turned
          // into a `<br>` when the run is built.
          current += '\n';
          break;
        case 0x1e:
          current += NO_BREAK_HYPHEN;
          break;
        case 0x1f:
          current += SOFT_HYPHEN;
          break;
        default:
          if (code < 0x20) break;
          current +=
            piece.narrow && code >= 0x80 && code <= 0x9f
              ? String.fromCharCode(CP1252_HIGH[code - 0x80]!)
              : String.fromCharCode(code);
          break;
      }
    }
  }

  // Whatever the last paragraph mark left behind still belongs to the document.
  if (current || runs.length > 0) closePara(false, 0);

  /* What the format keeps and this reader does not read at all. Said once,
     above the document, rather than discovered by its absence — and said here
     rather than while building the view, because it is true of the file, not of
     how the file happens to be drawn. */
  notes.add('Fonts, sizes, colours and spacing are not shown — the text is set in the reading font.');
  if (paragraphs.some((para) => para.pap.ilfo !== 0)) {
    notes.add('Numbering is not carried over — numbered lists are shown as plain ones.');
  }

  return { paragraphs, styles, notes };
}

/* ── the view ────────────────────────────────────────────────────────── */

function runNodes(run: { text: string; chp: Chp }): Node[] {
  const parts = run.text.split('\n');
  const nodes: Node[] = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(document.createElement('br'));
    if (part) nodes.push(document.createTextNode(part));
  });
  if (nodes.length === 0) return nodes;

  let wrapper: HTMLElement | null = null;
  const wrap = (name: string) => {
    const el = document.createElement(name);
    if (wrapper) el.appendChild(wrapper);
    else for (const node of nodes) el.appendChild(node);
    wrapper = el;
  };

  if (run.chp.bold) wrap('strong');
  if (run.chp.italic) wrap('em');
  if (run.chp.underline) wrap('u');
  if (run.chp.strike) wrap('s');

  return wrapper ? [wrapper] : nodes;
}

function paraNodes(para: Para): Node[] {
  return para.runs.flatMap(runNodes);
}

/**
 * Paragraphs into a document.
 *
 * The two things that are inferred rather than read happen here: a run of
 * paragraphs marked as being in a table becomes a table, cut into cells at the
 * `\x07` marks and into rows at the paragraph that says the row ended; and a
 * run of paragraphs sharing a list reference becomes a list.
 */
function build(paragraphs: Para[], styles: Styles, notes: Set<string>): Preview {
  const body = document.createElement('div');
  body.className = 'ul-office-doc';
  const outline: PreviewOutline[] = [];

  let list: HTMLElement | null = null;
  let listKey = '';
  const closeList = () => {
    list = null;
    listKey = '';
  };

  for (let i = 0; i < paragraphs.length; ) {
    if (paragraphs[i]!.pap.inTable) {
      closeList();
      const table = document.createElement('table');
      let row = document.createElement('tr');
      let cell = document.createElement('td');
      let used = false;

      while (i < paragraphs.length && paragraphs[i]!.pap.inTable) {
        const para = paragraphs[i]!;
        i++;

        if (para.pap.rowEnd) {
          if (used) table.appendChild(row);
          row = document.createElement('tr');
          cell = document.createElement('td');
          used = false;
          continue;
        }

        const p = document.createElement('p');
        p.append(...paraNodes(para));
        cell.appendChild(p);

        if (para.cell) {
          row.appendChild(cell);
          cell = document.createElement('td');
          used = true;
        }
      }

      /* A row whose closing mark fell outside the table — a truncated file, or
         one this reader misread — still holds text somebody wants to see. */
      if (cell.childElementCount > 0) {
        row.appendChild(cell);
        used = true;
      }
      if (used) table.appendChild(row);
      if (table.childElementCount > 0) body.appendChild(table);
      continue;
    }

    const para = paragraphs[i]!;
    i++;

    const content = paraNodes(para);

    if (para.pap.ilfo !== 0 && content.length > 0) {
      const key = `${para.pap.ilfo}:${para.pap.ilvl}`;
      if (!list || key !== listKey) {
        list = document.createElement('ul');
        if (para.pap.ilvl > 0) list.dataset.level = String(Math.min(para.pap.ilvl, 4));
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
      const spacer = document.createElement('p');
      spacer.className = 'ul-office-blank';
      body.appendChild(spacer);
      continue;
    }

    const level = headingLevel(styles, para.pap.istd);
    if (level > 0) {
      const heading = document.createElement(`h${level}`);
      heading.append(...content);
      heading.id = `naslov-${outline.length}`;
      outline.push({
        id: heading.id,
        label: (heading.textContent ?? '').trim().slice(0, 120),
        depth: Math.min(level - 1, 3),
      });
      body.appendChild(heading);
      continue;
    }

    const p = document.createElement('p');
    if (para.pap.jc === 1) p.style.textAlign = 'center';
    if (para.pap.jc === 2) p.style.textAlign = 'right';
    if (para.pap.jc === 3) p.style.textAlign = 'justify';
    p.append(...content);
    body.appendChild(p);
  }

  return {
    title: '',
    body,
    text: (body.textContent ?? '').replace(/\s+/g, ' ').trim(),
    outline,
    notes: [...notes],
    release: () => {},
  };
}

export function readDoc(bytes: Uint8Array): Preview {
  const { paragraphs, styles, notes } = parseDoc(bytes);
  return build(paragraphs, styles, notes);
}
