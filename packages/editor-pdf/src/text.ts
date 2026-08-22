/**
 * Text added to a PDF — the font, the metrics and the appearance.
 *
 * This file is deliberately maths only, with no file fetching and no DOM, so the
 * same code runs in the browser and in the checks under Node. The font bytes are
 * supplied by the caller through `FontLoader`.
 *
 * **Why the font is embedded at all.** The standard fourteen PDF fonts use
 * WinAnsi encoding, in which `č`, `ć`, `ž`, `š` and `đ` do not exist — pdf-lib
 * throws on them, and readers that do not throw draw the wrong letter. Croatian
 * therefore cannot be written without an embedded font. We use Liberation Sans,
 * which arrives with pdf.js anyway (SIL OFL 1.1, metrically identical to Arial),
 * so no binary is committed to the repository and only the subset of glyphs
 * actually used goes into the output — a few kilobytes.
 */

import * as fontkitModule from '@pdf-lib/fontkit';
import type { Font as FontkitFont } from '@pdf-lib/fontkit';

import type { Rect, Rgb } from './annotations.js';

/*
 * `@pdf-lib/fontkit` has an ESM build with a default export and a UMD build with
 * named ones, while the types describe only the named. Vite takes one, Node the
 * other — so we take whatever actually exists instead of guessing by
 * environment.
 */
interface Fontkit {
  create(bytes: Uint8Array): FontkitFont;
}
export const fontkit: Fontkit =
  (fontkitModule as unknown as { default?: Fontkit }).default ??
  (fontkitModule as unknown as Fontkit);

/** The four cuts of Liberation Sans, which is what "bold" and "italic" pick between. */
export type TextFace = 'sans' | 'sans-bold' | 'sans-italic' | 'sans-bold-italic';

export const TEXT_FACES: {
  id: TextFace;
  label: string;
  weight: number;
  style: string;
  bold: boolean;
  italic: boolean;
}[] = [
  { id: 'sans', label: 'Regular', weight: 400, style: 'normal', bold: false, italic: false },
  { id: 'sans-bold', label: 'Bold', weight: 700, style: 'normal', bold: true, italic: false },
  { id: 'sans-italic', label: 'Italic', weight: 400, style: 'italic', bold: false, italic: true },
  {
    id: 'sans-bold-italic',
    label: 'Bold Italic',
    weight: 700,
    style: 'italic',
    bold: true,
    italic: true,
  },
];

/**
 * Bold and italic as two switches rather than one list of four names.
 *
 * That is how every editor since the first one has put it, and it is the only
 * arrangement in which "make this bold" stays one click on text that is already
 * italic.
 */
export function faceFor(bold: boolean, italic: boolean): TextFace {
  return TEXT_FACES.find((f) => f.bold === bold && f.italic === italic)?.id ?? 'sans';
}

/** What the two switches read as for a given cut. */
export function switchesOf(face: TextFace): { bold: boolean; italic: boolean } {
  const spec = TEXT_FACES.find((f) => f.id === face);
  return { bold: spec?.bold ?? false, italic: spec?.italic ?? false };
}

/** The family the same font is registered under in the browser, so the view matches the file. */
export const FONT_FAMILY = 'ulEditor Sans';

export const TEXT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
export const DEFAULT_TEXT_SIZE = 11;

/** The padding from the box edge to the text, in points. */
export const TEXT_PADDING = 2;

/** Fetching the bytes of one face. The browser downloads them, a check reads them off disk. */
export type FontLoader = (face: TextFace) => Promise<Uint8Array>;

/* ── mjere ───────────────────────────────────────────────────────────── */

export interface FaceMetrics {
  face: TextFace;
  bytes: Uint8Array;
  /** The line height in points for a given size. */
  lineHeight(size: number): number;
  /** The distance from the top of the line to the baseline. */
  ascent(size: number): number;
  /** The width of one line in points. */
  measure(line: string, size: number): number;
  /** The width of one character in thousandths of an em — the unit PDF works in. */
  widthOfCodePoint(codePoint: number): number;
  /** Characters this face lacks — unique, in order of appearance. */
  missing(text: string): string[];
}

export function metricsOf(face: TextFace, bytes: Uint8Array): FaceMetrics {
  const font = fontkit.create(bytes);
  const perEm = font.unitsPerEm;

  return {
    face,
    bytes,
    lineHeight: (size) => ((font.ascent - font.descent) / perEm) * size,
    ascent: (size) => (font.ascent / perEm) * size,
    measure: (line, size) => {
      if (line.length === 0) return 0;
      /* The same maths pdf-lib uses to lay out glyphs when writing, so the box
         on screen and the box in the file do not drift apart. */
      return (font.layout(line).advanceWidth / perEm) * size;
    },
    widthOfCodePoint: (codePoint) => {
      if (!font.hasGlyphForCodePoint(codePoint)) return 0;
      return (font.glyphForCodePoint(codePoint).advanceWidth / perEm) * 1000;
    },
    missing: (text) => {
      const out: string[] = [];
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') continue;
        const cp = ch.codePointAt(0);
        if (cp === undefined || font.hasGlyphForCodePoint(cp)) continue;
        if (!out.includes(ch)) out.push(ch);
      }
      return out;
    },
  };
}

/** Loaded faces by font — the same one is not parsed twice. */
const cache = new Map<TextFace, Promise<FaceMetrics>>();

export function loadFace(face: TextFace, loader: FontLoader): Promise<FaceMetrics> {
  const existing = cache.get(face);
  if (existing) return existing;

  const pending = loader(face).then((bytes) => metricsOf(face, bytes));
  cache.set(face, pending);
  // A failure is not remembered: the next attempt must be allowed to try again.
  void pending.catch(() => cache.delete(face));
  return pending;
}

/* ── metrike standardnih fontova ─────────────────────────────────────── */

/**
 * The codes 0x80–0x9F in WinAnsi encoding.
 *
 * Below 0x80 WinAnsi equals ASCII, and from 0xA0 on it is Latin-1; only this
 * stretch differs, and it holds the quotation marks, dashes and similar
 * punctuation.
 */
const WIN_ANSI_HIGH = [
  0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
  0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

export function winAnsiCodePoint(code: number): number | null {
  if (code >= 0x80 && code <= 0x9f) {
    const mapped = WIN_ANSI_HIGH[code - 0x80] ?? 0;
    return mapped === 0 ? null : mapped;
  }
  return code >= 32 ? code : null;
}

export interface StandardWidths {
  /** The width of a code in thousandths, or `null` if the font is not recognised. */
  widthOf(baseFont: string, code: number): number | null;
}

/** `ABCDEF+Helvetica-Bold` → `Helvetica-Bold`. */
function baseName(name: string): string {
  return name.replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
}

/**
 * Metrics for the standard fourteen fonts, which are allowed to omit `/Widths`.
 *
 * Without this every simply generated PDF — and nearly all invoices, receipts
 * and forms are exactly that — would come out as "cannot be touched", because
 * without widths there is no telling where one glyph ends.
 *
 * Helvetica is measured with Liberation Sans. That is not an approximation:
 * Liberation was built so its widths match Arial's, and Arial's match
 * Helvetica's. Courier is monospaced at 600 throughout. Times, Symbol and
 * ZapfDingbats stay unrecognised and that is reported, rather than guessed at.
 */
export async function standardWidths(load: FontLoader): Promise<StandardWidths> {
  const regular = await loadFace('sans', load);
  const bold = await loadFace('sans-bold', load);

  const faceFor = (name: string): FaceMetrics | null => {
    const lower = name.toLowerCase();
    if (lower.startsWith('helvetica') || lower.startsWith('arial')) {
      // Italic has the same widths as the upright face — in Arial and Helvetica
      // the shape differs, not the spacing.
      return lower.includes('bold') ? bold : regular;
    }
    return null;
  };

  return {
    widthOf(baseFont, code) {
      const name = baseName(baseFont);
      const lower = name.toLowerCase();

      if (lower.startsWith('courier')) return 600;

      const face = faceFor(name);
      if (!face) return null;

      const cp = winAnsiCodePoint(code);
      if (cp === null) return 0;
      return face.widthOfCodePoint(cp);
    },
  };
}

/* ── raspored okvira ─────────────────────────────────────────────────── */

/** An empty box must stay large enough to be clickable. */
const MIN_WIDTH_EM = 4;

export function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * The box for a given text.
 *
 * The anchor is the **top-left corner**, because while typing the box grows down
 * and to the right — as it does everywhere else. PDF counts from the bottom, so
 * that is converted here once and then never thought about again.
 *
 * There is no wrapping: a line is what the user typed as a line. Automatic
 * wrapping would require the break in a `<textarea>` and the break in the file
 * to agree to the pixel, and they do not — so the saved PDF would look different
 * from what the user saw while typing.
 */
export function layoutTextBox(
  metrics: FaceMetrics,
  text: string,
  size: number,
  anchor: { x: number; top: number },
): Rect {
  const lines = linesOf(text);
  const widest = lines.reduce((max, line) => Math.max(max, metrics.measure(line, size)), 0);

  const width = Math.max(widest, size * MIN_WIDTH_EM) + TEXT_PADDING * 2;
  const height = lines.length * metrics.lineHeight(size) + TEXT_PADDING * 2;

  return { x: anchor.x, y: anchor.top - height, width, height };
}

/** The top edge of the box — the anchor it is recomputed from when the text changes. */
export function topOf(rect: Rect): number {
  return rect.y + rect.height;
}

/* ── izgled (/AP) ────────────────────────────────────────────────────── */

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The appearance stream content for a `/FreeText`.
 *
 * Without one, most readers draw nothing: the specification permits a reader to
 * assemble the appearance from `/DA`, but pdf.js and browsers do not do so for
 * `/FreeText`. An annotation without `/AP` is therefore invisible everywhere
 * except Acrobat — and an invisible signature is worse than none.
 *
 * The coordinates live inside the `BBox`, so from the bottom left, with the
 * origin at the corner of the box. `resource` is the name the font is registered
 * under in the stream's `Resources`.
 */
export function appearanceContent(
  lines: string[],
  encodeLine: (line: string) => string,
  size: number,
  color: Rgb,
  metrics: FaceMetrics,
  height: number,
  resource: string,
  underline = false,
): string {
  const leading = metrics.lineHeight(size);
  const firstBaseline = height - TEXT_PADDING - metrics.ascent(size);
  const [r, g, b] = color;

  const out: string[] = [
    'q',
    'BT',
    `/${resource} ${round(size)} Tf`,
    `${round(leading)} TL`,
    `${round(r)} ${round(g)} ${round(b)} rg`,
    `${round(TEXT_PADDING)} ${round(firstBaseline)} Td`,
  ];

  lines.forEach((line, index) => {
    // `T*` before the line, not after: the first line is already positioned by `Td`.
    if (index > 0) out.push('T*');
    if (line.length > 0) out.push(`${encodeLine(line)} Tj`);
  });

  out.push('ET');

  /*
   * The rule is drawn, not typed: PDF has no underline of its own, and every
   * program that offers one fills a thin rectangle under the baseline. After
   * `ET` because a filled rectangle is a path, and a path cannot be built inside
   * a text object.
   */
  if (underline) {
    out.push(`${round(r)} ${round(g)} ${round(b)} rg`);
    lines.forEach((line, index) => {
      const width = metrics.measure(line, size);
      if (width <= 0) return;
      const baseline = firstBaseline - leading * index;
      out.push(
        `${round(TEXT_PADDING)} ${round(baseline - UNDERLINE_DROP * size)} ` +
          `${round(width)} ${round(UNDERLINE_WEIGHT * size)} re`,
        'f',
      );
    });
  }

  out.push('Q');
  return out.join('\n');
}

/** How far under the baseline the rule sits, and how thick it is — both in ems. */
const UNDERLINE_DROP = 0.11;
const UNDERLINE_WEIGHT = 0.055;
