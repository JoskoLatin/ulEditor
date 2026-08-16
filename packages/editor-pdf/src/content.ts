/**
 * Čitanje toka sadržaja stranice — gdje koji glif stvarno stoji.
 *
 * PDF nema rečenice nego naredbe koje crtaju glifove na zadanim mjestima. Da
 * bi se tekst mogao **maknuti iz dokumenta**, a ne prekriti pravokutnikom,
 * mora se znati koji bajt u toku sadržaja odgovara kojem glifu i koliko taj
 * glif zauzima. To ovdje piše.
 *
 * Pravilo koje oblikuje sve ostalo: **kad se ne zna, ne dira se.** Tok koji
 * koristi font bez tablice širina, Type3 font ili tekst unutar Form XObjecta
 * ovaj kod ne pretvara u nagađanje nego prijavi da ne može. Redakcija koja
 * tiho promaši dio teksta gora je od redakcije koje nema — korisnik u prvom
 * slučaju misli da je posao obavljen.
 *
 * Namjerno bez DOM-a i bez pdf.js-a: isto se vrti u pregledniku i u
 * provjerama pod Nodeom.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';

import type { Rect, Rgb } from './annotations.js';
import { winAnsiCodePoint, type StandardWidths } from './text.js';

/* ── matrice ─────────────────────────────────────────────────────────── */

/** `[a b c d e f]`, kako ih PDF piše. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` pa `n` — redoslijed kao u PDF-u: prvo lijeva, onda desna. */
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

/* ── leksičko čitanje ────────────────────────────────────────────────── */

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
 * Rastavlja tok na tokene, svaki sa svojim rasponom bajtova.
 *
 * Rasponi su ono zbog čega ovo postoji: izlaz se ne sastavlja iznova nego se
 * u izvorne bajtove ubacuje zamjena samo ondje gdje treba. Sve što ovaj kod
 * ne razumije ostaje netaknuto, bajt za bajt.
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

    // Komentar do kraja retka.
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
      // Heksadekadski niz.
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
      // Neparan broj znamenki: zadnja se dopunjava nulom, kako spec traži.
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
            case 0x0a: break; // nastavak retka
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

    // Zagrade `{}` postoje samo u funkcijama za sjenčanje; preskaču se kao znak.
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
      // Nepoznat razgraničnik — pomak da se ne zaglavi.
      i++;
      continue;
    }

    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) {
      tokens.push({ kind: 'number', start, end: i, value: Number(raw) });
      continue;
    }

    // Ugrađena slika: iza `ID` slijede sirovi bajtovi do `EI`.
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

/** Traži operator kao samostalnu riječ, ne kao dio niza bajtova. */
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

/* ── fontovi ─────────────────────────────────────────────────────────── */

/**
 * Ono što o fontu treba znati da bi se glifovi mogli izmjeriti.
 *
 * Ne zanima nas kako font izgleda — samo koliko koji kod zauzima i koliko je
 * bajtova jedan kod. Bez toga se ne zna gdje jedan glif prestaje a drugi
 * počinje, pa se ne zna ni što je unutar pravokutnika.
 */
export interface FontInfo {
  name: string;
  /** `/BaseFont` bez podskupovnog prefiksa. */
  baseFont: string;
  /** Kompozitni font s Identity kodiranjem — dva bajta po kodu. */
  twoByte: boolean;
  /** Širina koda u tisućinkama tekstualne jedinice. */
  widthOf(code: number): number;
  /**
   * Kod → znak, ako se pouzdano zna.
   *
   * `null` znači da se kod ne da pretvoriti u slovo: bez `/ToUnicode` i bez
   * poznatog kodiranja tekst se može maknuti, ali ne i pročitati — pa se ne
   * može ponuditi ni na prepisivanje.
   */
  decode(code: number): string | null;
  /** Zašto se font ne da izmjeriti; `null` kad je sve u redu. */
  unsupported: string | null;
}

/**
 * Čita `/ToUnicode` CMap — jedini pouzdan put od koda do slova.
 *
 * Format je PostScriptu sličan, pa se čita istim leksičkim rastavom kojim i
 * tok sadržaja. Odredišta su UTF-16BE nizovi, jer jedan kod smije davati i
 * više znakova (ligature).
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
          // Oblik `<lo> <hi> [<d1> <d2> …]`: po jedno odredište za svaki kod.
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
        // Oblik `<lo> <hi> <početak>`: zadnji znak odredišta se uvećava.
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
 * Širine kompozitnog fonta iz `/W` polja.
 *
 * Format je dvojak: `c [w1 w2 …]` nabraja uzastopne kodove, a `c1 c2 w` daje
 * jednu širinu cijelom rasponu. Podržana su oba, jer se u praksi javljaju
 * pomiješano u istoj datoteci.
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
      // Raspon zna biti golem u CJK fontovima; pamti se pravilo, ne svaki kod.
      if (end - start <= 65535) {
        for (let code = start; code <= end; code++) table.set(code, width);
      }
      i += 3;
    }
  }

  return (code) => table.get(code) ?? defaultWidth;
}

/** Ima li font vlastito preslikavanje kodova, koje bi tablicu širina pomaklo. */
function hasDifferences(font: PDFDict): boolean {
  const encoding = font.lookup(PDFName.of('Encoding'));
  return encoding instanceof PDFDict && !!encoding.get(PDFName.of('Differences'));
}

/** Čita `/Font` iz resursa stranice i pretvara ga u mjerljive opise. */
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

    /** Popunjava zajednička polja da ih svaka grana ne ponavlja. */
    const describe = (partial: Omit<FontInfo, 'name' | 'baseFont' | 'decode'>): FontInfo => {
      const raw = font instanceof PDFDict ? font.lookup(PDFName.of('BaseFont')) : undefined;
      const baseFont = (raw instanceof PDFName ? raw.asString() : '')
        .replace(/^\//, '')
        .replace(/^[A-Z]{6}\+/, '');

      const toUnicode = font instanceof PDFDict ? readToUnicode(font) : null;
      const winAnsi = !partial.twoByte && font instanceof PDFDict && !hasDifferences(font);

      return {
        ...partial,
        name,
        baseFont,
        decode: (code) => {
          const mapped = toUnicode?.get(code);
          if (mapped !== undefined) return mapped;
          /*
           * Bez `/ToUnicode` jedini pošten oslonac je standardno kodiranje
           * jednobajtnog fonta. Kompozitni font s Identity kodiranjem daje
           * broj glifa u fontu, a taj o slovu ne govori ništa.
           */
          if (!winAnsi) return null;
          const cp = winAnsiCodePoint(code);
          return cp === null ? null : String.fromCodePoint(cp);
        },
      };
    };

    if (!(font instanceof PDFDict)) {
      out.set(
        name,
        describe({ twoByte: false, widthOf: () => 0, unsupported: 'font se ne da pročitati' }),
      );
      continue;
    }

    const subtype = font.lookup(PDFName.of('Subtype'));
    const kind = subtype instanceof PDFName ? subtype.asString() : '';

    if (kind === '/Type3') {
      // Glifovi su vlastiti tokovi sadržaja; njihova širina ovisi o matrici
      // fonta i ne da se očitati iz tablice.
      out.set(name, describe({ twoByte: false, widthOf: () => 0, unsupported: 'Type3 font' }));
      continue;
    }

    if (kind === '/Type0') {
      const encoding = font.lookup(PDFName.of('Encoding'));
      const encodingName = encoding instanceof PDFName ? encoding.asString() : '';
      if (encodingName !== '/Identity-H' && encodingName !== '/Identity-V') {
        // Ugrađen CMap bi tražio vlastiti parser da bi se znalo koliko je
        // bajtova jedan kod.
        out.set(
          name,
          describe({
            twoByte: true,
            widthOf: () => 0,
            unsupported: `kodiranje ${encodingName || 'bez imena'}`,
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
          describe({ twoByte: true, widthOf: () => 0, unsupported: 'nema DescendantFonts' }),
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
     * Standardnih četrnaest fontova smije izostaviti `/Widths` — mjere su
     * dogovorene. `standardWidths` ih zna za Helveticu i Courier; ostale
     * priznajemo da ne znamo.
     */
    const baseFont = font.lookup(PDFName.of('BaseFont'));
    const baseName = baseFont instanceof PDFName ? baseFont.asString() : '';

    if (hasDifferences(font)) {
      out.set(
        name,
        describe({
          twoByte: false,
          widthOf: () => 0,
          unsupported: 'vlastito preslikavanje kodova bez tablice širina',
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
        unsupported: `${baseName || 'font'} bez tablice širina`,
      }),
    );
  }

  return out;
}

/* ── obilazak teksta ─────────────────────────────────────────────────── */

export interface Glyph {
  /** Kod glifa; jedan ili dva bajta ovisno o fontu. */
  code: number;
  bytes: Uint8Array;
  /** Omeđujući pravokutnik u korisničkom prostoru stranice. */
  box: Rect;
  /** Pomak koji ovaj glif unosi, u tekstualnom prostoru. */
  advance: number;
}

export interface TextOperation {
  /** Raspon bajtova cijele naredbe, s operandima. */
  start: number;
  end: number;
  operator: 'Tj' | 'TJ' | "'" | '"';
  /** Dijelovi naredbe redom: nizovi glifova i brojčani pomaci iz `TJ`. */
  parts: ({ kind: 'glyphs'; glyphs: Glyph[] } | { kind: 'adjust'; value: number })[];
  /** Stanje teksta u trenutku naredbe — treba pri prepisivanju. */
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  /** Naredbe `'` i `"` u sebi nose i prelazak u novi redak. */
  leading: number;

  font: FontInfo;
  /** 0 = ispuna, 3 = nevidljivo (sloj iz OCR-a), ostalo su obrubi. */
  renderMode: number;
  /** Boja ispune, ili `null` kad se prostor boje ne prepoznaje. */
  fill: Rgb | null;
  /**
   * Veličina slova kakva se stvarno vidi na stranici — `Tf` pomnožen svime
   * što je matricama došlo na njega.
   */
  effectiveSize: number;
  /** Početak osnovne linije prvog glifa, u korisničkom prostoru. */
  origin: { x: number; y: number };
  /**
   * Stoji li tekst vodoravno i neiskrivljen.
   *
   * Zarotiran ili nagnut tekst se da maknuti, ali ne i prepisati: naši
   * tekstualni okviri stoje uspravno, pa bi zamjena stajala nakrivo.
   */
  axisAligned: boolean;
}

/** Tekst naredbe, ili `null` ako se kodovi ne daju pretvoriti u slova. */
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

/** Omeđujući pravokutnik svih glifova naredbe. */
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

/** Zašto neka stranica nije sigurna za izmjenu. */
export interface Obstacle {
  reason: string;
  /** Mjesto na koje se odnosi, ako je poznato. */
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
  /** Ime prostora boje postavljenog s `cs`; treba za tumačenje `sc`/`scn`. */
  fillSpace: string;
}

/** Pretvara operande boje u RGB, ili `null` kad prostor nije prepoznat. */
function colorFrom(operator: string, values: number[], space: string): Rgb | null {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  const fromCount = (count: number): Rgb | null => {
    if (count === 1) {
      const g = clamp(values[0] ?? 0);
      return [g, g, g];
    }
    if (count === 3) return [clamp(values[0] ?? 0), clamp(values[1] ?? 0), clamp(values[2] ?? 0)];
    if (count === 4) {
      // CMYK → RGB, jednostavnom pretvorbom; profil boje ovdje ne igra ulogu.
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
      // Imenovani prostori (ICC, Separation, Pattern) traže vlastito tumačenje;
      // pogađanje po broju operanada dalo bi krivu boju bez ijednog znaka
      // upozorenja, pa se radije priznaje da se ne zna.
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

/** Visina glifa iznad i ispod osnovne linije, u jedinicama em-a. */
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

    // Zarotirani tekst daje kutove u bilo kojem redoslijedu.
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
 * Prolazi kroz tok sadržaja i vraća sve naredbe koje crtaju tekst, s
 * položajem svakog glifa.
 *
 * Prepreke se skupljaju usput: font koji se ne da izmjeriti, Type3 glifovi i
 * Form XObjecti koji mogu sadržavati vlastiti tekst. Pozivatelj odlučuje što
 * s njima, ali se ne može praviti da ih nema.
 */
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
    // PDF kreće od crne ispune u DeviceGray.
    fill: [0, 0, 0],
    fillSpace: '/DeviceGray',
  };
  const stack: State[] = [];

  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;

  /** Operandi skupljeni od zadnjeg operatora. */
  let operands: Token[] = [];
  /** Gdje počinje trenutna naredba — prvi operand, ili sam operator. */
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
          obstacles.push({ reason: `${name.value}: font nije u resursima stranice` });
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
        // Novi prostor boje poništava staru vrijednost, kako spec traži.
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
              reason: `Form XObject ${name.value} — tekst unutra se ne vidi odavde`,
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
          // Bez mjera se ne zna gdje su glifovi; prepreka je već zabilježena.
          break;
        }

        /* Matrica prije nego glifovi pomaknu tekst — odatle kreće redak. */
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
 * Bajtovi toka sadržaja stranice.
 *
 * `/Contents` smije biti i polje tokova koje se čita kao jedan; spajaju se
 * novim retkom, jer se naredba ne smije prelomiti preko granice.
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
