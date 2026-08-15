/**
 * Izvoz običnog teksta u formate koje netko drugi može otvoriti.
 *
 * Postoji zbog jednog konkretnog toka: tekst koji je nastao unutar programa
 * (OCR sa slike, kasnije konverzije) nema datoteku na disku, pa se pri
 * spremanju mora **odabrati u što** ide. Odabir bez ovoga bi bio samo izbor
 * ekstenzije, što je laž.
 *
 * Namjerno bez ovisnosti o shellu — poziva se lijeno, pri spremanju, pa
 * pdf-lib ne ulazi u početni bundle.
 */

import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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

/** XML tekst mora biti escapean; `&` prije svega ostalog. */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Najmanji valjan `.docx`: kontejner, jedna veza i tijelo s odlomcima.
 *
 * Word ne traži stilove ni numeriranje da bi otvorio dokument — traži točno
 * `[Content_Types].xml`, `_rels/.rels` i dio na koji ta veza pokazuje.
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

const PAGE = { width: 595.28, height: 841.89 }; // A4 u točkama
const MARGIN = 56;
const FONT_SIZE = 11;
const LEADING = 15;

/**
 * Prelamanje po širini stupca. Riječ dulja od retka se lomi po znakovima —
 * inače bi duga putanja ili URL izašli izvan margine.
 *
 * Izvezeno jer je ovo jedina netrivijalna logika u izvozu; iz gotovog PDF-a
 * se prijelom ne da pročitati natrag (sadržaj je komprimiran stream), pa se
 * provjerava ovdje.
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
 * Tekst → PDF. Standardni Helvetica ima WinAnsi kodiranje, koje pokriva
 * hrvatske dijakritike osim `č`, `ć`, `ž`, `š`, `đ` — pa se znakovi koje font
 * ne poznaje zamjenjuju bez dijakritika umjesto da spremanje pukne.
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

/** Znakovi koje WinAnsi ne poznaje → najbliži par bez dijakritike. */
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
  /** Što izvoz nije mogao zadržati — shell to pokazuje prije spremanja. */
  lost: string[];
}

export async function exportText(
  text: string,
  format: TextFormat,
  title: string,
): Promise<ExportResult> {
  switch (format) {
    case 'txt':
    case 'md':
      return { bytes: strToU8(text), lost: [] };

    case 'docx':
      return { bytes: toDocx(text), lost: [] };

    case 'pdf': {
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
