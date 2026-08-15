/**
 * Čitanje EPUB arhive.
 *
 * EPUB je ZIP s XHTML-om unutra, pa je posao u tri koraka: naći kazalo
 * (`container.xml` → OPF), složiti redoslijed poglavlja (spine) i pretvoriti
 * svako poglavlje u siguran DOM.
 *
 * Dvije odluke koje se vide korisniku:
 *
 * 1. **Izdavačev CSS se namjerno ne primjenjuje.** Knjige nose stilove koji
 *    fiksiraju veličinu slova, boje i margine — točno ono što čitaonica daje
 *    korisniku da mijenja. Tekst se prikazuje tipografijom čitaonice, a to se
 *    pošteno prijavljuje kroz `notes`.
 * 2. **Sadržaj uvijek prolazi kroz DOMPurify.** XHTML dolazi iz datoteke koju
 *    je netko skinuo s interneta; `innerHTML` bez sanitizacije bio bi XSS u
 *    vlastitoj aplikaciji.
 */

import { unzipSync, strFromU8 } from 'fflate';
import DOMPurify from 'dompurify';

export interface BookChapter {
  /** `id` iz OPF manifesta. */
  id: string;
  /** Normalizirana putanja unutar arhive — po njoj se razrješavaju veze. */
  href: string;
  title: string;
  /** Živi element; drži se između montaža da reference iz pretrage ostanu valjane. */
  body: HTMLElement;
  /** Čist tekst, za pretragu i procjenu duljine čitanja. */
  text: string;
}

export interface BookOutlineEntry {
  id: string;
  label: string;
  depth: number;
  /** Indeks poglavlja u `chapters`. */
  chapter: number;
  /** Sidro unutar poglavlja, ako ga kazalo navodi. */
  anchor: string | null;
}

export interface Book {
  title: string;
  author: string;
  language: string;
  /** Blob URL naslovnice, kad je knjiga ima. */
  cover: string | null;
  chapters: BookChapter[];
  outline: BookOutlineEntry[];
  /** Što pregled ne reproducira — prikazuje se u čitaonici. */
  notes: string[];
  /** Oslobađa blob URL-ove slika. Bez ovoga knjiga curi memoriju po zatvaranju. */
  release(): void;
}

/* ── putanje ─────────────────────────────────────────────────────────── */

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Razrješava relativnu putanju unutar arhive; ZIP nema `..` pa ih rješavamo sami. */
function resolvePath(base: string, href: string): string {
  const raw = href.split('#')[0] ?? '';
  if (!raw) return base;
  if (raw.startsWith('/')) return raw.slice(1);

  const parts = base ? base.split('/') : [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function anchorOf(href: string): string | null {
  const hash = href.indexOf('#');
  return hash === -1 ? null : href.slice(hash + 1);
}

/* ── XML ─────────────────────────────────────────────────────────────── */

function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Neispravan XML u arhivi.');
  return doc;
}

/**
 * Dohvat po lokalnom imenu. EPUB miješa prostore imena (`opf:`, `dc:`, bez
 * prefiksa), a `querySelector` s prefiksom u XML dokumentu ne radi pouzdano.
 */
function byTag(root: ParentNode, local: string): Element[] {
  return [...root.querySelectorAll('*')].filter((el) => el.localName === local);
}

function firstTag(root: ParentNode, local: string): Element | null {
  return byTag(root, local)[0] ?? null;
}

/* ── manifest ────────────────────────────────────────────────────────── */

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string;
}

const IMAGE_TYPES = /^image\//;

function findOpfPath(files: Record<string, Uint8Array>): string {
  const container = files['META-INF/container.xml'];
  if (container) {
    const rootfile = firstTag(parseXml(strFromU8(container)), 'rootfile');
    const full = rootfile?.getAttribute('full-path');
    if (full) return full;
  }
  // Neke knjige nemaju ispravan kontejner; OPF je ipak jedinstven po ekstenziji.
  const guess = Object.keys(files).find((name) => name.toLowerCase().endsWith('.opf'));
  if (!guess) throw new Error('Arhiva nema OPF datoteku — ovo nije EPUB knjiga.');
  return guess;
}

/* ── kazalo ──────────────────────────────────────────────────────────── */

interface RawOutline {
  label: string;
  href: string;
  depth: number;
}

/** EPUB 3: navigacijski dokument s ugniježđenim `<ol>`. */
function readNav(doc: Document, base: string): RawOutline[] {
  const navs = byTag(doc, 'nav');
  const toc =
    navs.find((nav) => (nav.getAttribute('epub:type') ?? nav.getAttribute('type')) === 'toc') ??
    navs[0];
  if (!toc) return [];

  const out: RawOutline[] = [];
  const walk = (list: Element, depth: number) => {
    for (const li of [...list.children].filter((el) => el.localName === 'li')) {
      const link = [...li.children].find((el) => el.localName === 'a' || el.localName === 'span');
      const href = link?.getAttribute('href');
      if (link && href) {
        out.push({ label: (link.textContent ?? '').trim(), href: resolveHref(base, href), depth });
      }
      const nested = [...li.children].find((el) => el.localName === 'ol' || el.localName === 'ul');
      if (nested) walk(nested, depth + 1);
    }
  };

  const root = [...toc.children].find((el) => el.localName === 'ol' || el.localName === 'ul');
  if (root) walk(root, 0);
  return out;
}

/** EPUB 2: NCX s `navPoint` stablom. */
function readNcx(doc: Document, base: string): RawOutline[] {
  const map = firstTag(doc, 'navMap');
  if (!map) return [];

  const out: RawOutline[] = [];
  const walk = (parent: Element, depth: number) => {
    for (const point of [...parent.children].filter((el) => el.localName === 'navPoint')) {
      const label = [...point.children].find((el) => el.localName === 'navLabel');
      const content = [...point.children].find((el) => el.localName === 'content');
      const href = content?.getAttribute('src');
      if (href) {
        out.push({ label: (label?.textContent ?? '').trim(), href: resolveHref(base, href), depth });
      }
      walk(point, depth + 1);
    }
  };

  walk(map, 0);
  return out;
}

/** Zadržava sidro, ali putanju normalizira — kazalo cilja `poglavlje.xhtml#s3`. */
function resolveHref(base: string, href: string): string {
  const anchor = anchorOf(href);
  const path = resolvePath(base, href);
  return anchor ? `${path}#${anchor}` : path;
}

/* ── sadržaj poglavlja ───────────────────────────────────────────────── */

/**
 * XHTML → siguran, samostalan DOM.
 *
 * Slike se prevode na blob URL-ove; one koje nedostaju se uklanjaju umjesto da
 * ostanu kao slomljena ikona. Unutarnje veze zadržavaju odredište u
 * `data-link`, pa čitaonica može skočiti na poglavlje bez navigacije prozora.
 */
function buildBody(
  source: string,
  chapterPath: string,
  blobs: Map<string, string>,
): { body: HTMLElement; text: string } {
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (parsed.querySelector('parsererror')) throw new Error('xhtml');
  } catch {
    // Knjige u divljini nisu uvijek valjan XHTML; HTML parser je popustljiv.
    parsed = new DOMParser().parseFromString(source, 'text/html');
  }

  const fragment = DOMPurify.sanitize(parsed.body?.innerHTML ?? '', {
    RETURN_DOM_FRAGMENT: true,
    ADD_ATTR: ['epub:type', 'target'],
    FORBID_TAGS: ['style', 'link', 'form', 'input', 'button', 'audio', 'video'],
    FORBID_ATTR: ['style'],
  });

  const body = document.createElement('div');
  body.className = 'ul-book-chapter';
  body.appendChild(fragment);

  const base = dirname(chapterPath);

  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src');
    const blob = src ? blobs.get(resolvePath(base, src)) : undefined;
    if (blob) img.setAttribute('src', blob);
    else img.remove();
  }

  // SVG `<image xlink:href>` — česta naslovnica u starijim knjigama.
  for (const image of [...body.querySelectorAll('image')]) {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href');
    const blob = href ? blobs.get(resolvePath(base, href)) : undefined;
    if (blob) image.setAttribute('href', blob);
    else image.remove();
  }

  for (const link of [...body.querySelectorAll('a[href]')]) {
    const href = link.getAttribute('href') ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    link.setAttribute('data-link', resolveHref(base, href));
    link.removeAttribute('href');
  }

  return { body, text: (body.textContent ?? '').replace(/\s+/g, ' ').trim() };
}

function titleOf(body: HTMLElement, fallback: string): string {
  const heading = body.querySelector('h1, h2, h3, h4, h5, h6');
  const text = (heading?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : fallback;
}

/* ── otvaranje ───────────────────────────────────────────────────────── */

export function openEpub(bytes: Uint8Array): Book {
  const files = unzipSync(bytes);

  // DRM se ne zaobilazi. Bolje reći odmah nego prikazati kašu.
  if (files['META-INF/encryption.xml']) {
    throw new Error(
      'Knjiga je zaštićena DRM-om, pa se sadržaj ne može pročitati. ulEditor namjerno ne zaobilazi zaštitu.',
    );
  }

  const opfPath = findOpfPath(files);
  const opfDir = dirname(opfPath);
  const opfBytes = files[opfPath];
  if (!opfBytes) throw new Error(`OPF datoteka ${opfPath} nedostaje u arhivi.`);
  const opf = parseXml(strFromU8(opfBytes));

  const metadata = firstTag(opf, 'metadata');
  const meta = (local: string): string => {
    if (!metadata) return '';
    const el = byTag(metadata, local)[0];
    return (el?.textContent ?? '').trim();
  };

  const items = new Map<string, ManifestItem>();
  const manifest = firstTag(opf, 'manifest');
  if (manifest) {
    for (const el of byTag(manifest, 'item')) {
      const id = el.getAttribute('id');
      const href = el.getAttribute('href');
      if (!id || !href) continue;
      items.set(id, {
        id,
        path: resolvePath(opfDir, href),
        mediaType: el.getAttribute('media-type') ?? '',
        properties: el.getAttribute('properties') ?? '',
      });
    }
  }

  /* Slike u blob URL-ove — jedini resursi koje uzimamo iz knjige. */
  const blobs = new Map<string, string>();
  for (const item of items.values()) {
    if (!IMAGE_TYPES.test(item.mediaType)) continue;
    const data = files[item.path];
    if (!data) continue;
    const copy = new Uint8Array(data.length);
    copy.set(data);
    blobs.set(item.path, URL.createObjectURL(new Blob([copy], { type: item.mediaType })));
  }

  /* Redoslijed čitanja. */
  const spine = firstTag(opf, 'spine');
  const order: ManifestItem[] = [];
  if (spine) {
    for (const ref of byTag(spine, 'itemref')) {
      const item = items.get(ref.getAttribute('idref') ?? '');
      if (item && files[item.path]) order.push(item);
    }
  }
  if (order.length === 0) {
    throw new Error('Knjiga nema nijedno poglavlje u redoslijedu čitanja (spine).');
  }

  const chapters: BookChapter[] = order.map((item, index) => {
    const data = files[item.path]!;
    const { body, text } = buildBody(strFromU8(data), item.path, blobs);
    return {
      id: item.id,
      href: item.path,
      title: titleOf(body, `Poglavlje ${index + 1}`),
      body,
      text,
    };
  });

  /* Kazalo — EPUB 3 nav, pa EPUB 2 NCX, pa poglavlja kakva jesu. */
  const byPath = new Map(chapters.map((c, index) => [c.href, index]));
  let raw: RawOutline[] = [];

  const navItem = [...items.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  const navBytes = navItem ? files[navItem.path] : undefined;
  if (navItem && navBytes) {
    try {
      raw = readNav(parseXml(strFromU8(navBytes)), dirname(navItem.path));
    } catch {
      raw = [];
    }
  }

  if (raw.length === 0) {
    const ncxItem = items.get(spine?.getAttribute('toc') ?? '');
    const ncxBytes = ncxItem ? files[ncxItem.path] : undefined;
    if (ncxItem && ncxBytes) {
      try {
        raw = readNcx(parseXml(strFromU8(ncxBytes)), dirname(ncxItem.path));
      } catch {
        raw = [];
      }
    }
  }

  const outline: BookOutlineEntry[] = [];
  for (const entry of raw) {
    const path = entry.href.split('#')[0] ?? '';
    const chapter = byPath.get(path);
    if (chapter === undefined) continue;
    outline.push({
      id: `toc-${outline.length}`,
      label: entry.label || chapters[chapter]!.title,
      depth: Math.min(entry.depth, 3),
      chapter,
      anchor: anchorOf(entry.href),
    });
  }

  if (outline.length === 0) {
    chapters.forEach((chapter, index) => {
      outline.push({ id: `toc-${index}`, label: chapter.title, depth: 0, chapter: index, anchor: null });
    });
  }

  /* Naslovnica. */
  const coverId =
    byTag(opf, 'meta')
      .find((el) => el.getAttribute('name') === 'cover')
      ?.getAttribute('content') ?? '';
  const coverItem =
    items.get(coverId) ??
    [...items.values()].find((item) => item.properties.split(/\s+/).includes('cover-image'));
  const cover = coverItem ? (blobs.get(coverItem.path) ?? null) : null;

  /* Što pregled ne reproducira. */
  const notes: string[] = [];
  if ([...items.values()].some((item) => item.mediaType === 'text/css')) {
    notes.push('Izdavačevi stilovi se ne primjenjuju — tekst nosi tipografiju čitaonice.');
  }
  if ([...items.values()].some((item) => item.mediaType.startsWith('font/') || /font/.test(item.mediaType))) {
    notes.push('Ugrađeni fontovi se ne učitavaju.');
  }
  if ([...items.values()].some((item) => /^(audio|video)\//.test(item.mediaType))) {
    notes.push('Audio i video sadržaj knjige nije prikazan.');
  }

  return {
    title: meta('title') || 'Bez naslova',
    author: meta('creator'),
    language: meta('language'),
    cover,
    chapters,
    outline,
    notes,
    release: () => {
      for (const url of blobs.values()) URL.revokeObjectURL(url);
      blobs.clear();
    },
  };
}

/** Prosječna brzina čitanja na koju se oslanja procjena preostalog vremena. */
export const WORDS_PER_MINUTE = 220;
