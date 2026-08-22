/**
 * Format detection.
 *
 * The content decides, not the file name. The extension is used only when the
 * signature says nothing — otherwise a renamed `.txt` PDF would open the wrong
 * editor.
 *
 * In phase 1 this logic moves into `crates/ul-formats` (Rust) so web and desktop
 * share the same code; the `FormatId` values must stay identical.
 */

import type { FormatDetection, FormatId } from '@uleditor/plugin-sdk';

/** Extension → the language for syntax highlighting. */
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
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  /* PowerShell is not a shell script — it was coloured as one, which got the
     comments right and everything else wrong. */
  ps1: 'powershell',
  psm1: 'powershell',
  /* The format half the build steps on Windows are written in. See
     packages/editor-code/src/batch.ts — nothing anywhere has a mode for it. */
  bat: 'batch',
  cmd: 'batch',
  ini: 'properties',
  cfg: 'properties',
  conf: 'properties',
  properties: 'properties',
  env: 'properties',
  diff: 'diff',
  patch: 'diff',
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

/* `ini`, `cfg`, `conf` and `env` used to be here. They are configuration with a
   shape — sections, keys, comments — and reading one is easier when that shape
   is visible, so they went to the `properties` mode above. */
const PLAIN_TEXT = new Set(['txt', 'log', 'csv', 'tsv', 'gitignore']);
const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

/**
 * Vector drawings. `svg` sits here rather than among the code languages: it is
 * markup, but somebody opening one wants to see the picture, and the viewer puts
 * the source one button away.
 *
 * `ai` is in the list and almost never reaches it — Illustrator has written a
 * complete PDF inside its files by default since version 9, and the `%PDF`
 * signature is read before any extension, so those go to the PDF viewer.
 */
const VECTORS = new Set(['svg', 'svgz', 'ai', 'eps', 'ps', 'cdr']);

/** Interchange formats for 3D, not the native files of any one modeller. */
const MODELS = new Set(['stl', 'obj', 'ply', 'gltf', 'glb', '3mf']);

/** Extensionless files that are text nonetheless. */
const KNOWN_NAMES: Record<string, { format: FormatId; language?: string }> = {
  dockerfile: { format: 'code', language: 'dockerfile' },
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

/** Looks for an ASCII string in the first `limit` bytes. For telling ZIP containers apart. */
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
 * DOCX, XLSX, PPTX and ODF are all ZIP archives. They differ by their internal
 * paths, which appear as plain ASCII in ZIP headers — enough for detection
 * without unpacking.
 */
function classifyZip(bytes: Uint8Array): FormatId {
  // EPUB and ODF keep `mimetype` as the first, uncompressed entry — the
  // signature sits right behind the ZIP header, so the first 128 bytes suffice.
  if (containsAscii(bytes, 'mimetypeapplication/epub+zip', 128)) return 'epub';
  if (containsAscii(bytes, 'mimetypeapplication/vnd.oasis.opendocument', 128)) return 'odf';

  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  if (containsAscii(head, 'word/document.xml', head.length)) return 'docx';
  if (containsAscii(head, 'xl/workbook.xml', head.length)) return 'xlsx';
  if (containsAscii(head, 'ppt/presentation.xml', head.length)) return 'pptx';
  // EPUB without the uncompressed `mimetype` entry (off-spec, but it exists in
  // the wild) — recognised by its mandatory container.
  if (containsAscii(head, 'META-INF/container.xml', head.length)) return 'epub';
  // Shorter forms — for when the central directory lies outside the window we read.
  if (containsAscii(head, 'word/', head.length)) return 'docx';
  if (containsAscii(head, 'xl/', head.length)) return 'xlsx';
  if (containsAscii(head, 'ppt/', head.length)) return 'pptx';
  return 'archive';
}

/** The text heuristic: a NUL byte almost always means binary content. */
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

/** Detection by name only — used for the tree, where the content has not been read yet. */
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
  if (VECTORS.has(ext)) return { format: 'vector', via: 'extension' };
  if (MODELS.has(ext)) return { format: 'model', via: 'extension' };
  if (ext === 'zip' || ext === '7z' || ext === 'tar' || ext === 'gz') {
    return { format: 'archive', via: 'extension' };
  }

  const language = CODE_LANGUAGES[ext];
  if (language) return { format: 'code', via: 'extension', language };
  if (PLAIN_TEXT.has(ext)) return { format: 'text', via: 'extension' };

  return { format: 'unknown', via: 'fallback' };
}

/**
 * Full detection. `bytes` is the start of the file — 64 KB is enough for every
 * signature we check.
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

  // Old binary Office (an OLE2 compound file).
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const byName = detectByName(name);
    return byName.format === 'unknown' ? { format: 'binary', via: 'magic' } : { ...byName, via: 'magic' };
  }

  // The signature says nothing → the name decides, but only if the content looks textual.
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
