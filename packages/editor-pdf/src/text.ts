/**
 * Tekst koji se dodaje u PDF — font, mjere i izgled.
 *
 * Ovdje je namjerno samo račun, bez dohvaćanja datoteka i bez DOM-a, pa se
 * isti kod vrti u pregledniku i u provjerama pod Nodeom. Bajtove fonta dodaje
 * pozivatelj kroz `FontLoader`.
 *
 * **Zašto se font uopće ugrađuje.** Standardnih četrnaest PDF fontova koristi
 * WinAnsi kodiranje, u kojem `č`, `ć`, `ž`, `š` i `đ` ne postoje — pdf-lib na
 * njima baca grešku, a čitači koji je ne bace nacrtaju krivo slovo. Hrvatski
 * se dakle ne da napisati bez ugrađenog fonta. Uzet je Liberation Sans koji
 * ionako stiže s pdf.js-om (SIL OFL 1.1, metrički jednak Arialu), pa u repou
 * nema binarnog priloga, a u izlaz ide samo podskup stvarno upotrijebljenih
 * glifova — nekoliko kilobajta.
 */

import * as fontkitModule from '@pdf-lib/fontkit';
import type { Font as FontkitFont } from '@pdf-lib/fontkit';

import type { Rect, Rgb } from './annotations.js';

/*
 * `@pdf-lib/fontkit` ima ESM build s default izvozom i UMD build s imenovanim,
 * a tipovi opisuju samo imenovane. Vite uzima jedno, Node drugo — pa se uzima
 * ono što stvarno postoji umjesto da se pogađa po okruženju.
 */
interface Fontkit {
  create(bytes: Uint8Array): FontkitFont;
}
export const fontkit: Fontkit =
  (fontkitModule as unknown as { default?: Fontkit }).default ??
  (fontkitModule as unknown as Fontkit);

/** Rezovi koje nudimo. Liberation Sans ih ima četiri; kosi podebljani ne treba. */
export type TextFace = 'sans' | 'sans-bold' | 'sans-italic';

export const TEXT_FACES: { id: TextFace; label: string; weight: number; style: string }[] = [
  { id: 'sans', label: 'Regular', weight: 400, style: 'normal' },
  { id: 'sans-bold', label: 'Bold', weight: 700, style: 'normal' },
  { id: 'sans-italic', label: 'Italic', weight: 400, style: 'italic' },
];

/** Obitelj pod kojom se isti font registrira u pregledniku, da se prikaz poklopi sa zapisom. */
export const FONT_FAMILY = 'ulEditor Sans';

export const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32];
export const DEFAULT_TEXT_SIZE = 11;

/** Razmak od ruba okvira do teksta, u točkama. */
export const TEXT_PADDING = 2;

/** Dohvat bajtova jednog reza. Preglednik ih skida, provjera čita s diska. */
export type FontLoader = (face: TextFace) => Promise<Uint8Array>;

/* ── mjere ───────────────────────────────────────────────────────────── */

export interface FaceMetrics {
  face: TextFace;
  bytes: Uint8Array;
  /** Visina retka u točkama za zadanu veličinu. */
  lineHeight(size: number): number;
  /** Udaljenost od vrha retka do osnovne linije. */
  ascent(size: number): number;
  /** Širina jednog retka u točkama. */
  measure(line: string, size: number): number;
  /** Širina jednog znaka u tisućinkama em-a — mjera kojom PDF računa. */
  widthOfCodePoint(codePoint: number): number;
  /** Znakovi koje ovaj rez nema — jedinstveni, redoslijedom pojavljivanja. */
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
      /* Isti račun kojim pdf-lib slaže glifove pri zapisu, pa se okvir na
         ekranu i okvir u datoteci ne razilaze. */
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

/** Učitani rezovi po fontu — isti se ne parsira dvaput. */
const cache = new Map<TextFace, Promise<FaceMetrics>>();

export function loadFace(face: TextFace, loader: FontLoader): Promise<FaceMetrics> {
  const existing = cache.get(face);
  if (existing) return existing;

  const pending = loader(face).then((bytes) => metricsOf(face, bytes));
  cache.set(face, pending);
  // Neuspjeh se ne pamti: sljedeći pokušaj mora smjeti probati ponovno.
  void pending.catch(() => cache.delete(face));
  return pending;
}

/* ── metrike standardnih fontova ─────────────────────────────────────── */

/**
 * Kodovi 0x80–0x9F u WinAnsi kodiranju.
 *
 * Ispod 0x80 je WinAnsi jednak ASCII-ju, a od 0xA0 nadalje Latin-1; razlikuje
 * se samo ovaj komad, u kojem stoje navodnici, crte i slična interpunkcija.
 */
const WIN_ANSI_HIGH = [
  0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
  0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

function winAnsiCodePoint(code: number): number | null {
  if (code >= 0x80 && code <= 0x9f) {
    const mapped = WIN_ANSI_HIGH[code - 0x80] ?? 0;
    return mapped === 0 ? null : mapped;
  }
  return code >= 32 ? code : null;
}

export interface StandardWidths {
  /** Širina koda u tisućinkama, ili `null` ako se font ne prepoznaje. */
  widthOf(baseFont: string, code: number): number | null;
}

/** `ABCDEF+Helvetica-Bold` → `Helvetica-Bold`. */
function baseName(name: string): string {
  return name.replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
}

/**
 * Mjere za standardnih četrnaest fontova, koji smiju izostaviti `/Widths`.
 *
 * Bez ovoga bi svaki jednostavno generiran PDF — a takvi su gotovo svi
 * računi, potvrde i obrasci — ispao „ne da se dirati”, jer se bez širina ne
 * zna gdje jedan glif prestaje.
 *
 * Helvetica se mjeri Liberation Sansom. To nije aproksimacija: Liberation je
 * napravljen tako da mu se širine poklapaju s Arialom, a Arial s Helveticom.
 * Courier je monoprostorni s 600 posvuda. Times, Symbol i ZapfDingbats
 * ostaju neprepoznati i to se prijavljuje, umjesto da se nagađa.
 */
export async function standardWidths(load: FontLoader): Promise<StandardWidths> {
  const regular = await loadFace('sans', load);
  const bold = await loadFace('sans-bold', load);

  const faceFor = (name: string): FaceMetrics | null => {
    const lower = name.toLowerCase();
    if (lower.startsWith('helvetica') || lower.startsWith('arial')) {
      // Kurziv ima iste širine kao uspravni rez — kod Ariala i Helvetice
      // razlikuje se oblik, ne razmak.
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

/** Prazan okvir mora ostati dovoljno velik da se u njega da kliknuti. */
const MIN_WIDTH_EM = 4;

export function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Okvir za zadani tekst.
 *
 * Sidro je **gornji-lijevi kut**, jer se pri tipkanju okvir širi prema dolje i
 * udesno — kao i svugdje drugdje. PDF broji od dolje, pa se to ovdje pretvara
 * jednom i dalje se ne razmišlja o tome.
 *
 * Prelamanja nema: redak je ono što je korisnik napisao kao redak. Automatsko
 * prelamanje bi tražilo da se prijelom u `<textarea>` i prijelom u datoteci
 * poklope u pikselu, a ne poklapaju se — pa bi spremljeni PDF izgledao drukčije
 * od onoga što je korisnik vidio dok je tipkao.
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

/** Gornji rub okvira — sidro po kojem se preračunava kad se tekst promijeni. */
export function topOf(rect: Rect): number {
  return rect.y + rect.height;
}

/* ── izgled (/AP) ────────────────────────────────────────────────────── */

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Sadržaj toka izgleda za `/FreeText`.
 *
 * Bez njega većina čitača ne nacrta ništa: specifikacija dopušta da čitač sam
 * složi izgled iz `/DA`, ali pdf.js i preglednici to za `/FreeText` ne rade.
 * Anotacija bez `/AP` je zato nevidljiva svugdje osim u Acrobatu — a nevidljiv
 * potpis je gori od nikakvog.
 *
 * Koordinate su unutar `BBox`-a, dakle od dolje-lijevo, s ishodištem u kutu
 * okvira. `resource` je ime pod kojim je font upisan u `Resources` toka.
 */
export function appearanceContent(
  lines: string[],
  encodeLine: (line: string) => string,
  size: number,
  color: Rgb,
  metrics: FaceMetrics,
  height: number,
  resource: string,
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
    // `T*` prije retka, ne poslije: prvi redak je već postavljen s `Td`.
    if (index > 0) out.push('T*');
    if (line.length > 0) out.push(`${encodeLine(line)} Tj`);
  });

  out.push('ET', 'Q');
  return out.join('\n');
}
