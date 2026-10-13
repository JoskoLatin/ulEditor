/**
 * What OOXML containers (DOCX, XLSX) have in common.
 *
 * Both are ZIP with XML inside and both share the same relationship system
 * (`_rels`), so parsing the container lives here while mapping the content lives
 * in `docx.ts` and `xlsx.ts` respectively.
 *
 * A deliberate boundary: this layer **only reads**. Writing is the business of
 * `docx-edit.ts` and `xlsx-edit.ts`, which change the bytes the file already has
 * rather than serialise it afresh — ProseMirror and Univer, in the first plan,
 * were not taken.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { t } from '@uleditor/i18n';

export type Archive = Record<string, Uint8Array>;

/**
 * What an archive may unpack to: a part, all of them, and how many. The
 * largest part among Čovik's 74 Office files is 10.4 MB and the largest
 * whole 11.1 MB, with 35 parts at most; a ZIP of a few kilobytes can claim
 * gigabytes, and unpacked whole in the page it takes the page down with
 * whatever else is unsaved in it (card 528). Held well below what the page
 * holds: a part's XML takes some eighteen times its size as a DOM (measured
 * by the review of 6f5e284: 64 MiB of XML, 1.16 GiB), so 64 MiB a part and
 * 128 MiB in all.
 */
export const MOST_PART_BYTES = 64 * 1024 * 1024;
export const MOST_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MOST_PARTS = 10_000;

/**
 * A ZIP unpacked within those bounds, or refused, saying so.
 *
 * The directory is read first, alone, and nothing is unpacked until all of
 * it is within bounds. What a part comes to is what fflate would make of
 * it: a stored part is copied whole, at its packed size, whatever it
 * declares; a deflated one is made into a buffer of the size it declares,
 * and anything past that is dropped (measured: 100 bytes declared of fifty
 * megabytes gave 100 bytes). The packed sizes together may not exceed the
 * file: an honest ZIP never shares bytes between parts, and stored parts
 * pointing at one stretch had come to 2 GiB out of a file of 20 MiB (the
 * review of 6f5e284). Refused by a throw, which also ends the walk: a
 * directory end claiming four billion entries, in 185 bytes, kept the walk
 * going for minutes when a part was only left out.
 */
export function boundedUnzip(bytes: Uint8Array): Archive {
  let total = 0;
  let packed = 0;
  let parts = 0;
  unzipSync(bytes, {
    filter: (file) => {
      parts += 1;
      packed += file.size;
      const out = file.compression === 0 ? file.size : file.originalSize;
      total += out;
      if (parts > MOST_PARTS || out > MOST_PART_BYTES || total > MOST_ARCHIVE_BYTES || packed > bytes.length) {
        throw new ArchiveTooLarge();
      }
      return false;
    },
  });
  return unzipSync(bytes);
}

/** An archive that would unpack to more than `boundedUnzip` takes. */
export class ArchiveTooLarge extends Error {
  constructor() {
    super(t('This file would unpack to more than this program opens at once, so it is not opened.'));
  }
}

export function openArchive(bytes: Uint8Array): Archive {
  try {
    return boundedUnzip(bytes);
  } catch (err) {
    if (err instanceof ArchiveTooLarge) throw err;
    // The message from fflate ("invalid zip data") means nothing to a user.
    throw new Error(
      t('This is not a valid Office archive — it is probably damaged or incompletely downloaded.'),
    );
  }
}

/** The raw text of an archive part — edits are made against it, not against the DOM. */
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
 * Lookup by local name. OOXML is full of prefixes (`w:`, `a:`, `r:`) that
 * `querySelector` does not resolve reliably in an XML document.
 */
export function tags(root: ParentNode, local: string): Element[] {
  return [...root.querySelectorAll('*')].filter((el) => el.localName === local);
}

export function tag(root: ParentNode, local: string): Element | null {
  return tags(root, local)[0] ?? null;
}

/** Direct children only — it matters with nested tables and paragraphs. */
export function children(root: Element, local: string): Element[] {
  return [...root.children].filter((el) => el.localName === local);
}

export function child(root: Element, local: string): Element | null {
  return children(root, local)[0] ?? null;
}

/** An attribute regardless of its namespace prefix. */
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

/* ── images ──────────────────────────────────────────────────────────── */

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
 * A blob URL for an embedded image. EMF/WMF are Windows vector formats a browser
 * cannot display — we return `null` so the caller reports it instead of leaving
 * a broken icon.
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

/** EMU (English Metric Unit) is the OOXML unit: 914,400 per inch. */
export function emuToPx(emu: number): number {
  return Math.round(emu / 9525);
}
