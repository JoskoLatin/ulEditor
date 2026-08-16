/**
 * Brisanje teksta iz dokumenta — stvarno, a ne prekrivanjem.
 *
 * Crni pravokutnik preko teksta nije brisanje: tekst ostaje u toku sadržaja i
 * vadi se označavanjem, kopiranjem ili bilo kojim alatom koji čita PDF. To je
 * greška koja je više puta objavila tuđe tajne i razlog zbog kojeg ovaj kod
 * postoji.
 *
 * Ovdje se glifovi **izbacuju iz naredbi koje ih crtaju**, a razmak koji su
 * zauzimali nadomješta se pomakom u `TJ` polju — tako ostatak retka ostaje
 * točno gdje je bio.
 *
 * Kad se ne može jamčiti da je sve maknuto, ništa se ne mijenja i razlog se
 * prijavljuje. Redakcija koja tiho promaši dio teksta gora je od one koje
 * nema: korisnik misli da je posao obavljen i pošalje dokument dalje.
 */

import { PDFArray, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import type { Rect } from './annotations.js';
import { readPageContent, type Glyph, type Obstacle, type TextOperation } from './content.js';
import type { StandardWidths } from './text.js';

export interface Redaction {
  id: string;
  /** Stranica u IZVORNOM dokumentu, 1-bazirano. */
  page: number;
  /** Područje u korisničkom prostoru stranice. */
  rect: Rect;
  /**
   * Već je provedeno u spremljenoj datoteci.
   *
   * Oznaka ostaje u popisu jer se svako spremanje gradi iz **netaknutog**
   * izvornika: brisanje se time ponavlja s istim ishodom, a micanje oznake
   * vraća tekst. Zato je i poslije spremanja poništavanje stvarno moguće.
   */
  applied?: boolean;
}

export interface RedactionResult {
  bytes: Uint8Array;
  /** Koliko je glifova stvarno maknuto. */
  removed: number;
  /** Stranice koje se nisu dale očistiti, s razlogom. */
  refused: { page: number; reason: string }[];
}

/** Presijecaju li se pravokutnici po površini, a ne samo rubom. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Ulazi li glif u područje — po svom središtu, ne po dodiru.
 *
 * Glifovi u retku dodiruju se rubovima, pa bi pravilo „bilo kakav dodir” od
 * pravokutnika povučenog rukom pojelo i susjedno slovo: promašaj od pola
 * točke pri povlačenju je normalan, a tiho izgubljeno slovo nije.
 *
 * Sigurnost time ne trpi. Glif kojem je središte izvan pravokutnika većim je
 * dijelom izvan njega, pa ga korisnik i vidi da je ostao — ništa se ne krije
 * ispod ničega, jer se preko obrisanog ne crta pravokutnik.
 */
function covers(rect: Rect, box: Rect): boolean {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return `<${out}>`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Pomak koji nadomješta maknuti glif.
 *
 * `TJ` broj pomiče tekst za `-(n/1000) · Tfs · Th`, pa je `n` negativan kad
 * treba pomaknuti unaprijed. Bez toga bi ostatak retka skliznuo ulijevo za
 * širinu maknutog teksta.
 */
function adjustmentFor(advance: number, operation: TextOperation): number {
  const scale = operation.fontSize * operation.horizontalScale;
  if (scale === 0) return 0;
  return -(1000 * advance) / scale;
}

/**
 * Prepisuje jednu naredbu bez maknutih glifova.
 *
 * Izlaz je uvijek `TJ`, bez obzira što je bio ulaz: `TJ` je jedini oblik koji
 * uz nizove nosi i pomake, a pomak je ono što drži ostatak retka na mjestu.
 * Naredbe `'` i `"` u sebi nose i prelazak u novi redak, pa se on ispisuje
 * zasebno.
 */
function rewrite(operation: TextOperation, doomed: Set<Glyph>): string {
  const pieces: string[] = [];
  let pendingAdjust = 0;
  let run: Uint8Array[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const total = run.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const part of run) {
      merged.set(part, at);
      at += part.length;
    }
    pieces.push(hexOf(merged));
    run = [];
  };

  const flushAdjust = () => {
    if (pendingAdjust === 0) return;
    flushRun();
    pieces.push(String(round(pendingAdjust)));
    pendingAdjust = 0;
  };

  for (const part of operation.parts) {
    if (part.kind === 'adjust') {
      flushRun();
      pendingAdjust += part.value;
      continue;
    }

    for (const glyph of part.glyphs) {
      if (doomed.has(glyph)) {
        pendingAdjust += adjustmentFor(glyph.advance, operation);
        continue;
      }
      flushAdjust();
      run.push(glyph.bytes);
    }
  }

  flushAdjust();
  flushRun();

  const array = `[${pieces.join(' ')}] TJ`;

  switch (operation.operator) {
    case "'":
      return `T* ${array}`;
    case '"':
      return `${round(operation.wordSpacing)} Tw ${round(operation.charSpacing)} Tc T* ${array}`;
    default:
      return array;
  }
}

/** Zamjenjuje raspone bajtova, od kraja prema početku da se odmaci ne pomaknu. */
function splice(bytes: Uint8Array, edits: { start: number; end: number; text: string }[]): Uint8Array {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  const encoder = new TextEncoder();
  let out = bytes;

  for (const edit of ordered) {
    const replacement = encoder.encode(edit.text);
    const next = new Uint8Array(out.length - (edit.end - edit.start) + replacement.length);
    next.set(out.subarray(0, edit.start), 0);
    next.set(replacement, edit.start);
    next.set(out.subarray(edit.end), edit.start + replacement.length);
    out = next;
  }

  return out;
}

/** Prepreke koje dodiruju područje koje se briše — ostale se ne tiču ovog posla. */
function blockingObstacles(obstacles: Obstacle[], rects: Rect[]): Obstacle[] {
  return obstacles.filter(
    (obstacle) => !obstacle.box || rects.some((rect) => overlaps(rect, obstacle.box!)),
  );
}

/**
 * Što bi brisanje maknulo — bez mijenjanja dokumenta.
 *
 * Postoji da bi se korisniku moglo pokazati što točno nestaje **prije** nego
 * pritisne potvrdu, jer se obrisani tekst ne vraća iz datoteke.
 */
export function previewRedaction(
  page: PDFPage,
  rects: Rect[],
  standard?: StandardWidths,
): { glyphs: number; obstacles: Obstacle[] } {
  const content = readPageContent(page, standard);
  let glyphs = 0;

  for (const operation of content.operations) {
    for (const part of operation.parts) {
      if (part.kind !== 'glyphs') continue;
      for (const glyph of part.glyphs) {
        if (rects.some((rect) => covers(rect, glyph.box))) glyphs++;
      }
    }
  }

  return { glyphs, obstacles: blockingObstacles(content.obstacles, rects) };
}

/**
 * Miče tekst iz označenih područja i vraća nove bajtove dokumenta.
 *
 * Radi nad IZVORNIM stranicama, prije nego plan preslaže ili briše stranice —
 * područja su zabilježena nad onim što je korisnik vidio.
 */
export async function applyRedactions(
  source: Uint8Array,
  redactions: Redaction[],
  standard?: StandardWidths,
): Promise<RedactionResult> {
  if (redactions.length === 0) {
    return { bytes: source, removed: 0, refused: [] };
  }

  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  const pages = doc.getPages();

  const byPage = new Map<number, Rect[]>();
  for (const redaction of redactions) {
    const list = byPage.get(redaction.page) ?? [];
    list.push(redaction.rect);
    byPage.set(redaction.page, list);
  }

  const refused: { page: number; reason: string }[] = [];
  let removed = 0;
  let changed = false;

  for (const [pageNumber, rects] of byPage) {
    const page = pages[pageNumber - 1];
    if (!page) continue;

    const content = readPageContent(page, standard);

    const blocking = blockingObstacles(content.obstacles, rects);
    if (blocking.length > 0) {
      // Ništa se ne dira: djelomično obrisana stranica izgleda obavljeno.
      refused.push({ page: pageNumber, reason: blocking.map((o) => o.reason).join('; ') });
      continue;
    }

    const edits: { start: number; end: number; text: string }[] = [];

    for (const operation of content.operations) {
      const doomed = new Set<Glyph>();
      for (const part of operation.parts) {
        if (part.kind !== 'glyphs') continue;
        for (const glyph of part.glyphs) {
          if (rects.some((rect) => covers(rect, glyph.box))) doomed.add(glyph);
        }
      }
      if (doomed.size === 0) continue;

      removed += doomed.size;
      edits.push({ start: operation.start, end: operation.end, text: rewrite(operation, doomed) });
    }

    if (edits.length === 0) continue;

    replaceContents(doc, page, splice(content.bytes, edits));
    changed = true;
  }

  if (!changed) {
    return { bytes: source, removed, refused };
  }

  return { bytes: await doc.save({ useObjectStreams: false }), removed, refused };
}

/**
 * Zamjenjuje tok sadržaja stranice jednim novim.
 *
 * **Piše preko postojećeg objekta, ne pokraj njega.** Novi tok uz preusmjeren
 * `/Contents` ostavio bi stari kao siroče: na njega više ništa ne pokazuje,
 * nijedan čitač ga ne crta — a bajtovi s obrisanim tekstom i dalje su u
 * datoteci i vade se prvim alatom koji raspakira tokove. Provjera je upravo
 * to i uhvatila.
 *
 * Polje tokova se pritom sažima u prvi — pročitano je kao jedno, pa se kao
 * jedno i vraća; ostali se prazne da ne ostane ništa staro.
 */
function replaceContents(doc: PDFDocument, page: PDFPage, bytes: Uint8Array): void {
  const raw = page.node.get(PDFName.of('Contents'));

  const refs: PDFRef[] = [];
  if (raw instanceof PDFRef) refs.push(raw);
  else if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i++) {
      const item = raw.get(i);
      if (item instanceof PDFRef) refs.push(item);
    }
  }

  const first = refs[0];
  if (!first) {
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)));
    return;
  }

  doc.context.assign(first, doc.context.flateStream(bytes));
  for (const ref of refs.slice(1)) {
    doc.context.assign(ref, doc.context.flateStream(new Uint8Array(0)));
  }
  page.node.set(PDFName.of('Contents'), first);
}

/** Poruka o stranicama koje se nisu dale očistiti. */
export function refusalWarning(refused: RedactionResult['refused']): string[] {
  return refused.map(({ page, reason }) =>
    t('Page {n} was left untouched — the text there cannot be removed safely ({reason}).', {
      n: page,
      reason,
    }),
  );
}
