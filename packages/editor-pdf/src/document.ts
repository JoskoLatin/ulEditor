/**
 * Plan stranica i zapis izmijenjenog dokumenta.
 *
 * Operacije nad stranicama ne mijenjaju ništa dok se ne spremi — do tada
 * postoji samo *plan*: koja izvorna stranica ide na koje mjesto i s kojom
 * rotacijom. To je ono što čini undo trivijalnim i što omogućuje da se
 * anotacije drže uz svoju izvornu stranicu bez obzira koliko se puta
 * preslože.
 */

import { PDFDocument, degrees } from 'pdf-lib';
import { t } from '@uleditor/i18n';

import { missingGlyphWarning, writeAnnotations, type Annotation } from './annotations.js';
import type { FontLoader } from './text.js';

export interface PagePlan {
  /** Broj stranice u IZVORNOM dokumentu, 1-baziran. */
  source: number;
  /** Dodatna rotacija povrh one koju stranica već ima: 0, 90, 180 ili 270. */
  rotate: number;
}

export function identityPlan(pageCount: number): PagePlan[] {
  return Array.from({ length: pageCount }, (_, i) => ({ source: i + 1, rotate: 0 }));
}

/** Je li plan netaknut — isti redoslijed, sve stranice, bez rotacija. */
export function isIdentity(plan: PagePlan[], pageCount: number): boolean {
  if (plan.length !== pageCount) return false;
  return plan.every((entry, index) => entry.source === index + 1 && entry.rotate === 0);
}

export function rotatePage(plan: PagePlan[], index: number, delta: number): PagePlan[] {
  return plan.map((entry, i) =>
    i === index ? { ...entry, rotate: (((entry.rotate + delta) % 360) + 360) % 360 } : entry,
  );
}

export function removePage(plan: PagePlan[], index: number): PagePlan[] {
  // Dokument bez ijedne stranice nije valjan PDF.
  if (plan.length <= 1) return plan;
  return plan.filter((_, i) => i !== index);
}

export function movePage(plan: PagePlan[], index: number, delta: number): PagePlan[] {
  const target = index + delta;
  if (target < 0 || target >= plan.length) return plan;
  const next = [...plan];
  const [entry] = next.splice(index, 1);
  if (entry) next.splice(target, 0, entry);
  return next;
}

/** Izvorna stranica (1-bazirano) → mjesto u izlazu (0-bazirano). */
export function pageMapOf(plan: PagePlan[]): Map<number, number> {
  const map = new Map<number, number>();
  plan.forEach((entry, index) => {
    // Ako se ista stranica pojavi više puta, anotacije idu na prvu pojavu.
    if (!map.has(entry.source)) map.set(entry.source, index);
  });
  return map;
}

/** Koliko je stranica obrisano, rotirano i premješteno — za opis izmjena. */
export function describePlan(plan: PagePlan[], pageCount: number): string[] {
  const changes: string[] = [];

  const removed = pageCount - plan.length;
  if (removed > 0) changes.push(t('{n} pages deleted', { n: removed }));

  const rotated = plan.filter((e) => e.rotate !== 0).length;
  if (rotated > 0) changes.push(t('{n} rotated', { n: rotated }));

  const reordered = plan.some((entry, index) => entry.source !== index + 1);
  if (reordered && removed === 0) changes.push(t('order changed'));

  return changes;
}

/** Je li redoslijed stranica promijenjen (a ne samo skraćen s kraja). */
function isReordered(plan: PagePlan[]): boolean {
  for (let i = 1; i < plan.length; i++) {
    if (plan[i]!.source < plan[i - 1]!.source) return true;
  }
  return false;
}

export interface SaveDocumentResult {
  bytes: Uint8Array;
  /** Značajke izvornog dokumenta koje ovaj zapis nije mogao zadržati. */
  lost: string[];
}

/**
 * Zapisuje dokument prema planu i s anotacijama.
 *
 * Dva puta, namjerno:
 *
 * - **Rotacija i brisanje** se rade na izvornom dokumentu. Sve što nas se ne
 *   tiče — oznake, obrasci, metapodaci, priloge — ostaje netaknuto.
 * - **Preslagivanje** zahtijeva presnimavanje stranica u novi dokument, jer
 *   stablo stranica u PDF-u može biti ugniježđeno i nije ga sigurno prepisivati
 *   ručno. Cijena je gubitak onoga što živi izvan samih stranica, pa se to
 *   prijavljuje pozivatelju umjesto da se tiho izgubi.
 */
export async function saveDocument(
  source: Uint8Array,
  plan: PagePlan[],
  annotations: Annotation[],
  pageCount: number,
  /** Bajtovi fonta za tekstualne okvire. */
  loadFont?: FontLoader,
): Promise<SaveDocumentResult> {
  const lost: string[] = [];

  if (isIdentity(plan, pageCount)) {
    const { bytes, missingGlyphs } = await writeAnnotations(
      source,
      annotations,
      undefined,
      loadFont,
    );
    return { bytes, lost: missingGlyphWarning(missingGlyphs) };
  }

  let working: Uint8Array;

  if (isReordered(plan)) {
    const original = await PDFDocument.load(source, { ignoreEncryption: true });
    const rebuilt = await PDFDocument.create();

    const copied = await rebuilt.copyPages(
      original,
      plan.map((entry) => entry.source - 1),
    );
    copied.forEach((page, index) => {
      const entry = plan[index]!;
      if (entry.rotate !== 0) {
        page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
      }
      rebuilt.addPage(page);
    });

    // Metapodaci se prenose ručno; ostalo izvan stranica se gubi.
    rebuilt.setTitle(original.getTitle() ?? '');
    rebuilt.setAuthor(original.getAuthor() ?? '');
    rebuilt.setSubject(original.getSubject() ?? '');

    lost.push(t('Reordering pages does not preserve bookmarks, forms or attachments.'));
    working = await rebuilt.save({ useObjectStreams: false });
  } else {
    // Samo rotacije i brisanja — radi se na izvorniku, bez gubitka.
    const doc = await PDFDocument.load(source, { ignoreEncryption: true });
    const keep = new Set(plan.map((entry) => entry.source));

    for (const entry of plan) {
      if (entry.rotate === 0) continue;
      const page = doc.getPage(entry.source - 1);
      page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
    }

    // Brisanje ide unatrag da se indeksi ne pomaknu ispod nogu.
    for (let i = pageCount; i >= 1; i--) {
      if (!keep.has(i)) doc.removePage(i - 1);
    }

    working = await doc.save({ useObjectStreams: false });
  }

  const { bytes, missingGlyphs } = await writeAnnotations(
    working,
    annotations,
    pageMapOf(plan),
    loadFont,
  );
  return { bytes, lost: [...lost, ...missingGlyphWarning(missingGlyphs)] };
}

/* ── spajanje i izdvajanje ───────────────────────────────────────────── */

/**
 * Spaja stranice drugog PDF-a u postojeći plan.
 *
 * Vraća **nove bajtove izvornika** uz prošireni plan: spajanje se, za razliku
 * od rotacije i brisanja, ne može opisati planom nad starim izvornikom, jer
 * stranice koje se dodaju u njemu ne postoje. Zato je ovo jedina operacija nad
 * stranicama koja odmah mijenja izvornik u memoriji.
 */
export async function mergeInto(
  source: Uint8Array,
  plan: PagePlan[],
  incoming: Uint8Array,
  at: number,
): Promise<{ bytes: Uint8Array; plan: PagePlan[]; added: number; lost: string[] }> {
  const base = await PDFDocument.load(source, { ignoreEncryption: true });
  const extra = await PDFDocument.load(incoming, { ignoreEncryption: true });

  const before = base.getPageCount();
  const pages = await base.copyPages(extra, extra.getPageIndices());
  for (const page of pages) base.addPage(page);

  const added = pages.length;
  if (added === 0) throw new Error(t('The chosen PDF has no pages.'));

  // Nove stranice su na kraju izvornika, ali u planu idu na traženo mjesto.
  const inserted: PagePlan[] = Array.from({ length: added }, (_, i) => ({
    source: before + i + 1,
    rotate: 0,
  }));

  const index = Math.max(0, Math.min(at, plan.length));
  const next = [...plan.slice(0, index), ...inserted, ...plan.slice(index)];

  return {
    bytes: await base.save({ useObjectStreams: false }),
    plan: next,
    added,
    lost: [t('Merging does not carry over bookmarks, forms or attachments from the inserted document.')],
  };
}

/**
 * Izdvaja podskup stranica u novi dokument. Izvornik ostaje netaknut — zato
 * "izdvajanje", a ne "razdvajanje": nitko ne želi da mu se dokument raspolovi
 * na disku zato što je htio izvući tri stranice.
 */
export async function extractPages(
  source: Uint8Array,
  plan: PagePlan[],
  positions: number[],
): Promise<Uint8Array> {
  const wanted = [...new Set(positions)].sort((a, b) => a - b);
  const entries = wanted.map((position) => plan[position - 1]).filter((e): e is PagePlan => !!e);
  if (entries.length === 0) throw new Error(t('No page selected.'));

  const original = await PDFDocument.load(source, { ignoreEncryption: true });
  const out = await PDFDocument.create();

  const copied = await out.copyPages(
    original,
    entries.map((entry) => entry.source - 1),
  );
  copied.forEach((page, index) => {
    const entry = entries[index]!;
    if (entry.rotate !== 0) {
      page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
    }
    out.addPage(page);
  });

  out.setTitle(original.getTitle() ?? '');
  return out.save({ useObjectStreams: false });
}

/** `1-3, 7, 10-12` → `[1,2,3,7,10,11,12]`, ograničeno na postojeće stranice. */
export function parseRanges(input: string, max: number): number[] {
  const out = new Set<number>();

  for (const part of input.split(',')) {
    const piece = part.trim();
    if (!piece) continue;

    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (i >= 1 && i <= max) out.add(i);
      }
      continue;
    }

    const single = Number(piece);
    if (Number.isInteger(single) && single >= 1 && single <= max) out.add(single);
  }

  return [...out].sort((a, b) => a - b);
}
