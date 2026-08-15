/**
 * Model anotacija i njihov zapis u PDF.
 *
 * Anotacije se zapisuju kao PRAVI PDF anotacijski objekti (`/Highlight`,
 * `/Text`, `/Ink`), ne kao crtež utisnut u sadržaj stranice. Razlika je bitna:
 * utisnuti crtež je nepovratan i nijedan drugi čitač ga ne prepoznaje kao
 * bilješku, dok prave anotacije Acrobat i preglednici otvaraju, uređuju i
 * brišu kao svoje.
 *
 * Koordinate se čuvaju u PDF prostoru (ishodište dolje-lijevo, točke), ne u
 * pikselima ekrana — inače bi bilješka pobjegla čim se promijeni zoom.
 */

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';
import type { PDFPage, PDFContext, PDFRef } from 'pdf-lib';

export type AnnotationKind = 'highlight' | 'note' | 'ink';

/** RGB, svaka komponenta 0–1, kako PDF očekuje. */
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
  /** 1-bazirano, kao što korisnik broji stranice. */
  page: number;
  color: Rgb;
  /** Unix ms. */
  createdAt: number;
  /** Anotacija pročitana iz datoteke, ne stvorena u ovoj sesiji. */
  imported?: boolean;
}

export interface HighlightAnnotation extends Base {
  kind: 'highlight';
  /** Jedan pravokutnik po retku teksta — istaknuti odlomak ih ima više. */
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

export type Annotation = HighlightAnnotation | NoteAnnotation | InkAnnotation;

export const PALETTE: { name: string; color: Rgb }[] = [
  { name: 'Žuta', color: [0.98, 0.79, 0.29] },
  { name: 'Tirkizna', color: [0.25, 0.7, 0.73] },
  { name: 'Zelena', color: [0.36, 0.69, 0.51] },
  { name: 'Crvena', color: [0.88, 0.44, 0.37] },
  { name: 'Ljubičasta', color: [0.65, 0.58, 0.85] },
];

/** Veličina ikone bilješke u PDF točkama. */
export const NOTE_SIZE = 20;

let counter = 0;
export function newId(): string {
  return `ann-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export function boundsOf(annotation: Annotation): Rect {
  switch (annotation.kind) {
    case 'note':
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

/* ── čitanje iz postojećeg PDF-a ─────────────────────────────────────── */

/** Podskup pdf.js anotacije koji nas zanima. */
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
}

function colorFrom(raw: RawAnnotation['color'], fallback: Rgb): Rgb {
  if (!raw || raw.length < 3) return fallback;
  // pdf.js daje 0–255, PDF interno 0–1.
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
 * Pretvara anotacije koje je pročitao pdf.js u naš model.
 *
 * Podržani su tipovi koje i sami pišemo; ostali (linkovi, obrasci, potpisi)
 * se namjerno preskaču — ostaju netaknuti u datoteci jer se pri spremanju
 * dodaju samo nove anotacije, a postojeće se ne diraju.
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

/** pdf.js je kroz verzije mijenjao oblik quadPoints — podržavamo oba. */
function normalizeQuadPoints(raw: RawAnnotation['quadPoints']): Rect[] {
  if (!raw || raw.length === 0) return [];

  // Stariji oblik: polje od 8 brojeva po quadu.
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

  // Noviji oblik: polje točaka po quadu.
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

/* ── zapis u PDF ─────────────────────────────────────────────────────── */

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

function baseDict(context: PDFContext, annotation: Annotation, rect: Rect): Record<string, unknown> {
  return {
    Type: PDFName.of('Annot'),
    Rect: pdfRect(context, rect),
    C: rgbArray(context, annotation.color),
    /** `/P` se popunjava nakon što znamo referencu stranice. */
    F: PDFNumber.of(4), // Print
    NM: PDFString.of(annotation.id),
    M: PDFString.of(pdfDate(annotation.createdAt)),
    T: PDFString.of('ulEditor'),
  };
}

function highlightDict(context: PDFContext, annotation: HighlightAnnotation): PDFDict {
  const quadPoints = context.obj([]) as PDFArray;
  for (const quad of annotation.quads) {
    // Redoslijed po specifikaciji: gore-lijevo, gore-desno, dolje-lijevo, dolje-desno.
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
    // Hex kodiranje: bilješke sadrže dijakritiku, a PDFString je Latin-1.
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

function dictFor(context: PDFContext, annotation: Annotation): PDFDict {
  switch (annotation.kind) {
    case 'highlight':
      return highlightDict(context, annotation);
    case 'note':
      return noteDict(context, annotation);
    case 'ink':
      return inkDict(context, annotation);
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
}

/**
 * Upisuje anotacije u PDF i vraća nove bajtove.
 *
 * Postojeće anotacije u datoteci se ne diraju — one koje smo pročitali pri
 * otvaranju već su u dokumentu, pa bi ponovno pisanje stvorilo duplikate.
 * Zato se zapisuju samo one nastale u ovoj sesiji.
 */
export async function writeAnnotations(
  source: Uint8Array,
  annotations: Annotation[],
  /**
   * Izvorna stranica (1-bazirano) → mjesto u izlazu (0-bazirano). Potreban
   * je kad su stranice preslagane ili obrisane; bez njega se pretpostavlja
   * da je redoslijed netaknut. Stranica koje nema u mapi znači da je
   * obrisana — njezine anotacije se preskaču.
   */
  pageMap?: Map<number, number>,
): Promise<WriteResult> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  const context = doc.context;
  const pages = doc.getPages();

  let written = 0;
  for (const annotation of annotations) {
    if (annotation.imported) continue;

    const index = pageMap ? pageMap.get(annotation.page) : annotation.page - 1;
    if (index === undefined) continue;

    const page = pages[index];
    if (!page) continue;

    const dict = dictFor(context, annotation);
    dict.set(PDFName.of('P'), page.ref);

    const ref: PDFRef = context.register(dict);
    annotsArray(page, context).push(ref);
    written++;
  }

  return { bytes: await doc.save({ useObjectStreams: false }), written };
}

/** Koje značajke izvornog dokumenta spremanje ne može reproducirati. */
export function fidelityGaps(annotations: Annotation[]): string[] {
  const gaps: string[] = [];
  if (annotations.some((a) => a.kind === 'note' && a.text.length > 0)) {
    gaps.push('Bilješke se spremaju bez vlastitog izgleda (/AP) — neki čitači prikazuju zadanu ikonu.');
  }
  return gaps;
}
