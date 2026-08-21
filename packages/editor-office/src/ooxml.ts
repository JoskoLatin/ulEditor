/**
 * What OOXML containers (DOCX, XLSX) have in common.
 *
 * Both are ZIP with XML inside and both share the same relationship system
 * (`_rels`), so parsing the container lives here while mapping the content lives
 * in `docx.ts` and `xlsx.ts` respectively.
 *
 * A deliberate boundary: this layer **only reads**. Phase 2 brings writing back
 * (ProseMirror + Univer), and only then does the fidelity rule start to matter —
 * while nothing is saved, nothing can be quietly corrupted.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { t } from '@uleditor/i18n';

export type Archive = Record<string, Uint8Array>;

export function openArchive(bytes: Uint8Array): Archive {
  try {
    return unzipSync(bytes);
  } catch {
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
