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

/**
 * Tekst koji korisnik sam dopisuje u dokument.
 *
 * `rect` se ne postavlja ručno nego se računa iz teksta i veličine slova
 * (`layoutTextBox`); sidro je gornji-lijevi kut. Time okvir na ekranu i okvir
 * u datoteci nastaju iz istog računa, pa ne mogu odlutati jedan od drugoga.
 */
export interface TextBoxAnnotation extends Base {
  kind: 'text';
  rect: Rect;
  text: string;
  /** Veličina slova u točkama. */
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
  // Za tekst, gdje je crna jedina razumna zadana boja. Kao istaknuće nema
  // smisla, ali skrivanje boje ovisno o alatu bi zbunilo više nego što bi
  // pomoglo.
  { name: 'Black', color: [0, 0, 0] },
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
  /** pdf.js razlaže `/DA` ovdje; starije verzije daju samo sirovi niz. */
  defaultAppearanceData?: { fontSize?: number; fontColor?: Uint8ClampedArray | number[] };
  defaultAppearance?: string;
}

/** Veličina slova iz `/DA` — `… /Helv 11 Tf …`. */
function fontSizeFrom(item: RawAnnotation): number {
  const parsed = item.defaultAppearanceData?.fontSize;
  if (typeof parsed === 'number' && parsed > 0) return parsed;

  const match = /(\d+(?:\.\d+)?)\s+Tf/.exec(item.defaultAppearance ?? '');
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TEXT_SIZE;
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
        /* Iz datoteke se rez ne da pouzdano pročitati — `/DA` nosi ime resursa,
           ne obitelj. Pretpostavlja se osnovni; važno je samo ako korisnik
           takav okvir počne uređivati, a tada se ionako zapisuje nanovo. */
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

/**
 * Zajedničko za sve anotacije.
 *
 * `withColor` postoji zbog `/FreeText`, gdje `/C` znači **boju pozadine**, a ne
 * boju sadržaja. Postavljanje boje teksta ondje bi okvir obojilo iza teksta.
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
    /** `/P` se popunjava nakon što znamo referencu stranice. */
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

/** Jedan ugrađen rez: pdf-lib ga zapisuje, fontkit mjeri. */
interface EmbeddedFace {
  font: PDFFont;
  metrics: FaceMetrics;
}

/** Ime pod kojim font stoji u `Resources` toka izgleda. */
const FONT_RESOURCE = 'F1';

/**
 * Tekstualni okvir kao `/FreeText` s vlastitim tokom izgleda.
 *
 * Dva izbora vrijedi obrazložiti:
 *
 * - **Anotacija, ne utisnut sadržaj.** Tekst utisnut u tok stranice je
 *   nepovratan; ovako ostaje predmet koji i ulEditor i Acrobat mogu poslije
 *   pomaknuti, prepraviti ili obrisati.
 * - **Vlastiti `/AP`.** Bez njega `/FreeText` u pdf.js-u i preglednicima
 *   ostaje nevidljiv, jer izgled iz `/DA` ne sastavljaju sami.
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
    // Hex kodiranje: sadržaj nosi dijakritiku, a PDFString je Latin-1.
    Contents: PDFHexString.fromText(annotation.text),
    /* Čitač koji sam presloži izgled treba znati čime — ime resursa pritom
       vrijedi tek uz `/DR` u obrascu dokumenta, pa je ovo pomoć, ne oslonac. */
    DA: PDFString.of(
      `/${FONT_RESOURCE} ${round(size)} Tf ${round(r)} ${round(g)} ${round(b)} rg`,
    ),
    Q: PDFNumber.of(0), // lijevo poravnanje
    IT: PDFName.of('FreeTextTypeWriter'),
    // Bez okvira: dodani tekst je tekst, ne kućica.
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
      // Bez fonta se tekst ne da zapisati; preskakanje je bolje od praznog okvira.
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
  /** Znakovi koje ugrađeni font nema — spremljeni su kao prazno mjesto. */
  missingGlyphs: string[];
}

/**
 * Ugrađuje rezove koje traže tekstualni okviri.
 *
 * Podskup, ne cijeli font: u izlaz idu samo glifovi koji su stvarno
 * upotrijebljeni, pa potpis na obrascu doda nekoliko kilobajta umjesto 140.
 */
async function embedFaces(
  doc: PDFDocument,
  boxes: TextBoxAnnotation[],
  loadFont: FontLoader | undefined,
): Promise<Map<TextFace, EmbeddedFace>> {
  const faces = new Map<TextFace, EmbeddedFace>();
  if (boxes.length === 0) return faces;

  if (!loadFont) {
    throw new Error('Za zapis teksta u PDF potreban je izvor fonta (FontLoader).');
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
  /** Bajtovi fonta za tekstualne okvire; bez okvira se ne poziva. */
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
       * Znak koji font nema pdf-lib tiho zamijeni praznim mjestom. Tiho je
       * ovdje najgore što se može dogoditi — korisnik bi dobio spremljen
       * dokument s rupom umjesto slova i saznao za to od nekog drugog.
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

/** Koje značajke izvornog dokumenta spremanje ne može reproducirati. */
export function fidelityGaps(annotations: Annotation[]): string[] {
  const gaps: string[] = [];
  if (annotations.some((a) => a.kind === 'note' && a.text.length > 0)) {
    gaps.push('Notes are saved without their own appearance stream (/AP) — some readers show a default icon.');
  }
  return gaps;
}

/**
 * Poruka o znakovima koje ugrađeni font ne poznaje.
 *
 * Ide istim putem kojim ide i gubitak oznaka pri preslagivanju stranica: ne
 * kao tiha zamjena, nego kao izričito upozorenje uz spremanje.
 */
export function missingGlyphWarning(characters: string[]): string[] {
  if (characters.length === 0) return [];
  return [
    t('The font cannot draw these characters, so they were saved as blanks: {chars}', {
      chars: characters.join(' '),
    }),
  ];
}
