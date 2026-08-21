/**
 * The annotation model and how it is written into a PDF.
 *
 * Annotations are written as REAL PDF annotation objects (`/Highlight`, `/Text`,
 * `/Ink`), not as a drawing stamped into the page content. The difference
 * matters: a stamped drawing is irreversible and no other reader recognises it
 * as a note, while real annotations are opened, edited and deleted by Acrobat and
 * browsers as their own.
 *
 * Coordinates are kept in PDF space (origin bottom-left, points), not in screen
 * pixels — otherwise a note would run away the moment the zoom changed.
 */

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';
import type { PDFFont, PDFPage, PDFContext, PDFRef } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import {
  DEFAULT_TEXT_SIZE,
  appearanceContent,
  fontkit,
  linesOf,
  loadFace,
  type FaceMetrics,
  type TextFace,
  type FontLoader,
} from './text.js';

export type AnnotationKind = 'highlight' | 'note' | 'ink' | 'text';

/** RGB, each component 0–1, as PDF expects. */
export type Rgb = [number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Base {
  id: string;
  kind: AnnotationKind;
  /** 1-based, the way a user counts pages. */
  page: number;
  color: Rgb;
  /** Unix ms. */
  createdAt: number;
  /** An annotation read from the file rather than created in this session. */
  imported?: boolean;
}

export interface HighlightAnnotation extends Base {
  kind: 'highlight';
  /** One rectangle per line of text — a highlighted paragraph has several. */
  quads: Rect[];
}

export interface NoteAnnotation extends Base {
  kind: 'note';
  rect: Rect;
  text: string;
}

export interface InkAnnotation extends Base {
  kind: 'ink';
  strokes: Point[][];
  width: number;
}

/**
 * Text the user adds to the document themselves.
 *
 * `rect` is not set by hand but computed from the text and the font size
 * (`layoutTextBox`); the anchor is the top-left corner. The box on screen and the
 * box in the file therefore come out of the same maths and cannot drift apart.
 */
export interface TextBoxAnnotation extends Base {
  kind: 'text';
  rect: Rect;
  text: string;
  /** The font size in points. */
  size: number;
  face: TextFace;
}

export type Annotation =
  | HighlightAnnotation
  | NoteAnnotation
  | InkAnnotation
  | TextBoxAnnotation;

export const PALETTE: { name: string; color: Rgb }[] = [
  { name: 'Yellow', color: [0.98, 0.79, 0.29] },
  { name: 'Teal', color: [0.25, 0.7, 0.73] },
  { name: 'Green', color: [0.36, 0.69, 0.51] },
  { name: 'Red', color: [0.88, 0.44, 0.37] },
  { name: 'Purple', color: [0.65, 0.58, 0.85] },
  // For text, where black is the only sensible default. It makes no sense as a
  // highlight, but hiding a colour depending on the tool would confuse more than
  // it would help.
  { name: 'Black', color: [0, 0, 0] },
];

/** The size of a note icon in PDF points. */
export const NOTE_SIZE = 20;

let counter = 0;
export function newId(): string {
  return `ann-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export function boundsOf(annotation: Annotation): Rect {
  switch (annotation.kind) {
    case 'note':
    case 'text':
      return annotation.rect;
    case 'highlight':
      return unionOf(annotation.quads);
    case 'ink': {
      const points = annotation.strokes.flat();
      if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const pad = annotation.width;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      return {
        x: minX,
        y: minY,
        width: Math.max(...xs) + pad - minX,
        height: Math.max(...ys) + pad - minY,
      };
    }
  }
}

function unionOf(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* ── reading from an existing PDF ────────────────────────────────────── */

/** The subset of a pdf.js annotation we care about. */
interface RawAnnotation {
  id?: string;
  subtype?: string;
  rect?: number[];
  quadPoints?: number[][] | number[];
  inkLists?: { x: number; y: number }[][] | number[][];
  color?: Uint8ClampedArray | number[];
  contents?: string;
  contentsObj?: { str?: string };
  borderStyle?: { width?: number };
  /** pdf.js parses `/DA` here; older versions give only the raw string. */
  defaultAppearanceData?: { fontSize?: number; fontColor?: Uint8ClampedArray | number[] };
  defaultAppearance?: string;
}

/** The font size out of `/DA` — `… /Helv 11 Tf …`. */
function fontSizeFrom(item: RawAnnotation): number {
  const parsed = item.defaultAppearanceData?.fontSize;
  if (typeof parsed === 'number' && parsed > 0) return parsed;

  const match = /(\d+(?:\.\d+)?)\s+Tf/.exec(item.defaultAppearance ?? '');
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TEXT_SIZE;
}

function colorFrom(raw: RawAnnotation['color'], fallback: Rgb): Rgb {
  if (!raw || raw.length < 3) return fallback;
  // pdf.js gives 0–255, the PDF internally 0–1.
  return [(raw[0] ?? 0) / 255, (raw[1] ?? 0) / 255, (raw[2] ?? 0) / 255];
}

function rectFrom(raw: number[] | undefined): Rect | null {
  if (!raw || raw.length < 4) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = raw;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/**
 * Converts the annotations pdf.js read into our model.
 *
 * The supported types are the ones we write ourselves; the rest (links, forms,
 * signatures) are deliberately skipped — they stay untouched in the file, because
 * saving adds only new annotations and leaves existing ones alone.
 */
export function importAnnotations(raw: unknown[], page: number): Annotation[] {
  const out: Annotation[] = [];

  for (const item of raw as RawAnnotation[]) {
    const subtype = item.subtype;
    const createdAt = Date.now();

    if (subtype === 'Highlight') {
      const quads = normalizeQuadPoints(item.quadPoints);
      const fallback = rectFrom(item.rect);
      const useQuads = quads.length > 0 ? quads : fallback ? [fallback] : [];
      if (useQuads.length === 0) continue;
      out.push({
        id: item.id ?? newId(),
        kind: 'highlight',
        page,
        color: colorFrom(item.color, [0.98, 0.79, 0.29]),
        createdAt,
        imported: true,
        quads: useQuads,
      });
      continue;
    }

    if (subtype === 'Text') {
      const rect = rectFrom(item.rect);
      if (!rect) continue;
      out.push({
        id: item.id ?? newId(),
        kind: 'note',
        page,
        color: colorFrom(item.color, [0.98, 0.79, 0.29]),
        createdAt,
        imported: true,
        rect,
        text: item.contentsObj?.str ?? item.contents ?? '',
      });
      continue;
    }

    if (subtype === 'FreeText') {
      const rect = rectFrom(item.rect);
      if (!rect) continue;
      out.push({
        id: item.id ?? newId(),
        kind: 'text',
        page,
        color: colorFrom(item.defaultAppearanceData?.fontColor, [0, 0, 0]),
        createdAt,
        imported: true,
        rect,
        text: item.contentsObj?.str ?? item.contents ?? '',
        size: fontSizeFrom(item),
        /* The face cannot be read reliably out of the file — `/DA` carries a
           resource name, not a family. The regular one is assumed; it only
           matters if the user starts editing such a box, and then it is written
           afresh anyway. */
        face: 'sans',
      });
      continue;
    }

    if (subtype === 'Ink') {
      const strokes = normalizeInkLists(item.inkLists);
      if (strokes.length === 0) continue;
      out.push({
        id: item.id ?? newId(),
        kind: 'ink',
        page,
        color: colorFrom(item.color, [0.88, 0.44, 0.37]),
        createdAt,
        imported: true,
        strokes,
        width: item.borderStyle?.width ?? 2,
      });
    }
  }

  return out;
}

/** pdf.js changed the shape of quadPoints across versions — we support both. */
function normalizeQuadPoints(raw: RawAnnotation['quadPoints']): Rect[] {
  if (!raw || raw.length === 0) return [];

  // The older shape: an array of 8 numbers per quad.
  if (typeof raw[0] === 'number') {
    const flat = raw as number[];
    const rects: Rect[] = [];
    for (let i = 0; i + 7 < flat.length; i += 8) {
      const xs = [flat[i]!, flat[i + 2]!, flat[i + 4]!, flat[i + 6]!];
      const ys = [flat[i + 1]!, flat[i + 3]!, flat[i + 5]!, flat[i + 7]!];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      rects.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
    }
    return rects;
  }

  // The newer shape: an array of points per quad.
  const groups = raw as unknown as { x: number; y: number }[][];
  return groups
    .filter((g) => Array.isArray(g) && g.length >= 4)
    .map((g) => {
      const xs = g.map((p) => p.x);
      const ys = g.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    });
}

function normalizeInkLists(raw: RawAnnotation['inkLists']): Point[][] {
  if (!raw || raw.length === 0) return [];

  const first = raw[0];
  if (Array.isArray(first) && typeof first[0] === 'number') {
    // Ravno polje x,y,x,y…
    return (raw as number[][]).map((flat) => {
      const points: Point[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        points.push({ x: flat[i]!, y: flat[i + 1]! });
      }
      return points;
    });
  }

  return (raw as Point[][]).filter((s) => Array.isArray(s) && s.length > 0);
}

/* ── writing into the PDF ────────────────────────────────────────────── */

function rgbArray(context: PDFContext, color: Rgb): PDFArray {
  const array = context.obj([]) as PDFArray;
  for (const component of color) array.push(PDFNumber.of(round(component)));
  return array;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pdfRect(context: PDFContext, rect: Rect): PDFArray {
  const array = context.obj([]) as PDFArray;
  for (const value of [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]) {
    array.push(PDFNumber.of(round(value)));
  }
  return array;
}

/** PDF datum: `D:YYYYMMDDHHmmSS`. */
function pdfDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * What every annotation has in common.
 *
 * `withColor` exists because of `/FreeText`, where `/C` means **the background
 * colour**, not the colour of the content. Setting the text colour there would
 * paint the box behind the text.
 */
function baseDict(
  context: PDFContext,
  annotation: Annotation,
  rect: Rect,
  withColor = true,
): Record<string, unknown> {
  const dict: Record<string, unknown> = {
    Type: PDFName.of('Annot'),
    Rect: pdfRect(context, rect),
    /** `/P` is filled in once we know the page reference. */
    F: PDFNumber.of(4), // Print
    NM: PDFString.of(annotation.id),
    M: PDFString.of(pdfDate(annotation.createdAt)),
    T: PDFString.of('ulEditor'),
  };
  if (withColor) dict.C = rgbArray(context, annotation.color);
  return dict;
}

function highlightDict(context: PDFContext, annotation: HighlightAnnotation): PDFDict {
  const quadPoints = context.obj([]) as PDFArray;
  for (const quad of annotation.quads) {
    // The order per the specification: top-left, top-right, bottom-left, bottom-right.
    const top = quad.y + quad.height;
    for (const value of [
      quad.x, top,
      quad.x + quad.width, top,
      quad.x, quad.y,
      quad.x + quad.width, quad.y,
    ]) {
      quadPoints.push(PDFNumber.of(round(value)));
    }
  }

  return context.obj({
    ...baseDict(context, annotation, unionOf(annotation.quads)),
    Subtype: PDFName.of('Highlight'),
    QuadPoints: quadPoints,
    CA: PDFNumber.of(0.4),
    Contents: PDFString.of(''),
  }) as PDFDict;
}

function noteDict(context: PDFContext, annotation: NoteAnnotation): PDFDict {
  return context.obj({
    ...baseDict(context, annotation, annotation.rect),
    Subtype: PDFName.of('Text'),
    Name: PDFName.of('Comment'),
    // Hex encoding: notes contain diacritics, and PDFString is Latin-1.
    Contents: PDFHexString.fromText(annotation.text),
    Open: false,
  }) as PDFDict;
}

function inkDict(context: PDFContext, annotation: InkAnnotation): PDFDict {
  const inkList = context.obj([]) as PDFArray;
  for (const stroke of annotation.strokes) {
    const flat = context.obj([]) as PDFArray;
    for (const point of stroke) {
      flat.push(PDFNumber.of(round(point.x)));
      flat.push(PDFNumber.of(round(point.y)));
    }
    inkList.push(flat);
  }

  return context.obj({
    ...baseDict(context, annotation, boundsOf(annotation)),
    Subtype: PDFName.of('Ink'),
    InkList: inkList,
    BS: context.obj({ W: PDFNumber.of(annotation.width) }),
    Contents: PDFString.of(''),
  }) as PDFDict;
}

/** One embedded face: pdf-lib writes it, fontkit measures it. */
interface EmbeddedFace {
  font: PDFFont;
  metrics: FaceMetrics;
}

/** The name the font stands under in the appearance stream's `Resources`. */
const FONT_RESOURCE = 'F1';

/**
 * A text box as a `/FreeText` with its own appearance stream.
 *
 * Two choices are worth explaining:
 *
 * - **An annotation, not stamped content.** Text stamped into the page stream is
 *   irreversible; this way it stays an object that both ulEditor and Acrobat can
 *   later move, rewrite or delete.
 * - **Its own `/AP`.** Without one, a `/FreeText` stays invisible in pdf.js and
 *   in browsers, because they do not assemble the appearance from `/DA`
 *   themselves.
 */
function textDict(
  context: PDFContext,
  annotation: TextBoxAnnotation,
  embedded: EmbeddedFace,
): PDFDict {
  const { rect, size, color } = annotation;
  const lines = linesOf(annotation.text);

  const content = appearanceContent(
    lines,
    (line) => embedded.font.encodeText(line).toString(),
    size,
    color,
    embedded.metrics,
    rect.height,
    FONT_RESOURCE,
  );

  const appearance = context.flateStream(content, {
    Type: PDFName.of('XObject'),
    Subtype: PDFName.of('Form'),
    FormType: PDFNumber.of(1),
    BBox: context.obj([0, 0, round(rect.width), round(rect.height)]),
    Resources: context.obj({
      Font: context.obj({ [FONT_RESOURCE]: embedded.font.ref }),
    }),
  });

  const [r, g, b] = color;

  return context.obj({
    ...baseDict(context, annotation, rect, false),
    Subtype: PDFName.of('FreeText'),
    // Hex encoding: the content carries diacritics, and PDFString is Latin-1.
    Contents: PDFHexString.fromText(annotation.text),
    /* A reader that rebuilds the appearance itself needs to know with what — the
       resource name only means something alongside a `/DR` in the document's
       form, so this is a help, not something to rely on. */
    DA: PDFString.of(
      `/${FONT_RESOURCE} ${round(size)} Tf ${round(r)} ${round(g)} ${round(b)} rg`,
    ),
    Q: PDFNumber.of(0), // lijevo poravnanje
    IT: PDFName.of('FreeTextTypeWriter'),
    // No border: added text is text, not a box.
    BS: context.obj({ W: PDFNumber.of(0) }),
    AP: context.obj({ N: context.register(appearance) }),
  }) as PDFDict;
}

function dictFor(
  context: PDFContext,
  annotation: Annotation,
  faces: Map<TextFace, EmbeddedFace>,
): PDFDict | null {
  switch (annotation.kind) {
    case 'highlight':
      return highlightDict(context, annotation);
    case 'note':
      return noteDict(context, annotation);
    case 'ink':
      return inkDict(context, annotation);
    case 'text': {
      const embedded = faces.get(annotation.face);
      // Without a font the text cannot be written; skipping beats an empty box.
      return embedded ? textDict(context, annotation, embedded) : null;
    }
  }
}

function annotsArray(page: PDFPage, context: PDFContext): PDFArray {
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) return existing;

  const created = context.obj([]) as PDFArray;
  page.node.set(PDFName.of('Annots'), created);
  return created;
}

export interface WriteResult {
  bytes: Uint8Array;
  /** Koliko je anotacija stvarno zapisano. */
  written: number;
  /** Characters the embedded font lacks — they were saved as blanks. */
  missingGlyphs: string[];
}

/**
 * Embeds the faces the text boxes require.
 *
 * A subset, not the whole font: only the glyphs actually used go into the
 * output, so a signature on a form adds a few kilobytes instead of 140.
 */
async function embedFaces(
  doc: PDFDocument,
  boxes: TextBoxAnnotation[],
  loadFont: FontLoader | undefined,
): Promise<Map<TextFace, EmbeddedFace>> {
  const faces = new Map<TextFace, EmbeddedFace>();
  if (boxes.length === 0) return faces;

  if (!loadFont) {
    throw new Error('Writing text into a PDF needs a font source (FontLoader).');
  }

  doc.registerFontkit(fontkit);

  for (const face of new Set(boxes.map((box) => box.face))) {
    const metrics = await loadFace(face, loadFont);
    faces.set(face, {
      metrics,
      font: await doc.embedFont(metrics.bytes, { subset: true }),
    });
  }

  return faces;
}

/**
 * Writes the annotations into the PDF and returns new bytes.
 *
 * Existing annotations in the file are left alone — the ones we read on opening
 * are already in the document, so writing them again would create duplicates.
 * Only those created in this session are written.
 */
export async function writeAnnotations(
  source: Uint8Array,
  annotations: Annotation[],
  /**
   * Source page (1-based) → position in the output (0-based). It is needed when
   * pages were reordered or deleted; without it the order is assumed untouched.
   * A page missing from the map means it was deleted — its annotations are
   * skipped.
   */
  pageMap?: Map<number, number>,
  /** The font bytes for text boxes; not called when there are none. */
  loadFont?: FontLoader,
): Promise<WriteResult> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  const context = doc.context;
  const pages = doc.getPages();

  const pending = annotations.filter((a) => !a.imported);
  const faces = await embedFaces(
    doc,
    pending.filter((a): a is TextBoxAnnotation => a.kind === 'text'),
    loadFont,
  );

  const missingGlyphs: string[] = [];

  let written = 0;
  for (const annotation of pending) {
    const index = pageMap ? pageMap.get(annotation.page) : annotation.page - 1;
    if (index === undefined) continue;

    const page = pages[index];
    if (!page) continue;

    if (annotation.kind === 'text') {
      /*
       * A character the font lacks is quietly replaced with a blank by pdf-lib.
       * Quiet is the worst thing that can happen here — the user would get a
       * saved document with a hole instead of a letter and hear about it from
       * somebody else.
       */
      for (const ch of faces.get(annotation.face)?.metrics.missing(annotation.text) ?? []) {
        if (!missingGlyphs.includes(ch)) missingGlyphs.push(ch);
      }
    }

    const dict = dictFor(context, annotation, faces);
    if (!dict) continue;
    dict.set(PDFName.of('P'), page.ref);

    const ref: PDFRef = context.register(dict);
    annotsArray(page, context).push(ref);
    written++;
  }

  return { bytes: await doc.save({ useObjectStreams: false }), written, missingGlyphs };
}

/** Which features of the source document a save cannot reproduce. */
export function fidelityGaps(annotations: Annotation[]): string[] {
  const gaps: string[] = [];
  if (annotations.some((a) => a.kind === 'note' && a.text.length > 0)) {
    gaps.push('Notes are saved without their own appearance stream (/AP) — some readers show a default icon.');
  }
  return gaps;
}

/**
 * The message about characters the embedded font does not know.
 *
 * It travels the same route as the loss of outlines when pages are reordered: not
 * as a quiet substitution, but as an explicit warning alongside the save.
 */
export function missingGlyphWarning(characters: string[]): string[] {
  if (characters.length === 0) return [];
  return [
    t('The font cannot draw these characters, so they were saved as blanks: {chars}', {
      chars: characters.join(' '),
    }),
  ];
}
