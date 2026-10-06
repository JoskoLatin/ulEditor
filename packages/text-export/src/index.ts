/**
 * Exporting plain text into formats somebody else can open.
 *
 * It exists for one concrete flow: text produced inside the program (OCR from an
 * image, conversions later on) has no file on disk, so saving it means
 * **choosing what it becomes**. Without this, that choice would be a choice of
 * extension only, which is a lie.
 *
 * Deliberately free of any dependency on the shell — it is called lazily, on
 * save, so pdf-lib never enters the initial bundle.
 */

import { zipSync, strToU8 } from 'fflate';
import * as fontkitModule from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/*
 * `@pdf-lib/fontkit` has an ESM build with a default export and a UMD build
 * with named ones; Vite takes one and Node the other — as in editor-pdf.
 */
interface Fontkit {
  create(bytes: Uint8Array): { hasGlyphForCodePoint(codePoint: number): boolean };
}
const fontkit: Fontkit =
  (fontkitModule as unknown as { default?: Fontkit }).default ??
  (fontkitModule as unknown as Fontkit);

export type TextFormat = 'txt' | 'md' | 'docx' | 'pdf';

export interface TextFormatDescriptor {
  id: TextFormat;
  extension: string;
  /** Engleski izvornik; shell ga prevodi. */
  label: string;
}

export const TEXT_FORMATS: TextFormatDescriptor[] = [
  { id: 'txt', extension: 'txt', label: 'Plain text' },
  { id: 'md', extension: 'md', label: 'Markdown' },
  { id: 'docx', extension: 'docx', label: 'Word document' },
  { id: 'pdf', extension: 'pdf', label: 'PDF' },
];

export function formatOf(id: string): TextFormatDescriptor {
  return TEXT_FORMATS.find((f) => f.id === id) ?? TEXT_FORMATS[0]!;
}

/* ── DOCX ────────────────────────────────────────────────────────────── */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** XML text must be escaped; `&` before everything else. */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The smallest valid `.docx`: a container, one relationship and a body of
 * paragraphs.
 *
 * Word does not need styles or numbering to open a document — it needs exactly
 * `[Content_Types].xml`, `_rels/.rels` and the part that relationship points at.
 */
export function toDocx(text: string): Uint8Array {
  const paragraphs = text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return '<w:p/>';
    return `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`;
  });

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.join('')}<w:sectPr/></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
    `Target="word/document.xml"/></Relationships>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(document),
  });
}

/* ── PDF ─────────────────────────────────────────────────────────────── */

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 56;
const FONT_SIZE = 11;
const LEADING = 15;

/**
 * Wrapping to the column width. A word longer than a line is broken by
 * character — otherwise a long path or URL would run past the margin.
 *
 * Exported because this is the only non-trivial logic in the export; the
 * wrapping cannot be read back out of a finished PDF (the content is a
 * compressed stream), so it is verified here.
 */
export function wrapLines(
  line: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  if (!line) return [''];

  const out: string[] = [];
  let current = '';

  for (const word of line.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= width) {
      current = candidate;
      continue;
    }

    if (current) out.push(current);

    if (measure(word) <= width) {
      current = word;
      continue;
    }

    let piece = '';
    for (const char of word) {
      if (measure(piece + char) > width) {
        out.push(piece);
        piece = char;
      } else {
        piece += char;
      }
    }
    current = piece;
  }

  out.push(current);
  return out;
}

/**
 * Text → PDF. The standard Helvetica uses WinAnsi encoding, which covers the
 * Croatian diacritics except `č`, `ć`, `ž`, `š`, `đ` — so characters the font
 * does not know are substituted without their diacritics rather than letting the
 * save fail.
 */
export async function toPdf(text: string, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const measure = (value: string) => font.widthOfTextAtSize(value, FONT_SIZE);
  const usable = PAGE.width - MARGIN * 2;

  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    lines.push(...wrapLines(sanitizeForWinAnsi(raw), usable, measure));
  }

  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  for (const line of lines) {
    if (y < MARGIN) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
    }
    if (line) {
      page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= LEADING;
  }

  return doc.save();
}

/**
 * Text → PDF in a TrueType font of the caller's — Liberation Sans in the
 * application, the face pdf.js carries and the PDF editor writes text in. It
 * has č ć ž š đ, so nothing is folded; a character it has not is written as
 * `?` and counted, so the loss is reported rather than drawn as a blank.
 */
async function toPdfInFont(
  text: string,
  title: string,
  fontBytes: Uint8Array,
): Promise<{ bytes: Uint8Array; missing: boolean }> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.registerFontkit(fontkit as never);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const faces = fontkit.create(fontBytes);

  let missing = false;
  const drawable = (line: string) =>
    [...line]
      .map((char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint < 0x20 && char !== '\t') return '';
        if (faces.hasGlyphForCodePoint(codePoint)) return char;
        missing = true;
        return '?';
      })
      .join('');

  const measure = (value: string) => font.widthOfTextAtSize(value, FONT_SIZE);
  const usable = PAGE.width - MARGIN * 2;
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    lines.push(...wrapLines(drawable(raw), usable, measure));
  }

  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  for (const line of lines) {
    if (y < MARGIN) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
    }
    if (line) {
      page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= LEADING;
  }

  return { bytes: await doc.save(), missing };
}

/** Characters WinAnsi does not know → the closest counterpart without a diacritic. */
const FOLD: Record<string, string> = {
  č: 'c', ć: 'c', ž: 'z', š: 's', đ: 'd',
  Č: 'C', Ć: 'C', Ž: 'Z', Š: 'S', Đ: 'D',
  '–': '-', '—': '-', '„': '"', '”': '"', '“': '"', '…': '...',
};

function sanitizeForWinAnsi(text: string): string {
  return text.replace(/[^\x00-\xFF]/g, (char) => FOLD[char] ?? '?');
}

/* ── ulaz ────────────────────────────────────────────────────────────── */

export interface ExportResult {
  bytes: Uint8Array;
  /** What the export could not preserve — the shell shows this before saving. */
  lost: string[];
}

export interface ExportOptions {
  /**
   * A TrueType font for a PDF — the application passes Liberation Sans, which
   * has the Croatian letters. Without one the PDF is written in the standard
   * Helvetica, which has not, and č ć ž š đ are written without their marks
   * (and the loss reported).
   */
  pdfFont?: Uint8Array;
}

export async function exportText(
  text: string,
  format: TextFormat,
  title: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  switch (format) {
    case 'txt':
    case 'md':
      return { bytes: strToU8(text), lost: [] };

    case 'docx':
      return { bytes: toDocx(text), lost: [] };

    case 'pdf': {
      if (options.pdfFont) {
        const { bytes, missing } = await toPdfInFont(text, title, options.pdfFont);
        return {
          bytes,
          lost: missing ? ['Some characters are not in the PDF font and were written as "?".'] : [],
        };
      }
      const bytes = await toPdf(text, title);
      const folded = /[^\x00-\xFF]/.test(text);
      return {
        bytes,
        lost: folded
          ? ['The built-in PDF font has no Croatian diacritics; č ć ž š đ are written without them.']
          : [],
      };
    }
  }
}
