/**
 * Zajedničko za OOXML kontejnere (DOCX, XLSX).
 *
 * Oba su ZIP s XML-om i oba dijele isti sustav veza (`_rels`), pa parsiranje
 * kontejnera stoji ovdje, a mapiranje sadržaja u `docx.ts` odnosno `xlsx.ts`.
 *
 * Namjerna granica: ovaj sloj **samo čita**. Faza 2 donosi pisanje natrag
 * (ProseMirror + Univer), i tek tada postaje važno pravilo o vjernosti —
 * dok se ne sprema, ništa se ne može tiho pokvariti.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { t } from '@uleditor/i18n';

export type Archive = Record<string, Uint8Array>;

export function openArchive(bytes: Uint8Array): Archive {
  try {
    return unzipSync(bytes);
  } catch {
    // Poruka iz fflate ("invalid zip data") korisniku ne znači ništa.
    throw new Error(
      t('This is not a valid Office archive — it is probably damaged or incompletely downloaded.'),
    );
  }
}

/** Sirovi tekst dijela arhive — izmjene se rade nad njim, ne nad DOM-om. */
export function readText(archive: Archive, path: string): string | null {
  const data = archive[path];
  return data ? strFromU8(data) : null;
}

export function readXml(archive: Archive, path: string): Document | null {
  const data = archive[path];
  if (!data) return null;
  const doc = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
  return doc.querySelector('parsererror') ? null : doc;
}

/**
 * Dohvat po lokalnom imenu. OOXML je pun prefiksa (`w:`, `a:`, `r:`) koje
 * `querySelector` u XML dokumentu ne razrješava pouzdano.
 */
export function tags(root: ParentNode, local: string): Element[] {
  return [...root.querySelectorAll('*')].filter((el) => el.localName === local);
}

export function tag(root: ParentNode, local: string): Element | null {
  return tags(root, local)[0] ?? null;
}

/** Samo izravna djeca — bitno kod ugniježđenih tablica i odlomaka. */
export function children(root: Element, local: string): Element[] {
  return [...root.children].filter((el) => el.localName === local);
}

export function child(root: Element, local: string): Element | null {
  return children(root, local)[0] ?? null;
}

/** Atribut bez obzira na prefiks prostora imena. */
export function attr(el: Element | null, local: string): string | null {
  if (!el) return null;
  for (const a of [...el.attributes]) {
    if (a.localName === local) return a.value;
  }
  return null;
}

export function attrNum(el: Element | null, local: string): number | null {
  const raw = attr(el, local);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/* ── veze ────────────────────────────────────────────────────────────── */

export type Relationships = Map<string, { target: string; type: string; external: boolean }>;

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function resolveIn(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base ? base.split('/') : [];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** `word/document.xml` → `word/_rels/document.xml.rels`. */
export function readRelationships(archive: Archive, partPath: string): Relationships {
  const dir = dirname(partPath);
  const name = partPath.slice(dir ? dir.length + 1 : 0);
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${name}.rels`;

  const map: Relationships = new Map();
  const doc = readXml(archive, relsPath);
  if (!doc) return map;

  for (const el of tags(doc, 'Relationship')) {
    const id = attr(el, 'Id');
    const target = attr(el, 'Target');
    if (!id || !target) continue;
    const external = (attr(el, 'TargetMode') ?? '') === 'External';
    map.set(id, {
      target: external ? target : resolveIn(dir, target),
      type: attr(el, 'Type') ?? '',
      external,
    });
  }
  return map;
}

/* ── slike ───────────────────────────────────────────────────────────── */

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: '',
  wmf: '',
};

/**
 * Blob URL za ugrađenu sliku. EMF/WMF su Windows vektorski formati koje
 * preglednik ne zna prikazati — vraćamo `null` da pozivatelj to prijavi
 * umjesto da ostane slomljena ikona.
 */
export function imageUrl(archive: Archive, path: string): string | null {
  const data = archive[path];
  if (!data) return null;

  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) return null;
  if (mime === '') return null;

  const copy = new Uint8Array(data.length);
  copy.set(data);
  return URL.createObjectURL(new Blob([copy], { type: mime }));
}

/** EMU (English Metric Unit) je jedinica OOXML-a: 914 400 po inču. */
export function emuToPx(emu: number): number {
  return Math.round(emu / 9525);
}
