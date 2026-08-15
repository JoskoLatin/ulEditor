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

import { writeAnnotations, type Annotation } from './annotations.js';

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
  if (removed > 0) changes.push(`${removed} obrisanih stranica`);

  const rotated = plan.filter((e) => e.rotate !== 0).length;
  if (rotated > 0) changes.push(`${rotated} rotiranih`);

  const reordered = plan.some((entry, index) => entry.source !== index + 1);
  if (reordered && removed === 0) changes.push('promijenjen redoslijed');

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
): Promise<SaveDocumentResult> {
  const lost: string[] = [];

  if (isIdentity(plan, pageCount)) {
    const { bytes } = await writeAnnotations(source, annotations);
    return { bytes, lost };
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

    lost.push('Preslagivanje stranica ne zadržava oznake (bookmarks), obrasce ni priloge.');
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

  const { bytes } = await writeAnnotations(working, annotations, pageMapOf(plan));
  return { bytes, lost };
}
