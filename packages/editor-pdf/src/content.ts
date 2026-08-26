/**
 * Reading a page's content stream — where each glyph actually sits.
 *
 * A PDF has no sentences, only operators that draw glyphs at given positions. For
 * text to be **removed from the document** rather than covered with a rectangle,
 * one has to know which byte in the content stream corresponds to which glyph and
 * how much space that glyph takes. That is what this file works out.
 *
 * The rule that shapes everything else: **when it is not known, it is not
 * touched.** A stream that uses a font without a widths table, a Type3 font or
 * text inside a Form XObject is not turned into guesswork here; the code reports
 * that it cannot. A redaction that quietly misses part of the text is worse than
 * no redaction at all — in the first case the user believes the job is done.
 *
 * Deliberately free of DOM and of pdf.js: the same code runs in the browser and
 * in the checks under Node.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';

import type { Rect, Rgb } from './annotations.js';
import { winAnsiCodePoint, type StandardWidths } from './text.js';

/* ── matrice ─────────────────────────────────────────────────────────── */

/** `[a b c d e f]`, the way PDF writes them. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n` — the order as in the PDF: the left one first, then the right. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* ── lexical scanning ────────────────────────────────────────────────── */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export type Token =
  | { kind: 'number'; start: number; end: number; value: number }
  | { kind: 'string'; start: number; end: number; bytes: Uint8Array }
  | { kind: 'name'; start: number; end: number; value: string }
  | { kind: 'array-open' | 'array-close'; start: number; end: number }
  | { kind: 'dict-open' | 'dict-close'; start: number; end: number }
  | { kind: 'operator'; start: number; end: number; value: string };

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITER.has(byte);
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/**
 * Splits the stream into tokens, each with its own byte range.
 *
 * The ranges are why this exists: the output is not reassembled from scratch, a
 * replacement is spliced into the source bytes only where it belongs. Everything
 * this code does not understand stays untouched, byte for byte.
 */
export function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i]!;

    if (WHITESPACE.has(byte)) {
      i++;
      continue;
    }

    // A comment to the end of the line.
    if (byte === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }

    const start = i;

    if (byte === 0x5b) {
      tokens.push({ kind: 'array-open', start, end: ++i });
      continue;
    }
    if (byte === 0x5d) {
      tokens.push({ kind: 'array-close', start, end: ++i });
      continue;
    }

    if (byte === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
        tokens.push({ kind: 'dict-open', start, end: i });
        continue;
      }
      // A hexadecimal string.
      i++;
      const out: number[] = [];
      let high = -1;
      while (i < bytes.length && bytes[i] !== 0x3e) {
        const value = hexValue(bytes[i]!);
        i++;
        if (value < 0) continue;
        if (high < 0) high = value;
        else {
          out.push(high * 16 + value);
          high = -1;
        }
      }
      // An odd number of digits: the last is padded with a zero, as the spec requires.
      if (high >= 0) out.push(high * 16);
      i++; // '>'
      tokens.push({ kind: 'string', start, end: i, bytes: Uint8Array.from(out) });
      continue;
    }

    if (byte === 0x3e && bytes[i + 1] === 0x3e) {
      i += 2;
      tokens.push({ kind: 'dict-close', start, end: i });
      continue;
    }

    if (byte === 0x28) {
      i++;
      const out: number[] = [];
      let depth = 1;
      while (i < bytes.length) {
        const ch = bytes[i]!;
        if (ch === 0x5c) {
          const next = bytes[i + 1];
          i += 2;
          if (next === undefined) break;
          switch (next) {
            case 0x6e: out.push(0x0a); break;
            case 0x72: out.push(0x0d); break;
            case 0x74: out.push(0x09); break;
            case 0x62: out.push(0x08); break;
            case 0x66: out.push(0x0c); break;
            case 0x0a: break; // a line continuation
            case 0x0d:
              if (bytes[i] === 0x0a) i++;
              break;
            default:
              if (next >= 0x30 && next <= 0x37) {
                // Oktalno, do tri znamenke.
                let code = next - 0x30;
                for (let k = 0; k < 2; k++) {
                  const digit = bytes[i];
                  if (digit === undefined || digit < 0x30 || digit > 0x37) break;
                  code = code * 8 + (digit - 0x30);
                  i++;
                }
                out.push(code & 0xff);
              } else {
                out.push(next);
              }
          }
          continue;
        }
        if (ch === 0x28) depth++;
        if (ch === 0x29) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        out.push(ch);
        i++;
      }
      tokens.push({ kind: 'string', start, end: i, bytes: Uint8Array.from(out) });
      continue;
    }

    if (byte === 0x2f) {
      i++;
      let name = '';
      while (i < bytes.length && isRegular(bytes[i]!)) {
        if (bytes[i] === 0x23 && hexValue(bytes[i + 1] ?? -1) >= 0 && hexValue(bytes[i + 2] ?? -1) >= 0) {
          name += String.fromCharCode(hexValue(bytes[i + 1]!) * 16 + hexValue(bytes[i + 2]!));
          i += 3;
          continue;
        }
        name += String.fromCharCode(bytes[i]!);
        i++;
      }
      tokens.push({ kind: 'name', start, end: i, value: name });
      continue;
    }

    // Braces `{}` occur only in shading functions; they are skipped as a character.
    if (byte === 0x7b || byte === 0x7d) {
      i++;
      tokens.push({ kind: 'operator', start, end: i, value: String.fromCharCode(byte) });
      continue;
    }

    let raw = '';
    while (i < bytes.length && isRegular(bytes[i]!)) {
      raw += String.fromCharCode(bytes[i]!);
      i++;
    }
    if (raw.length === 0) {
      // An unknown delimiter — advance so we do not get stuck.
      i++;
      continue;
    }

    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) {
      tokens.push({ kind: 'number', start, end: i, value: Number(raw) });
      continue;
    }

    // An inline image: raw bytes follow `ID` up to `EI`.
    if (raw === 'BI') {
      const idAt = indexOfOperator(bytes, i, 'ID');
      if (idAt >= 0) {
        const eiAt = indexOfOperator(bytes, idAt + 2, 'EI');
        i = eiAt >= 0 ? eiAt + 2 : bytes.length;
      }
      tokens.push({ kind: 'operator', start, end: i, value: 'BI' });
      continue;
    }

    tokens.push({ kind: 'operator', start, end: i, value: raw });
  }

  return tokens;
}

/** Looks for an operator as a standalone word, not as part of a byte string. */
function indexOfOperator(bytes: Uint8Array, from: number, word: string): number {
  const first = word.charCodeAt(0);
  const second = word.charCodeAt(1);
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] !== first || bytes[i + 1] !== second) continue;
    const before = i === 0 ? 0x20 : bytes[i - 1]!;
    const after = bytes[i + 2];
    if (!WHITESPACE.has(before) && !DELIMITER.has(before)) continue;
    if (after !== undefined && isRegular(after)) continue;
    return i;
  }
  return -1;
}

/* ── fonts ───────────────────────────────────────────────────────────── */

/**
 * What has to be known about a font for its glyphs to be measured.
 *
 * How the font looks is of no interest — only how much space each code takes and
 * how many bytes one code is. Without that there is no telling where one glyph
 * ends and the next begins, and therefore no telling what is inside a rectangle.
 */
export interface FontInfo {
  name: string;
  /** `/BaseFont` without its subset prefix. */
  baseFont: string;
  /** A composite font with Identity encoding — two bytes per code. */
  twoByte: boolean;
  /** The width of a code in thousandths of a text unit. */
  widthOf(code: number): number;
  /**
   * Code → character, where it is reliably known.
   *
   * `null` means the code cannot be turned into a letter: without `/ToUnicode`
   * and without a known encoding the text can be removed but not read — so it
   * cannot be offered for rewriting either.
   */
  decode(code: number): string | null;
  /**
   * Character → code: `decode` read backwards.
   *
   * This is what lets a line be retyped **in the document's own font** rather
   * than in ours. `null` means this font cannot write that character — an
   * embedded font carries only the glyphs the document already used, so a `č`
   * added to a document that never had one has nowhere to come from.
   */
  encode(char: string): number | null;
  /** Why the font cannot be measured; `null` when all is well. */
  unsupported: string | null;
}

/**
 * Reads the `/ToUnicode` CMap — the only reliable route from a code to a letter.
 *
 * The format resembles PostScript, so it is scanned with the same lexer as the
 * content stream. The destinations are UTF-16BE strings, because one code is
 * allowed to yield several characters (ligatures).
 */
function parseToUnicode(bytes: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const tokens = tokenize(bytes);

  const asCode = (token: Token | undefined): number | null => {
    if (token?.kind !== 'string') return null;
    let value = 0;
    for (const byte of token.bytes) value = value * 256 + byte;
    return value;
  };
  const asText = (token: Token | undefined): string | null => {
    if (token?.kind !== 'string') return null;
    let out = '';
    for (let i = 0; i + 1 < token.bytes.length; i += 2) {
      out += String.fromCharCode((token.bytes[i]! << 8) | token.bytes[i + 1]!);
    }
    return out;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'operator') continue;

    if (token.value === 'beginbfchar') {
      for (let k = i + 1; k + 1 < tokens.length; k += 2) {
        if (tokens[k]!.kind === 'operator') break;
        const code = asCode(tokens[k]);
        const text = asText(tokens[k + 1]);
        if (code !== null && text !== null) map.set(code, text);
      }
      continue;
    }

    if (token.value === 'beginbfrange') {
      let k = i + 1;
      while (k < tokens.length && tokens[k]!.kind !== 'operator') {
        const low = asCode(tokens[k]);
        const high = asCode(tokens[k + 1]);
        const third = tokens[k + 2];
        if (low === null || high === null || !third) break;

        if (third.kind === 'array-open') {
          // The form `<lo> <hi> [<d1> <d2> …]`: one destination per code.
          let index = 0;
          let at = k + 3;
          while (at < tokens.length && tokens[at]!.kind !== 'array-close') {
            const text = asText(tokens[at]);
            if (text !== null) map.set(low + index, text);
            index++;
            at++;
          }
          k = at + 1;
          continue;
        }

        const start = asText(third);
        if (start === null) break;
        // The form `<lo> <hi> <start>`: the last character of the destination increments.
        const prefix = start.slice(0, -1);
        const last = start.charCodeAt(start.length - 1);
        for (let code = low; code <= high && code - low <= 65535; code++) {
          map.set(code, prefix + String.fromCharCode(last + (code - low)));
        }
        k += 3;
      }
    }
  }

  return map;
}

function readToUnicode(font: PDFDict): Map<number, string> | null {
  const stream = font.lookup(PDFName.of('ToUnicode'));
  if (!(stream instanceof PDFRawStream)) return null;
  try {
    return parseToUnicode(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
}

function numberAt(array: PDFArray | undefined, index: number): number | undefined {
  const value = array?.lookup(index);
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

function simpleWidths(font: PDFDict): ((code: number) => number) | null {
  const widths = font.lookup(PDFName.of('Widths'));
  const firstChar = font.lookup(PDFName.of('FirstChar'));
  if (!(widths instanceof PDFArray) || !(firstChar instanceof PDFNumber)) return null;

  const first = firstChar.asNumber();
  const missing = (() => {
    const descriptor = font.lookup(PDFName.of('FontDescriptor'));
    const value =
      descriptor instanceof PDFDict ? descriptor.lookup(PDFName.of('MissingWidth')) : undefined;
    return value instanceof PDFNumber ? value.asNumber() : 0;
  })();

  return (code) => numberAt(widths, code - first) ?? missing;
}

/**
 * The widths of a composite font from the `/W` array.
 *
 * The format is twofold: `c [w1 w2 …]` enumerates consecutive codes, while
 * `c1 c2 w` gives one width to a whole range. Both are supported, because in
 * practice they turn up mixed within one file.
 */
function compositeWidths(descendant: PDFDict): (code: number) => number {
  const defaultWidth = (() => {
    const dw = descendant.lookup(PDFName.of('DW'));
    return dw instanceof PDFNumber ? dw.asNumber() : 1000;
  })();

  const table = new Map<number, number>();
  const w = descendant.lookup(PDFName.of('W'));

  if (w instanceof PDFArray) {
    let i = 0;
    while (i < w.size()) {
      const start = numberAt(w, i);
      const next = w.lookup(i + 1);
      if (start === undefined) break;

      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k++) {
          const width = numberAt(next, k);
          if (width !== undefined) table.set(start + k, width);
        }
        i += 2;
        continue;
      }

      const end = numberAt(w, i + 1);
      const width = numberAt(w, i + 2);
      if (end === undefined || width === undefined) break;
      // The range can be enormous in CJK fonts; the rule is kept, not every code.
      if (end - start <= 65535) {
        for (let code = start; code <= end; code++) table.set(code, width);
      }
      i += 3;
    }
  }

  return (code) => table.get(code) ?? defaultWidth;
}

/**
 * Whether the glyphs travel with the document.
 *
 * It decides whether a code may be trusted without `/ToUnicode`. A font that is
 * only named is drawn from the reader's own copy, so the whole standard encoding
 * is there to write with. An embedded one is usually a subset — the code for `Q`
 * is in the table whether or not the document ever drew a `Q`, and writing it
 * would produce a blank.
 */
function isEmbedded(font: PDFDict): boolean {
  const descendants = font.lookup(PDFName.of('DescendantFonts'));
  const inner = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  const descriptor = (inner instanceof PDFDict ? inner : font).lookup(PDFName.of('FontDescriptor'));
  if (!(descriptor instanceof PDFDict)) return false;
  return ['FontFile', 'FontFile2', 'FontFile3'].some(
    (key) => descriptor.get(PDFName.of(key)) !== undefined,
  );
}

/** Whether the font has its own code mapping, which would shift the widths table. */
function hasDifferences(font: PDFDict): boolean {
  const encoding = font.lookup(PDFName.of('Encoding'));
  return encoding instanceof PDFDict && !!encoding.get(PDFName.of('Differences'));
}

/** Reads `/Font` out of the page resources and turns it into measurable descriptions. */
export function readFonts(
  resources: PDFDict | undefined,
  standard?: StandardWidths,
): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const fonts = resources?.lookup(PDFName.of('Font'));
  if (!(fonts instanceof PDFDict)) return out;

  for (const [key] of fonts.entries()) {
    const name = key.asString().replace(/^\//, '');
    const font = fonts.lookup(key);

    /** Fills in the shared fields so every branch does not repeat them. */
    const describe = (partial: Omit<FontInfo, 'name' | 'baseFont' | 'decode' | 'encode'>): FontInfo => {
      const raw = font instanceof PDFDict ? font.lookup(PDFName.of('BaseFont')) : undefined;
      const baseFont = (raw instanceof PDFName ? raw.asString() : '')
        .replace(/^\//, '')
        .replace(/^[A-Z]{6}\+/, '');

      const toUnicode = font instanceof PDFDict ? readToUnicode(font) : null;
      const winAnsi = !partial.twoByte && font instanceof PDFDict && !hasDifferences(font);
      const embedded = font instanceof PDFDict && isEmbedded(font);

      /*
       * Built on first use and kept: retyping asks for it once per character
       * typed, and a `/ToUnicode` map of a large font runs to thousands of
       * entries. The lowest code wins where two draw the same letter — either
       * would do, and picking deterministically keeps the output reproducible.
       */
      let reverse: Map<string, number> | null = null;
      const reverseMap = (): Map<string, number> => {
        if (reverse) return reverse;
        reverse = new Map();
        if (toUnicode) {
          for (const [code, text] of toUnicode) {
            if (!reverse.has(text)) reverse.set(text, code);
          }
        } else if (winAnsi && !embedded) {
          for (let code = 0; code < 256; code++) {
            const cp = winAnsiCodePoint(code);
            if (cp === null) continue;
            const char = String.fromCodePoint(cp);
            if (!reverse.has(char)) reverse.set(char, code);
          }
        }
        return reverse;
      };

      return {
        ...partial,
        name,
        baseFont,
        decode: (code) => {
          const mapped = toUnicode?.get(code);
          if (mapped !== undefined) return mapped;
          /*
           * Without `/ToUnicode` the only honest footing is the standard encoding
           * of a single-byte font. A composite font with Identity encoding gives
           * a glyph number inside the font, which says nothing about the letter.
           */
          if (!winAnsi) return null;
          const cp = winAnsiCodePoint(code);
          return cp === null ? null : String.fromCodePoint(cp);
        },
        /* A font we cannot measure must not be written with either: the codes
           would be right and every advance wrong. */
        encode: (char) => (partial.unsupported ? null : reverseMap().get(char) ?? null),
      };
    };

    if (!(font instanceof PDFDict)) {
      out.set(
        name,
        describe({ twoByte: false, widthOf: () => 0, unsupported: 'the font cannot be read' }),
      );
      continue;
    }

    const subtype = font.lookup(PDFName.of('Subtype'));
    const kind = subtype instanceof PDFName ? subtype.asString() : '';

    if (kind === '/Type3') {
      // The glyphs are content streams of their own; their width depends on the
      // font matrix and cannot be read out of a table.
      out.set(name, describe({ twoByte: false, widthOf: () => 0, unsupported: 'Type3 font' }));
      continue;
    }

    if (kind === '/Type0') {
      const encoding = font.lookup(PDFName.of('Encoding'));
      const encodingName = encoding instanceof PDFName ? encoding.asString() : '';
      if (encodingName !== '/Identity-H' && encodingName !== '/Identity-V') {
        // An embedded CMap would need a parser of its own to know how many bytes
        // make up one code.
        out.set(
          name,
          describe({
            twoByte: true,
            widthOf: () => 0,
            unsupported: `the ${encodingName || 'unnamed'} encoding`,
          }),
        );
        continue;
      }

      const descendants = font.lookup(PDFName.of('DescendantFonts'));
      const descendant =
        descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
      if (!(descendant instanceof PDFDict)) {
        out.set(
          name,
          describe({ twoByte: true, widthOf: () => 0, unsupported: 'no DescendantFonts' }),
        );
        continue;
      }

      out.set(
        name,
        describe({ twoByte: true, widthOf: compositeWidths(descendant), unsupported: null }),
      );
      continue;
    }

    const widths = simpleWidths(font);
    if (widths) {
      out.set(name, describe({ twoByte: false, widthOf: widths, unsupported: null }));
      continue;
    }

    /*
     * The standard fourteen fonts are allowed to omit `/Widths` — the metrics are
     * agreed. `standardWidths` knows them for Helvetica and Courier; for the rest
     * we admit we do not know.
     */
    const baseFont = font.lookup(PDFName.of('BaseFont'));
    const baseName = baseFont instanceof PDFName ? baseFont.asString() : '';

    if (hasDifferences(font)) {
      out.set(
        name,
        describe({
          twoByte: false,
          widthOf: () => 0,
          unsupported: 'a custom code mapping without a widths table',
        }),
      );
      continue;
    }

    const probe = standard?.widthOf(baseName, 0x41);
    if (standard && probe !== null && probe !== undefined) {
      out.set(
        name,
        describe({
          twoByte: false,
          widthOf: (code) => standard.widthOf(baseName, code) ?? 0,
          unsupported: null,
        }),
      );
      continue;
    }

    out.set(
      name,
      describe({
        twoByte: false,
        widthOf: () => 0,
        unsupported: `${baseName || 'font'} without a widths table`,
      }),
    );
  }

  return out;
}

/* ── walking the text ────────────────────────────────────────────────── */

export interface Glyph {
  /** The glyph code; one or two bytes depending on the font. */
  code: number;
  bytes: Uint8Array;
  /** The bounding rectangle in the page's user space. */
  box: Rect;
  /** The advance this glyph contributes, in text space. */
  advance: number;
}

export interface TextOperation {
  /** Raspon bajtova cijele naredbe, s operandima. */
  start: number;
  end: number;
  operator: 'Tj' | 'TJ' | "'" | '"';
  /** The parts of the operator in order: glyph strings and the numeric offsets from `TJ`. */
  parts: ({ kind: 'glyphs'; glyphs: Glyph[] } | { kind: 'adjust'; value: number })[];
  /** The text state at the time of the operator — needed when rewriting. */
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  /** The `'` and `"` operators carry a move to a new line inside them. */
  leading: number;

  font: FontInfo;
  /** 0 = fill, 3 = invisible (an OCR layer), the rest are strokes. */
  renderMode: number;
  /** The fill colour, or `null` when the colour space is not recognised. */
  fill: Rgb | null;
  /**
   * The font size as actually seen on the page — `Tf` multiplied by everything
   * the matrices piled on top of it.
   */
  effectiveSize: number;
  /** The baseline start of the first glyph, in user space. */
  origin: { x: number; y: number };
  /**
   * Whether the text sits horizontally and undistorted.
   *
   * Rotated or skewed text can be removed but not rewritten: our text boxes stand
   * upright, so a replacement would sit crooked.
   */
  axisAligned: boolean;
}

/** The operator's text, or `null` if the codes cannot be turned into letters. */
export function textOf(operation: TextOperation): string | null {
  let out = '';
  for (const part of operation.parts) {
    if (part.kind !== 'glyphs') continue;
    for (const glyph of part.glyphs) {
      const decoded = operation.font.decode(glyph.code);
      if (decoded === null) return null;
      out += decoded;
    }
  }
  return out;
}

/** The bounding rectangle of all the operator's glyphs. */
export function boundsOfOperation(operation: TextOperation): Rect | null {
  const boxes = operation.parts
    .filter((part) => part.kind === 'glyphs')
    .flatMap((part) => part.glyphs.map((glyph) => glyph.box));
  if (boxes.length === 0) return null;

  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/** Why a page is not safe to modify. */
export interface Obstacle {
  reason: string;
  /** The position it refers to, when that is known. */
  box?: Rect;
}

export interface PageContent {
  bytes: Uint8Array;
  operations: TextOperation[];
  obstacles: Obstacle[];
}

interface State {
  ctm: Matrix;
  font: FontInfo | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  fill: Rgb | null;
  /** The name of the colour space set by `cs`; needed to interpret `sc`/`scn`. */
  fillSpace: string;
}

/** Converts colour operands to RGB, or `null` when the space is not recognised. */
function colorFrom(operator: string, values: number[], space: string): Rgb | null {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  const fromCount = (count: number): Rgb | null => {
    if (count === 1) {
      const g = clamp(values[0] ?? 0);
      return [g, g, g];
    }
    if (count === 3) return [clamp(values[0] ?? 0), clamp(values[1] ?? 0), clamp(values[2] ?? 0)];
    if (count === 4) {
      // CMYK → RGB, by a simple conversion; a colour profile plays no part here.
      const [c = 0, m = 0, y = 0, k = 0] = values;
      return [clamp((1 - c) * (1 - k)), clamp((1 - m) * (1 - k)), clamp((1 - y) * (1 - k))];
    }
    return null;
  };

  switch (operator) {
    case 'g':
      return fromCount(1);
    case 'rg':
      return fromCount(3);
    case 'k':
      return fromCount(4);
    case 'sc':
    case 'scn': {
      // Named spaces (ICC, Separation, Pattern) need interpreting of their own;
      // guessing by operand count would give the wrong colour without a single
      // sign of warning, so we would rather admit we do not know.
      const device =
        space === '/DeviceGray' || space === '/DeviceRGB' || space === '/DeviceCMYK';
      return device ? fromCount(values.length) : null;
    }
    default:
      return null;
  }
}

function cloneState(state: State): State {
  return { ...state };
}

/** The glyph height above and below the baseline, in em units. */
const ASCENT = 0.78;
const DESCENT = -0.22;

function glyphsFrom(
  bytes: Uint8Array,
  font: FontInfo,
  state: State,
  tm: Matrix,
): { glyphs: Glyph[]; tm: Matrix } {
  const glyphs: Glyph[] = [];
  const step = font.twoByte ? 2 : 1;
  let matrix = tm;

  for (let i = 0; i + step <= bytes.length; i += step) {
    const code = step === 2 ? (bytes[i]! << 8) | bytes[i + 1]! : bytes[i]!;
    const width = font.widthOf(code) / 1000;

    const trm = multiply(
      [state.fontSize * state.horizontalScale, 0, 0, state.fontSize, 0, state.rise],
      multiply(matrix, state.ctm),
    );

    const [x0, y0] = apply(trm, 0, DESCENT);
    const [x1, y1] = apply(trm, width, ASCENT);

    // Rotated text yields its corners in any order.
    const box: Rect = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };

    const isSpace = step === 1 && code === 32;
    const advance =
      (width * state.fontSize + state.charSpacing + (isSpace ? state.wordSpacing : 0)) *
      state.horizontalScale;

    glyphs.push({ code, bytes: bytes.slice(i, i + step), box, advance });
    matrix = multiply([1, 0, 0, 1, advance, 0], matrix);
  }

  return { glyphs, tm: matrix };
}

/**
 * Walks the content stream and returns every operator that draws text, with the
 * position of each glyph.
 *
 * Obstacles are collected along the way: a font that cannot be measured, Type3
 * glyphs and Form XObjects that may contain text of their own. The caller decides
 * what to do with them, but cannot pretend they are not there.
 */
/**
 * The page's content, or nothing — for callers that cannot survive an exception.
 *
 * `readPageContent` throws when the content stream itself will not decode. That
 * happens in the wild: a file written by something that got the compression
 * header wrong, or repaired by a tool that left a stream behind. pdf.js is
 * tolerant enough to draw such a page, so it sits on screen looking perfectly
 * ordinary while nothing here can reach its glyphs — five files in one folder of
 * four hundred real PDFs.
 *
 * Every caller has its own way of saying *not this page*: a redaction refuses
 * it, a preview reports it as an obstacle, a click finds no line to retype.
 * None of them has a way of surviving an exception thrown from underneath, and
 * an exception in the save path costs the person the annotations they made as
 * well. So the failure is handed back as an absence, and each caller says what
 * it means in its own words.
 *
 * Deliberately **not** an empty page: for redaction, "no text here" reads as
 * success, and answering that about a page whose text could not be read is the
 * one answer that must never be given.
 */
export function pageContentOrNothing(page: PDFPage, standard?: StandardWidths): PageContent | null {
  try {
    return readPageContent(page, standard);
  } catch {
    return null;
  }
}

export function readPageContent(page: PDFPage, standard?: StandardWidths): PageContent {
  const bytes = contentsOf(page);
  const fonts = readFonts(page.node.Resources(), standard);
  const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'));

  const tokens = tokenize(bytes);
  const operations: TextOperation[] = [];
  const obstacles: Obstacle[] = [];
  const seenUnsupported = new Set<string>();

  let state: State = {
    ctm: IDENTITY,
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
    // PDF starts from a black fill in DeviceGray.
    fill: [0, 0, 0],
    fillSpace: '/DeviceGray',
  };
  const stack: State[] = [];

  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;

  /** Operandi skupljeni od zadnjeg operatora. */
  let operands: Token[] = [];
  /** Where the current operator begins — the first operand, or the operator itself. */
  let operandStart = 0;

  const numbers = () => operands.filter((o) => o.kind === 'number').map((o) => o.value);

  for (const token of tokens) {
    if (token.kind !== 'operator') {
      if (operands.length === 0) operandStart = token.start;
      operands.push(token);
      continue;
    }

    const op = token.value;
    const start = operands.length > 0 ? operandStart : token.start;
    const values = numbers();

    switch (op) {
      case 'q':
        stack.push(cloneState(state));
        break;
      case 'Q': {
        const previous = stack.pop();
        if (previous) state = previous;
        break;
      }
      case 'cm':
        if (values.length >= 6) {
          state.ctm = multiply(values.slice(-6) as Matrix, state.ctm);
        }
        break;

      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;

      case 'Tf': {
        const name = operands.find((o) => o.kind === 'name');
        state.fontSize = values[values.length - 1] ?? state.fontSize;
        state.font = name && name.kind === 'name' ? (fonts.get(name.value) ?? null) : null;
        if (state.font?.unsupported && !seenUnsupported.has(state.font.name)) {
          seenUnsupported.add(state.font.name);
          obstacles.push({ reason: `${state.font.name}: ${state.font.unsupported}` });
        }
        if (!state.font && name?.kind === 'name' && !seenUnsupported.has(name.value)) {
          seenUnsupported.add(name.value);
          obstacles.push({ reason: `${name.value}: the font is not in the page resources` });
        }
        break;
      }
      case 'Tc':
        state.charSpacing = values[0] ?? state.charSpacing;
        break;
      case 'Tw':
        state.wordSpacing = values[0] ?? state.wordSpacing;
        break;
      case 'Tz':
        state.horizontalScale = (values[0] ?? 100) / 100;
        break;
      case 'TL':
        state.leading = values[0] ?? state.leading;
        break;
      case 'Ts':
        state.rise = values[0] ?? state.rise;
        break;
      case 'Tr':
        state.renderMode = values[0] ?? state.renderMode;
        break;

      case 'cs': {
        const space = operands.find((o) => o.kind === 'name');
        state.fillSpace = space?.kind === 'name' ? `/${space.value}` : '';
        // A new colour space clears the old value, as the spec requires.
        state.fill = state.fillSpace === '/Pattern' ? null : [0, 0, 0];
        break;
      }
      case 'g':
      case 'rg':
      case 'k':
      case 'sc':
      case 'scn':
        state.fill = colorFrom(op, values, state.fillSpace);
        if (op === 'g') state.fillSpace = '/DeviceGray';
        if (op === 'rg') state.fillSpace = '/DeviceRGB';
        if (op === 'k') state.fillSpace = '/DeviceCMYK';
        break;

      case 'Td':
        if (values.length >= 2) {
          tlm = multiply([1, 0, 0, 1, values[0]!, values[1]!], tlm);
          tm = tlm;
        }
        break;
      case 'TD':
        if (values.length >= 2) {
          state.leading = -values[1]!;
          tlm = multiply([1, 0, 0, 1, values[0]!, values[1]!], tlm);
          tm = tlm;
        }
        break;
      case 'Tm':
        if (values.length >= 6) {
          tlm = values.slice(-6) as Matrix;
          tm = tlm;
        }
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        tm = tlm;
        break;

      case 'Do': {
        const name = operands.find((o) => o.kind === 'name');
        if (name?.kind === 'name' && xobjects instanceof PDFDict) {
          const target = xobjects.lookup(PDFName.of(name.value));
          const dict = target instanceof PDFRawStream ? target.dict : undefined;
          const subtype = dict?.lookup(PDFName.of('Subtype'));
          if (dict && subtype instanceof PDFName && subtype.asString() === '/Form') {
            obstacles.push({
              reason: `Form XObject ${name.value} — the text inside cannot be seen from here`,
              box: formBox(dict, state.ctm),
            });
          }
        }
        break;
      }

      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (op === "'" || op === '"') {
          if (op === '"' && values.length >= 2) {
            state.wordSpacing = values[0]!;
            state.charSpacing = values[1]!;
          }
          tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          tm = tlm;
        }

        const font = state.font;
        if (!font || font.unsupported) {
          // Without metrics there is no telling where the glyphs are; the obstacle is already recorded.
          break;
        }

        /* The matrix before the glyphs advance the text — this is where the line starts. */
        const trm = multiply(
          [state.fontSize * state.horizontalScale, 0, 0, state.fontSize, 0, state.rise],
          multiply(tm, state.ctm),
        );

        const parts: TextOperation['parts'] = [];

        if (op === 'TJ') {
          const array = operands.filter((o) => o.kind === 'string' || o.kind === 'number');
          for (const item of array) {
            if (item.kind === 'string') {
              const result = glyphsFrom(item.bytes, font, state, tm);
              tm = result.tm;
              parts.push({ kind: 'glyphs', glyphs: result.glyphs });
            } else if (item.kind === 'number') {
              const shift = (-item.value / 1000) * state.fontSize * state.horizontalScale;
              tm = multiply([1, 0, 0, 1, shift, 0], tm);
              parts.push({ kind: 'adjust', value: item.value });
            }
          }
        } else {
          const text = operands.find((o) => o.kind === 'string');
          if (text?.kind === 'string') {
            const result = glyphsFrom(text.bytes, font, state, tm);
            tm = result.tm;
            parts.push({ kind: 'glyphs', glyphs: result.glyphs });
          }
        }

        operations.push({
          start,
          end: token.end,
          operator: op,
          parts,
          fontSize: state.fontSize,
          charSpacing: state.charSpacing,
          wordSpacing: state.wordSpacing,
          horizontalScale: state.horizontalScale,
          leading: state.leading,
          font,
          renderMode: state.renderMode,
          fill: state.fill,
          effectiveSize: Math.hypot(trm[2], trm[3]),
          origin: { x: trm[4], y: trm[5] },
          axisAligned:
            Math.abs(trm[1]) < 1e-6 && Math.abs(trm[2]) < 1e-6 && trm[0] > 0 && trm[3] > 0,
        });
        break;
      }

      default:
        break;
    }

    operands = [];
  }

  return { bytes, operations, obstacles };
}

function formBox(dict: PDFDict, ctm: Matrix): Rect | undefined {
  const bbox = dict.lookup(PDFName.of('BBox'));
  if (!(bbox instanceof PDFArray) || bbox.size() < 4) return undefined;

  const matrixValue = dict.lookup(PDFName.of('Matrix'));
  const local: Matrix =
    matrixValue instanceof PDFArray && matrixValue.size() >= 6
      ? ([0, 1, 2, 3, 4, 5].map((i) => numberAt(matrixValue, i) ?? 0) as Matrix)
      : IDENTITY;

  const full = multiply(local, ctm);
  const corners = [
    [numberAt(bbox, 0) ?? 0, numberAt(bbox, 1) ?? 0],
    [numberAt(bbox, 2) ?? 0, numberAt(bbox, 1) ?? 0],
    [numberAt(bbox, 2) ?? 0, numberAt(bbox, 3) ?? 0],
    [numberAt(bbox, 0) ?? 0, numberAt(bbox, 3) ?? 0],
  ].map(([x, y]) => apply(full, x!, y!));

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The bytes of a page's content stream.
 *
 * `/Contents` may also be an array of streams read as one; they are joined with a
 * newline, because an operator must not be broken across the boundary.
 */
export function contentsOf(page: PDFPage): Uint8Array {
  const contents = page.node.Contents();
  const pieces: Uint8Array[] = [];

  const push = (value: unknown) => {
    if (value instanceof PDFRawStream) pieces.push(decodePDFRawStream(value).decode());
  };

  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) push(contents.lookup(i));
  } else {
    push(contents);
  }

  if (pieces.length === 0) return new Uint8Array(0);
  if (pieces.length === 1) return pieces[0]!;

  const total = pieces.reduce((sum, piece) => sum + piece.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
    out[at++] = 0x0a;
  }
  return out;
}
