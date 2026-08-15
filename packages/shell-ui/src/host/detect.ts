/**
 * Detekcija formata.
 *
 * Mjerodavan je sadržaj, ne ime datoteke. Ekstenzija se koristi samo kad
 * potpis ništa ne kaže — inače bi preimenovani `.txt` PDF otvorio krivi editor.
 *
 * Ova logika se u fazi 1 seli u `crates/ul-formats` (Rust) da web i desktop
 * dijele isti kod; `FormatId` vrijednosti moraju ostati identične.
 */

import type { FormatDetection, FormatId } from '@uleditor/plugin-sdk';

/** Ekstenzija → jezik za syntax highlighting. */
const CODE_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  rs: 'rust',
  py: 'python',
  pyi: 'python',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'shell',
  sql: 'sql',
  go: 'go',
  java: 'java',
  kt: 'java',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'cpp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  vue: 'html',
  svelte: 'html',
};

const PLAIN_TEXT = new Set(['txt', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env', 'gitignore']);
const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

/** Datoteke bez ekstenzije koje su ipak tekst. */
const KNOWN_NAMES: Record<string, { format: FormatId; language?: string }> = {
  dockerfile: { format: 'code', language: 'shell' },
  makefile: { format: 'code', language: 'shell' },
  license: { format: 'text' },
  readme: { format: 'markdown' },
  '.gitignore': { format: 'text' },
  '.npmrc': { format: 'text' },
  '.editorconfig': { format: 'text' },
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Traži ASCII niz u prvih `limit` bajtova. Za razlikovanje ZIP kontejnera. */
function containsAscii(bytes: Uint8Array, needle: string, limit = 4096): boolean {
  const end = Math.min(bytes.length, limit);
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i <= end - needle.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * DOCX, XLSX, PPTX i ODF su svi ZIP arhive. Razlikuju se po unutarnjim
 * putanjama, koje se pojavljuju kao čist ASCII u ZIP zaglavljima — dovoljno
 * za detekciju bez raspakiravanja.
 */
function classifyZip(bytes: Uint8Array): FormatId {
  // EPUB i ODF drže `mimetype` kao prvi, nekomprimirani unos — potpis stoji
  // odmah iza ZIP zaglavlja, pa je dovoljno pogledati prvih 128 bajtova.
  if (containsAscii(bytes, 'mimetypeapplication/epub+zip', 128)) return 'epub';
  if (containsAscii(bytes, 'mimetypeapplication/vnd.oasis.opendocument', 128)) return 'odf';

  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  if (containsAscii(head, 'word/document.xml', head.length)) return 'docx';
  if (containsAscii(head, 'xl/workbook.xml', head.length)) return 'xlsx';
  if (containsAscii(head, 'ppt/presentation.xml', head.length)) return 'pptx';
  // EPUB bez nekomprimiranog `mimetype` unosa (nije po specifikaciji, ali
  // postoji u divljini) — prepoznaje se po obaveznom kontejneru.
  if (containsAscii(head, 'META-INF/container.xml', head.length)) return 'epub';
  // Kraći oblici — kad je centralni direktorij izvan prozora koji smo pročitali.
  if (containsAscii(head, 'word/', head.length)) return 'docx';
  if (containsAscii(head, 'xl/', head.length)) return 'xlsx';
  if (containsAscii(head, 'ppt/', head.length)) return 'pptx';
  return 'archive';
}

/** Heuristika za tekst: NUL bajt gotovo uvijek znači binarni sadržaj. */
function looksTextual(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 2048);
  if (end === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < end; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    // Kontrolni znakovi osim taba, LF, CR, ESC.
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  return suspicious / end < 0.05;
}

/** Detekcija samo po imenu — koristi se za stablo, gdje sadržaj još nije pročitan. */
export function detectByName(name: string): FormatDetection {
  const lower = name.toLowerCase();
  const known = KNOWN_NAMES[lower];
  if (known) {
    return known.language
      ? { format: known.format, via: 'extension', language: known.language }
      : { format: known.format, via: 'extension' };
  }

  const ext = extensionOf(lower);
  if (!ext) return { format: 'unknown', via: 'fallback' };

  if (MARKDOWN.has(ext)) return { format: 'markdown', via: 'extension', language: 'markdown' };
  if (ext === 'pdf') return { format: 'pdf', via: 'extension' };
  if (ext === 'epub') return { format: 'epub', via: 'extension' };
  if (ext === 'docx' || ext === 'doc') return { format: 'docx', via: 'extension' };
  if (ext === 'xlsx' || ext === 'xls') return { format: 'xlsx', via: 'extension' };
  if (ext === 'pptx' || ext === 'ppt') return { format: 'pptx', via: 'extension' };
  if (ext === 'odt' || ext === 'ods' || ext === 'odp') return { format: 'odf', via: 'extension' };
  if (IMAGES.has(ext)) return { format: 'image', via: 'extension' };
  if (ext === 'zip' || ext === '7z' || ext === 'tar' || ext === 'gz') {
    return { format: 'archive', via: 'extension' };
  }

  const language = CODE_LANGUAGES[ext];
  if (language) return { format: 'code', via: 'extension', language };
  if (PLAIN_TEXT.has(ext)) return { format: 'text', via: 'extension' };

  return { format: 'unknown', via: 'fallback' };
}

/**
 * Puna detekcija. `bytes` je početak datoteke — 64 KB je dovoljno za sve
 * potpise koje provjeravamo.
 */
export function detect(name: string, bytes: Uint8Array): FormatDetection {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { format: 'pdf', via: 'magic' }; // %PDF

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return { format: classifyZip(bytes), via: 'magic' };
  }

  if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) || // GIF8
    startsWith(bytes, [0x42, 0x4d]) || // BMP
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
  ) {
    return { format: 'image', via: 'magic' };
  }

  // Stari binarni Office (OLE2 compound file).
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const byName = detectByName(name);
    return byName.format === 'unknown' ? { format: 'binary', via: 'magic' } : { ...byName, via: 'magic' };
  }

  // Potpis ništa ne kaže → ime odlučuje, ali samo ako sadržaj izgleda tekstualno.
  const byName = detectByName(name);
  const textual = looksTextual(bytes);

  if (!textual) {
    return byName.format === 'unknown' || byName.format === 'text' || byName.format === 'code'
      ? { format: 'binary', via: 'magic' }
      : byName;
  }

  if (byName.format === 'unknown') return { format: 'text', via: 'fallback' };
  return byName;
}
