/**
 * The test documents the checks share.
 *
 * The PDF is assembled by hand rather than sitting as a binary asset in the
 * repository — that way what exactly is being tested is visible, and easy to
 * change.
 */

import { zipSync, strToU8 } from 'fflate';

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WORKSHEET_REL = `${REL_NS}/worksheet`;

const CONTENT_TYPES =
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="xml" ContentType="application/xml"/></Types>`;

const EMPTY_RELS = `<?xml version="1.0"?><Relationships xmlns="${PKG_REL_NS}"/>`;

export const TS_SOURCE = `import { createShell } from './host';

/** A check of syntax colouring and line wrapping. */
export function main(): number {
  const shell = createShell();
  const formats = ['pdf', 'docx', 'xlsx'] as const;
  return formats.length + (shell ? 1 : 0);
}
`;

/**
 * A batch script with one of every shape the mode has a rule for: the two kinds
 * of comment, a label, all three spellings of a variable, a device name, a
 * string, a comparison and a line continuation.
 */
export const BAT_SOURCE = `@echo off
:: The installer, checked for colour.
rem Both kinds of comment above.
setlocal enabledelayedexpansion
set "TARGET=%~dp0build"
if not exist "%TARGET%" (
  echo %TARGET% is missing 1>nul
  goto :fail
)
for %%f in (*.txt) do (
  if !ERRORLEVEL! neq 0 echo %%f
)
copy /y "%TARGET%pp.exe" ^
  "%TARGET%pp.bak"
exit /b 0
:fail
exit /b 1
`;

export const MD_SOURCE = `# ulEditor

A check of the **live preview**.

| Format | Phase |
| --- | --- |
| PDF | 1 |
| XLSX | 2 |

> A document is never quietly saved broken.

\`\`\`ts
const x: number = 42;
\`\`\`
`;

/**
 * A minimal valid PDF with a correct xref table.
 * @param {string} text the text printed on the page
 * @returns {string}
 */
export function makePdf(text = 'ulEditor PDF') {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = `BT /F1 22 Tf 30 110 Td (${text}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/**
 * A PDF whose font carries a `/ToUnicode` map covering only what the page draws.
 *
 * This is what a real document looks like. A word processor embeds a subset of
 * the font — the glyphs actually used — and writes the map that says which code
 * stands for which letter. Retyping a line reads that map backwards, so this
 * fixture is where both halves of that can be seen: the letters the page already
 * has can be written back, and the ones it never had cannot.
 *
 * @param {string} text the line printed on the page
 * @param {{ embedded?: boolean, trailer?: string, noMap?: boolean, font?: string }} [opts]
 *   `embedded` attaches a `/FontFile2`, which is what tells the reader the
 *   glyphs travel with the document; `noMap` leaves out the `/ToUnicode`, which
 *   is the case where a code says nothing about the letter; `trailer` adds a
 *   second `Tj` in the same text object, positioned by nothing but the pen — so
 *   it moves if a rewrite fails to put the pen back.
 * @returns {string}
 */
/**
 * A page whose font draws two letters with one glyph.
 *
 * Code `0x02` is `fi`, twice as wide as anything else, exactly as TeX, InDesign
 * and Word with OpenType on write it. The page reads `file`, in four letters
 * drawn by three glyphs — so an edit to the `f` cannot keep the `i` unless it
 * writes both back.
 */
export function makeLigaturePdf() {
  const hex = (code, digits) => code.toString(16).toUpperCase().padStart(digits, '0');

  /* The whole printable range, so an edit can bring in a letter the page does
     not itself draw — the point here is the ligature, not the inventory. */
  const printable = Array.from({ length: 95 }, (_, i) => 32 + i);
  const entries = [
    // The ligature itself: one code, the two letters it stands for.
    '<02> <00660069>',
    ...printable.map((code) => `<${hex(code, 2)}> <${hex(code, 4)}>`),
  ];
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /A-B-0 def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${entries.length} beginbfchar`,
    ...entries,
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');

  /* From code 1, so the ligature at 2 has a width of its own: 1000 for it, 500
     for every ordinary letter. */
  const widths = Array.from({ length: 126 }, (_, i) => (i + 1 === 2 ? 1000 : 500)).join(' ');

  // <02> is the fi, then `l` and `e`. The page reads "file".
  const stream = 'BT /F1 10 Tf 30 110 Td <026C65> Tj ET';

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+CMR10/FirstChar 1/LastChar 126' +
      `/Widths[${widths}]/FontDescriptor 6 0 R/ToUnicode 7 0 R>>`,
    '<</Type/FontDescriptor/FontName/ABCDEF+CMR10/Flags 32/ItalicAngle 0/Ascent 750' +
      '/Descent -250/CapHeight 700/StemV 80/FontBBox[0 -250 1000 750]/FontFile2 8 0 R>>',
    `<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream`,
    '<</Length 4/Length1 4>>\nstream\n0000\nendstream',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

export function makeToUnicodePdf(text = 'Name and surname', opts = {}) {
  const codes = [...new Set([...text, ...(opts.trailer ?? '')])]
    .map((ch) => ch.codePointAt(0))
    .filter((code) => code >= 32 && code < 127)
    .sort((a, b) => a - b);

  const hex = (code, digits) => code.toString(16).toUpperCase().padStart(digits, '0');
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /A-B-0 def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${codes.length} beginbfchar`,
    ...codes.map((code) => `<${hex(code, 2)}> <${hex(code, 4)}>`),
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');

  // One width for every code in the range: uniform, so the arithmetic in a
  // check can be done by hand.
  const widths = Array.from({ length: 95 }, () => 500).join(' ');

  const stream =
    `BT /F1 12 Tf 30 110 Td (${text}) Tj` + (opts.trailer ? ` (${opts.trailer}) Tj` : '') + ' ET';

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    `<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+${opts.font ?? 'Inter'}-Regular/FirstChar 32/LastChar 126` +
      `/Widths[${widths}]/FontDescriptor 6 0 R${opts.noMap ? '' : '/ToUnicode 7 0 R'}>>`,
    `<</Type/FontDescriptor/FontName/ABCDEF+${opts.font ?? 'Inter'}-Regular/Flags 32/ItalicAngle 0/Ascent 750` +
      '/Descent -250/CapHeight 700/StemV 80/FontBBox[0 -250 1000 750]' +
      (opts.embedded ? '/FontFile2 8 0 R' : '') +
      '>>',
    `<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream`,
  ];

  /* Not a font anybody could draw with — nothing here renders the page. What it
     stands for is the fact of the glyphs travelling with the document, which is
     what decides whether a code may be trusted without a map. */
  if (opts.embedded) objects.push('<</Length 4/Length1 4>>\nstream\n0000\nendstream');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/**
 * A PDF that already carries a text annotation, with the appearance stream a
 * reader draws it from.
 *
 * Needed because that is a document with **two** drawings of the same words: the
 * reader paints the appearance stream onto the page, and the editor draws its own
 * editable copy over it. While they agree it looks like one thing — move the box
 * and both become visible at once. Nothing else in these fixtures produces that.
 *
 * @param {string} note the text of the annotation
 * @param {string} body the text drawn on the page itself
 * @returns {string}
 */
export function makeAnnotatedPdf(note = 'Josko Latin', body = 'Name and surname') {
  const appearance = `/Tx BMC q BT 0 0 0 rg /Helv 14 Tf 2 5 Td (${note}) Tj ET Q EMC`;
  const stream = `BT /F1 22 Tf 30 150 Td (${body}) Tj ET`;
  // Wide enough for the text at 14 pt; the exact width does not matter, only
  // that the reader and the editor agree on the rectangle.
  const width = Math.round(note.length * 8 + 8);

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R' +
      '/Resources<</Font<</F1 5 0 R>>>>/Annots[6 0 R]>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Type/Annot/Subtype/FreeText/Rect[40 60 ${40 + width} 82]/F 4` +
      `/Contents (${note})/DA (0 0 0 rg /Helv 14 Tf)/AP<</N 7 0 R>>>>`,
    `<</Type/XObject/Subtype/Form/BBox[0 0 ${width} 22]` +
      `/Resources<</Font<</Helv 5 0 R>>>>/Length ${appearance.length}>>\n` +
      `stream\n${appearance}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body_, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body_}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/**
 * A PDF whose visible line is several separately placed instructions, with a
 * label far away on the same baseline.
 *
 * This is what an invoice looks like inside. `E93.89` is the sign in one
 * instruction and the figure in another, each at its own coordinates, and the
 * label of the row sits in a different column of the same line. A tool that
 * takes one instruction for the line offers a fragment for editing; one that
 * takes the whole baseline swallows the label as well. Both are wrong, and this
 * fixture is where the difference shows.
 *
 * Every glyph is 500 wide, so at 12 pt each is 6 pt and the arithmetic can be
 * done by hand.
 *
 * @returns {string}
 */
export function makeSplitLinePdf() {
  const label = 'Total';
  const sign = 'E';
  const figure = '93.89';

  // The sign at 200, the figure immediately after it, the label in its own
  // column 140 pt away — far enough that no typography joins the two.
  const stream = [
    `BT /F1 12 Tf 1 0 0 1 30 110 Tm (${label}) Tj ET`,
    `BT /F1 12 Tf 1 0 0 1 200 110 Tm (${sign}) Tj ET`,
    `BT /F1 12 Tf 1 0 0 1 206 110 Tm (${figure}) Tj ET`,
  ].join('\n');

  const codes = [...new Set([...label, ...sign, ...figure])]
    .map((ch) => ch.codePointAt(0))
    .sort((a, b) => a - b);
  const hex = (code, digits) => code.toString(16).toUpperCase().padStart(digits, '0');
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /A-B-0 def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${codes.length} beginbfchar`,
    ...codes.map((code) => `<${hex(code, 2)}> <${hex(code, 4)}>`),
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const widths = Array.from({ length: 95 }, () => 500).join(' ');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Inter-Regular/FirstChar 32/LastChar 126' +
      `/Widths[${widths}]/FontDescriptor 6 0 R/ToUnicode 7 0 R>>`,
    '<</Type/FontDescriptor/FontName/ABCDEF+Inter-Regular/Flags 32/ItalicAngle 0/Ascent 750' +
      '/Descent -250/CapHeight 700/StemV 80/FontBBox[0 -250 1000 750]/FontFile2 8 0 R>>',
    `<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream`,
    '<</Length 4/Length1 4>>\nstream\n0000\nendstream',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/**
 * A PDF that writes its word spaces as gaps rather than as letters.
 *
 * Everything TeX produces looks like this, and so do plenty of other tools: the
 * words sit in one `TJ` array with a number between them, and the font never
 * draws a space at all. A line read without allowing for that says
 * `TestDiskDocumentation`, and a space typed into it has nowhere to come from.
 *
 * The gap here is 250 thousandths — a quarter of an em, an ordinary word space.
 * Every glyph is 500 wide, so at 12 pt each is 6 pt and a space is 3 pt.
 *
 * @returns {string}
 */
export function makeGapSpacedPdf() {
  const stream = 'BT /F1 12 Tf 30 110 Td [(Total)-250(due)-250(now)]TJ ET';

  const codes = [...new Set('Totaldueno')]
    .map((ch) => ch.codePointAt(0))
    .sort((a, b) => a - b);
  const hex = (code, digits) => code.toString(16).toUpperCase().padStart(digits, '0');
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /A-B-0 def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${codes.length} beginbfchar`,
    ...codes.map((code) => `<${hex(code, 2)}> <${hex(code, 4)}>`),
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const widths = Array.from({ length: 95 }, () => 500).join(' ');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+TeXGyre/FirstChar 32/LastChar 126' +
      `/Widths[${widths}]/FontDescriptor 6 0 R/ToUnicode 7 0 R>>`,
    '<</Type/FontDescriptor/FontName/ABCDEF+TeXGyre/Flags 32/ItalicAngle 0/Ascent 750' +
      '/Descent -250/CapHeight 700/StemV 80/FontBBox[0 -250 1000 750]/FontFile2 8 0 R>>',
    `<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream`,
    '<</Length 4/Length1 4>>\nstream\n0000\nendstream',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/**
 * A multi-page PDF where each page carries its own label, so after a reorder it
 * can be verified that it really landed in the right place.
 * @param {number} count the number of pages
 */
export function makeMultiPagePdf(count = 3) {
  const objects = [];
  // 1 = the catalog, 2 = the page tree, then two objects per page.
  const pageRefs = [];
  for (let i = 0; i < count; i++) pageRefs.push(3 + i * 2);

  objects.push('<</Type/Catalog/Pages 2 0 R>>');
  objects.push(`<</Type/Pages/Kids[${pageRefs.map((r) => `${r} 0 R`).join(' ')}]/Count ${count}>>`);

  const fontRef = 3 + count * 2;
  for (let i = 0; i < count; i++) {
    const contentRef = pageRefs[i] + 1;
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentRef} 0 R` +
        `/Resources<</Font<</F1 ${fontRef} 0 R>>>>>>`,
    );
    const stream = `BT /F1 20 Tf 30 110 Td (PAGE ${i + 1}) Tj ET`;
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  }
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

/** A ZIP that looks like a .docx but has no content — for checking the error message. */
export function makeFakeDocx() {
  /*
   * A **real** ZIP local-file header over bytes that are not an archive: the
   * four signature bytes, a plausible header, the part name that says "Word",
   * and then the file stops in the middle of it.
   *
   * The signature has to be genuine. This fixture used to be the plain string
   * `PK…word/document.xml`, which detection quite rightly reads as a text file
   * that has been misnamed — so it opened in the text editor, showed its own
   * contents, and never reached the Word reader whose message this checks. A
   * document that is damaged and one that was never a document are two
   * different things, and only the first belongs here.
   */
  const header = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00];
  const name = [...'word/document.xml'].map((ch) => ch.charCodeAt(0));
  return Uint8Array.from([...header, ...new Array(16).fill(0), ...name, 0xff, 0xfe, 0xfd]);
}

/* ── ZIP kontejneri ──────────────────────────────────────────────────── */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * Like everything else here, the EPUB is assembled in code — that way what
 * exactly is being checked is visible and there is no binary asset in the
 * repository.
 *
 * `mimetype` has to come first and uncompressed; that is how detection recognises
 * it without unpacking.
 *
 * @param {{ chapters?: number, title?: string }} [opts]
 */
export function makeEpub(opts = {}) {
  const count = opts.chapters ?? 3;
  const title = opts.title ?? 'A test book';

  const chapterFile = (n) => `chapter-${n}.xhtml`;
  const chapterBody = (n) =>
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body>\n` +
    `<h1 id="p${n}">Chapter ${n}</h1>\n` +
    // A chapter has to be longer than one two-column screen, otherwise pagination
    // has nothing to break and the page-turn check proves nothing.
    Array.from(
      { length: 40 },
      (_, i) =>
        `<p>Paragraph ${i + 1} in chapter ${n}. There is enough text here for the column ` +
        `break to have something to break, so turning pages can really be checked. ` +
        `Diacritics: čćšžđ.</p>`,
    ).join('\n') +
    `\n<p>The end of chapter ${n} mentions uniquechapter${n} for the sake of search.</p>\n` +
    `</body></html>`;

  const manifest = Array.from(
    { length: count },
    (_, i) => `<item id="ch${i + 1}" href="${chapterFile(i + 1)}" media-type="application/xhtml+xml"/>`,
  ).join('\n    ');
  const spine = Array.from({ length: count }, (_, i) => `<itemref idref="ch${i + 1}"/>`).join('\n    ');

  const opf =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">\n` +
    `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `    <dc:identifier id="id">ul-test-1</dc:identifier>\n` +
    `    <dc:title>${title}</dc:title>\n` +
    `    <dc:creator>Josko</dc:creator>\n` +
    `    <dc:language>hr</dc:language>\n` +
    `  </metadata>\n` +
    `  <manifest>\n` +
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n` +
    `    ${manifest}\n` +
    `  </manifest>\n` +
    `  <spine>\n    ${spine}\n  </spine>\n</package>`;

  const nav =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>\n` +
    `<nav epub:type="toc"><ol>\n` +
    Array.from(
      { length: count },
      (_, i) => `<li><a href="${chapterFile(i + 1)}#p${i + 1}">Chapter ${i + 1}</a></li>`,
    ).join('\n') +
    `\n</ol></nav></body></html>`;

  const container =
    `<?xml version="1.0"?>\n` +
    `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" ` +
    `media-type="application/oebps-package+xml"/></rootfiles></container>`;

  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
  };
  for (let i = 1; i <= count; i++) files[`OEBPS/${chapterFile(i)}`] = strToU8(chapterBody(i));

  return zipSync(files);
}

/** A DOCX with headings, formatting, a list and a table. */
export function makeDocx() {
  const paragraph = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

  const bullet = (text) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
    `<w:r><w:t>${text}</w:t></w:r></w:p>`;

  const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

  const document =
    `<?xml version="1.0" encoding="UTF-8"?>\n<w:document ${W_NS}><w:body>\n` +
    paragraph('Fidelity report', 'Heading1') +
    paragraph('An opening paragraph with diacritics: čćšžđ.') +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>and italic</w:t></w:r></w:p>` +
    paragraph('List of requirements', 'Heading2') +
    bullet('the first requirement') +
    bullet('the second requirement') +
    paragraph('Table', 'Heading2') +
    `<w:tbl>${row('Format', 'Phase')}${row('PDF', '1')}${row('XLSX', '2')}</w:tbl>` +
    paragraph('The conclusion mentions uniqueword for the sake of search.') +
    `<w:sectPr/></w:body></w:document>`;

  const numbering =
    `<?xml version="1.0" encoding="UTF-8"?>\n<w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'word/document.xml': strToU8(document),
    'word/numbering.xml': strToU8(numbering),
    'word/_rels/document.xml.rels': strToU8(EMPTY_RELS),
  });
}

/** An XLSX with two sheets, shared strings, a formula, a date and merged cells. */
export function makeXlsx() {
  const strings = ['Month', 'Amount', 'January', 'February', 'Total', 'uniqueexcel'];

  const workbook =
    `<?xml version="1.0"?>\n<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>` +
    `<sheet name="Sales" sheetId="1" r:id="rId1"/>` +
    `<sheet name="Notes" sheetId="2" r:id="rId2"/>` +
    `</sheets></workbook>`;

  const rels =
    `<?xml version="1.0"?>\n<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${WORKSHEET_REL}" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${WORKSHEET_REL}" Target="worksheets/sheet2.xml"/>` +
    `</Relationships>`;

  const sharedStrings =
    `<?xml version="1.0"?>\n<sst xmlns="${SHEET_NS}" count="${strings.length}" ` +
    `uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;

  // s="1" carries the built-in date format (14), s="2" an amount with two decimals.
  const styles =
    `<?xml version="1.0"?>\n<styleSheet xmlns="${SHEET_NS}">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>` +
    `<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>` +
    `</styleSheet>`;

  const sheet1 =
    `<?xml version="1.0"?>\n<worksheet xmlns="${SHEET_NS}"><dimension ref="A1:C5"/>` +
    `<cols><col min="1" max="1" width="18"/></cols><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
    `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>1234.5</v></c>` +
    `<c r="C2" s="1"><v>45000</v></c></row>` +
    `<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="2"><v>987.25</v></c>` +
    `<c r="C3" s="1"><v>45031</v></c></row>` +
    `<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" s="2"><f>SUM(B2:B3)</f><v>2221.75</v></c></row>` +
    `<row r="5"><c r="A5" t="b"><v>1</v></c></row>` +
    `</sheetData><mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells></worksheet>`;

  const sheet2 =
    `<?xml version="1.0"?>\n<worksheet xmlns="${SHEET_NS}"><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    'xl/styles.xml': strToU8(styles),
    'xl/worksheets/sheet1.xml': strToU8(sheet1),
    'xl/worksheets/sheet2.xml': strToU8(sheet2),
  });
}

/**
 * An old binary Excel file — `.xls`, Excel 97–2003 — assembled by hand.
 *
 * Two layers, both spelled out: an OLE2 compound file whose FAT, directory and
 * `Workbook` stream are written sector by sector, and BIFF8 records inside the
 * stream. Hand-built for the same reason the PDFs above are: what is being
 * tested stays visible, and the trickiest case — a shared string cut in half
 * by a CONTINUE record, resuming under a different flags byte — can be forced
 * on demand with `opts.splitSst`, which no real writer produces small.
 *
 * @param {{ splitSst?: boolean, biff5?: boolean }} [opts]
 */
export function makeXls(opts = {}) {
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const f64 = (n) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, n, true);
    return [...new Uint8Array(view.buffer)];
  };
  const wide = (text) => [...text].flatMap((ch) => u16(ch.codePointAt(0)));
  const narrow = (text) => [...text].map((ch) => ch.codePointAt(0));
  const rec = (id, payload) => [...u16(id), ...u16(payload.length), ...payload];

  // One compressed string, one wide one (a *wide* letter has no single-byte form).
  const sstString = (text) =>
    /[^ -ÿ]/.test(text)
      ? [...u16(text.length), 0x01, ...wide(text)]
      : [...u16(text.length), 0x00, ...narrow(text)];

  const strings = ['Mjesec', 'Iznos', 'Siječanj', 'uniquexls'];
  const xf = (numfmt) => [...u16(0), ...u16(numfmt), ...u16(0), ...new Array(14).fill(0)];

  /* The globals substream. The BOUNDSHEET's sheet offset is patched afterwards,
     once the length of the globals is known. */
  const sheetNameBytes = narrow('List1');
  const globals = [];
  globals.push(...rec(0x0809, [...u16(opts.biff5 ? 0x0500 : 0x0600), ...u16(0x0005), ...new Array(12).fill(0)]));
  globals.push(...rec(0x0022, u16(0)));
  globals.push(...rec(0x00e0, xf(0)));
  globals.push(...rec(0x00e0, xf(14)));
  globals.push(...rec(0x00e0, xf(4)));

  if (opts.splitSst) {
    /* The third string cut after four characters; the CONTINUE resumes with its
       own flags byte. The other strings ride along whole. */
    const head = strings.slice(0, 2).flatMap(sstString);
    const cut = [...u16(8), 0x01, ...wide('Sije')];
    globals.push(...rec(0x00fc, [...u32(4), ...u32(4), ...head, ...cut]));
    globals.push(...rec(0x003c, [0x01, ...wide('čanj'), ...sstString('uniquexls')]));
  } else {
    globals.push(...rec(0x00fc, [...u32(4), ...u32(4), ...strings.flatMap(sstString)]));
  }

  const boundsheetLen = 4 + 4 + 2 + 1 + 1 + sheetNameBytes.length;
  const sheetOffset = globals.length + boundsheetLen + 4; // + the EOF record
  globals.push(...rec(0x0085, [...u32(sheetOffset), ...u16(0), sheetNameBytes.length, 0x00, ...sheetNameBytes]));
  globals.push(...rec(0x000a, []));

  /* The worksheet: two labels, a formatted amount, a date as RK, a merge. */
  const cell = (row, col, ixfe) => [...u16(row), ...u16(col), ...u16(ixfe)];
  const sheet = [];
  sheet.push(...rec(0x0809, [...u16(0x0600), ...u16(0x0010), ...new Array(12).fill(0)]));
  sheet.push(...rec(0x00fd, [...cell(0, 0, 0), ...u32(0)]));
  sheet.push(...rec(0x00fd, [...cell(0, 1, 0), ...u32(1)]));
  sheet.push(...rec(0x00fd, [...cell(1, 0, 0), ...u32(2)]));
  sheet.push(...rec(0x00fd, [...cell(3, 0, 0), ...u32(3)]));
  sheet.push(...rec(0x0203, [...cell(1, 1, 2), ...f64(1234.5)]));
  // 15 June 2026 is serial 46188; an RK integer is the value shifted left twice.
  sheet.push(...rec(0x027e, [...cell(1, 2, 1), ...u32((46188 << 2) | 0x02)]));
  /* A formula and the number it last worked out. The old format keeps no
     readable formula text, only this cached result — which is exactly why a
     conversion has to say the formula will not survive it. */
  sheet.push(...rec(0x0006, [...cell(2, 1, 2), ...f64(2469), ...u16(0), ...u32(0), ...u16(0)]));
  sheet.push(...rec(0x00e5, [...u16(1), ...u16(2), ...u16(2), ...u16(0), ...u16(1)]));
  sheet.push(...rec(0x000a, []));

  /* The stream, padded past the 4096-byte mini-stream cutoff so it may legally
     live in ordinary sectors and the fixture needs no mini FAT at all. */
  const stream = new Uint8Array(4096);
  stream.set([...globals, ...sheet]);

  /* The compound file: sector 0 the FAT, sector 1 the directory, 2-9 the stream. */
  const sectorSize = 512;
  const out = new Uint8Array(sectorSize * 11);
  const view = new DataView(out.buffer);

  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true); // minor
  view.setUint16(26, 0x0003, true); // major — the 512-byte-sector version
  view.setUint16(28, 0xfffe, true); // byte order
  view.setUint16(30, 9, true); // 2^9 = 512
  view.setUint16(32, 6, true); // 2^6 = 64
  view.setUint32(44, 1, true); // one FAT sector
  view.setUint32(48, 1, true); // the directory starts at sector 1
  view.setUint32(56, 4096, true); // mini-stream cutoff
  view.setUint32(60, 0xfffffffe, true); // no mini FAT
  view.setUint32(68, 0xfffffffe, true); // no extra DIFAT
  view.setUint32(76, 0, true); // DIFAT[0] -> the FAT sector
  for (let i = 1; i < 109; i++) view.setUint32(76 + i * 4, 0xffffffff, true);

  const fatAt = sectorSize;
  view.setUint32(fatAt, 0xfffffffd, true); // sector 0: the FAT itself
  view.setUint32(fatAt + 4, 0xfffffffe, true); // sector 1: the directory, one sector
  for (let i = 2; i <= 9; i++) view.setUint32(fatAt + i * 4, i === 9 ? 0xfffffffe : i + 1, true);
  for (let i = 10; i < sectorSize / 4; i++) view.setUint32(fatAt + i * 4, 0xffffffff, true);

  const entry = (index, name, type, start, size) => {
    const at = sectorSize * 2 + index * 128;
    name.split('').forEach((ch, i) => view.setUint16(at + i * 2, ch.charCodeAt(0), true));
    view.setUint16(at + 64, (name.length + 1) * 2, true);
    view.setUint8(at + 66, type);
    view.setUint32(at + 68, 0xffffffff, true); // left sibling
    view.setUint32(at + 72, 0xffffffff, true); // right sibling
    view.setUint32(at + 76, type === 5 ? 1 : 0xffffffff, true); // the root's child
    view.setUint32(at + 116, start, true);
    view.setUint32(at + 120, size, true);
  };
  entry(0, 'Root Entry', 5, 0xfffffffe, 0);
  entry(1, 'Workbook', 2, 2, stream.length);

  out.set(stream, sectorSize * 3);
  return out;
}

/* ── OpenDocument ────────────────────────────────────────────────────── */

/**
 * The namespaces an OpenDocument part declares.
 *
 * Written out in full because the reader looks up elements by local name and
 * would happily read a file with the wrong namespaces on it — a fixture that
 * left them out would prove the reader works on something LibreOffice never
 * writes.
 */
const ODF_NS =
  `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
  `xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ` +
  `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
  `xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ` +
  `xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ` +
  `xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ` +
  `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
  `xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" ` +
  `xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ` +
  `xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"`;

const ODF_MANIFEST = (mime) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest ` +
  `xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
  `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>` +
  `</manifest:manifest>`;

/**
 * An `.ods` — an OpenDocument spreadsheet, written the way LibreOffice writes one.
 *
 * Everything awkward about the format is deliberately in here: a number format
 * described in elements instead of named in a code, a date as an ISO string
 * instead of a serial, a formula in the `of:` language with its bracketed
 * references, a merge written as a span plus a covered placeholder — and the
 * one that decides whether the reader is usable at all, the trailing repeat
 * counts. A real sheet says its last row repeats a million times, and a reader
 * that takes that literally allocates a million rows to show nothing.
 */
export function makeOds() {
  const styles =
    `<office:automatic-styles>` +
    `<style:style style:name="co1" style:family="table-column">` +
    `<style:table-column-properties style:column-width="4.5cm"/></style:style>` +
    `<number:number-style style:name="N108">` +
    `<number:number number:decimal-places="2" number:min-decimal-places="2" ` +
    `number:min-integer-digits="1" number:grouping="true"/></number:number-style>` +
    `<number:date-style style:name="N37">` +
    `<number:day number:style="long"/><number:text>.</number:text>` +
    `<number:month number:style="long"/><number:text>.</number:text>` +
    `<number:year number:style="long"/><number:text>.</number:text></number:date-style>` +
    `<style:style style:name="ce1" style:family="table-cell" style:data-style-name="N108"/>` +
    `<style:style style:name="ce2" style:family="table-cell" style:data-style-name="N37"/>` +
    `</office:automatic-styles>`;

  const text = (value) =>
    `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`;
  const number = (value, shown) =>
    `<table:table-cell table:style-name="ce1" office:value-type="float" office:value="${value}">` +
    `<text:p>${shown}</text:p></table:table-cell>`;

  /* The empty tail of a row and the empty rows under the sheet — the counts a
     real file carries, not tidied-up ones. */
  const tail = `<table:table-cell table:number-columns-repeated="1021"/>`;
  const emptyRows =
    `<table:table-row table:number-rows-repeated="1048570">` +
    `<table:table-cell table:number-columns-repeated="1024"/></table:table-row>`;

  const sales =
    `<table:table table:name="Prodaja">` +
    `<table:table-column table:style-name="co1"/>` +
    `<table:table-column table:number-columns-repeated="1023"/>` +
    `<table:table-row>${text('Mjesec')}${text('Iznos')}${text('Datum')}${tail}</table:table-row>` +
    `<table:table-row>${text('Siječanj')}${number('1234.5', '1.234,50')}` +
    `<table:table-cell table:style-name="ce2" office:value-type="date" ` +
    `office:date-value="2026-06-15"><text:p>15.06.2026.</text:p></table:table-cell>` +
    `${tail}</table:table-row>` +
    `<table:table-row>${text('Veljača')}${number('987.25', '987,25')}${tail}</table:table-row>` +
    `<table:table-row>${text('Ukupno')}` +
    `<table:table-cell table:style-name="ce1" table:formula="of:=SUM([.B2:.B3])" ` +
    `office:value-type="float" office:value="2221.75"><text:p>2.221,75</text:p></table:table-cell>` +
    `${tail}</table:table-row>` +
    `<table:table-row>` +
    `<table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1" ` +
    `office:value-type="boolean" office:boolean-value="true"><text:p>TOCNO</text:p></table:table-cell>` +
    `<table:covered-table-cell/>${tail}</table:table-row>` +
    emptyRows +
    `</table:table>`;

  const notes =
    `<table:table table:name="Biljeske">` +
    `<table:table-row>${text('uniqueods')}</table:table-row>` +
    emptyRows +
    `</table:table>`;

  const content =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<office:document-content ${ODF_NS} office:version="1.3">${styles}` +
    `<office:body><office:spreadsheet>${sales}${notes}</office:spreadsheet></office:body>` +
    `</office:document-content>`;

  const mime = 'application/vnd.oasis.opendocument.spreadsheet';
  return zipSync({
    // First and uncompressed, which is what makes the kind readable from the
    // first bytes without unpacking anything.
    mimetype: [strToU8(mime), { level: 0 }],
    'META-INF/manifest.xml': strToU8(ODF_MANIFEST(mime)),
    'content.xml': strToU8(content),
    'styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_NS}/>`),
  });
}

/**
 * An `.odt` — an OpenDocument text document.
 *
 * The things a reader has to carry across: headings at their outline level,
 * formatting held by a named style rather than by the element, a bulleted list,
 * a table with a header row, and a run of spaces written as `<text:s>` — which
 * `textContent` on its own silently eats.
 */
export function makeOdt() {
  const styles =
    `<office:automatic-styles>` +
    `<style:style style:name="T1" style:family="text">` +
    `<style:text-properties fo:font-weight="bold"/></style:style>` +
    `<style:style style:name="T2" style:family="text">` +
    `<style:text-properties fo:font-style="italic"/></style:style>` +
    `<text:list-style style:name="L1">` +
    `<text:list-level-style-bullet text:level="1" text:bullet-char="-"/></text:list-style>` +
    `</office:automatic-styles>`;

  const body =
    `<text:h text:style-name="Heading_20_1" text:outline-level="1">Izvjestaj o vjernosti</text:h>` +
    `<text:p text:style-name="Standard">Uvodni odlomak s dijakriticima: čćšžđ.</text:p>` +
    `<text:p><text:span text:style-name="T1">Podebljano </text:span>` +
    `<text:span text:style-name="T2">i ukoseno</text:span></text:p>` +
    `<text:h text:style-name="Heading_20_2" text:outline-level="2">Popis zahtjeva</text:h>` +
    `<text:list text:style-name="L1">` +
    `<text:list-item><text:p>prvi zahtjev</text:p></text:list-item>` +
    `<text:list-item><text:p>drugi zahtjev</text:p></text:list-item></text:list>` +
    `<text:p>Ime<text:s text:c="5"/>Prezime</text:p>` +
    `<table:table table:name="Tablica1">` +
    `<table:table-header-rows><table:table-row>` +
    `<table:table-cell><text:p>Format</text:p></table:table-cell>` +
    `<table:table-cell><text:p>Faza</text:p></table:table-cell>` +
    `</table:table-row></table:table-header-rows>` +
    `<table:table-row><table:table-cell><text:p>PDF</text:p></table:table-cell>` +
    `<table:table-cell><text:p>1</text:p></table:table-cell></table:table-row>` +
    `<table:table-row><table:table-cell><text:p>ODS</text:p></table:table-cell>` +
    `<table:table-cell><text:p>2</text:p></table:table-cell></table:table-row>` +
    `</table:table>` +
    `<text:p>Zakljucak spominje uniqueodt zbog pretrage.</text:p>`;

  const content =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<office:document-content ${ODF_NS} office:version="1.3">${styles}` +
    `<office:body><office:text>${body}</office:text></office:body></office:document-content>`;

  const mime = 'application/vnd.oasis.opendocument.text';
  return zipSync({
    mimetype: [strToU8(mime), { level: 0 }],
    'META-INF/manifest.xml': strToU8(ODF_MANIFEST(mime)),
    'content.xml': strToU8(content),
    'meta.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${ODF_NS}>` +
        `<office:meta><dc:title>Izvjestaj o vjernosti</dc:title></office:meta>` +
        `</office:document-meta>`,
    ),
    // A header in the master styles, so the view has something to admit it is
    // not showing.
    'styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_NS}>` +
        `<office:master-styles><style:master-page style:name="Standard">` +
        `<style:header><text:p>ulEditor</text:p></style:header>` +
        `</style:master-page></office:master-styles></office:document-styles>`,
    ),
  });
}

/* ── the old binary Word ─────────────────────────────────────────────── */

/**
 * An OLE2 compound file around named streams.
 *
 * `makeXls` writes its container by hand and gets away with it because it has
 * one stream, padded past the mini cutoff so the fixture needs no mini FAT. A
 * Word file cannot: it is at least two streams, and the small one — the table
 * stream, where the piece table and every property index live — lands under the
 * cutoff and therefore **inside the mini stream**, a second allocation of
 * 64-byte sectors held inside an ordinary stream of the root entry. That is the
 * half of the container real `.doc` files use and no fixture had ever built, so
 * it is built properly here rather than padded around.
 *
 * @param {{ name: string, data: Uint8Array }[]} streams
 */
function compoundFile(streams) {
  const SECTOR = 512;
  const MINI = 64;
  const CUTOFF = 4096;
  const END = 0xfffffffe;

  const padTo = (data, size) => {
    const out = new Uint8Array(Math.ceil(data.length / size) * size);
    out.set(data);
    return out;
  };

  const entries = streams.map((s) => ({ ...s, mini: s.data.length < CUTOFF, start: END }));
  const small = entries.filter((e) => e.mini);

  /* The mini stream: every small stream in turn, each starting on its own
     64-byte sector. */
  let miniSectors = 0;
  const miniParts = [];
  for (const entry of small) {
    entry.start = miniSectors;
    const padded = padTo(entry.data, MINI);
    miniParts.push(padded);
    miniSectors += padded.length / MINI;
  }
  const miniStream = new Uint8Array(miniSectors * MINI);
  {
    let at = 0;
    for (const part of miniParts) {
      miniStream.set(part, at);
      at += part.length;
    }
  }

  const miniFat = new Uint8Array(miniSectors * 4);
  {
    const view = new DataView(miniFat.buffer);
    for (let i = 0; i < miniSectors; i++) view.setUint32(i * 4, i + 1, true);
    for (const entry of small) {
      view.setUint32((entry.start + Math.ceil(entry.data.length / MINI) - 1) * 4, END, true);
    }
  }

  const sectors = [];
  const fat = [];
  const alloc = (data) => {
    if (data.length === 0) return END;
    const padded = padTo(data, SECTOR);
    const count = padded.length / SECTOR;
    const start = sectors.length;
    for (let i = 0; i < count; i++) {
      sectors.push(padded.subarray(i * SECTOR, (i + 1) * SECTOR));
      fat.push(start + i + 1);
    }
    fat[start + count - 1] = END;
    return start;
  };

  // Sector 0 is the FAT itself, written once every chain below is known.
  sectors.push(new Uint8Array(SECTOR));
  fat.push(0xfffffffd);

  for (const entry of entries) {
    if (!entry.mini) entry.start = alloc(entry.data);
  }
  const miniFatStart = alloc(miniFat);
  const miniStart = alloc(miniStream);

  const directory = new Uint8Array(Math.ceil((entries.length + 1) / 4) * SECTOR);
  const dir = new DataView(directory.buffer);
  const describe = (index, name, type, start, size) => {
    const at = index * 128;
    name.split('').forEach((ch, i) => dir.setUint16(at + i * 2, ch.charCodeAt(0), true));
    dir.setUint16(at + 64, (name.length + 1) * 2, true);
    dir.setUint8(at + 66, type);
    dir.setUint32(at + 68, 0xffffffff, true); // left sibling
    dir.setUint32(at + 72, 0xffffffff, true); // right sibling
    dir.setUint32(at + 76, type === 5 ? 1 : 0xffffffff, true); // the root's child
    dir.setUint32(at + 116, start, true);
    dir.setUint32(at + 120, size, true);
  };
  describe(0, 'Root Entry', 5, miniStream.length ? miniStart : END, miniStream.length);
  entries.forEach((entry, i) => describe(i + 1, entry.name, 2, entry.start, entry.data.length));
  const dirStart = alloc(directory);

  if (fat.length > SECTOR / 4) throw new Error('the fixture outgrew a single FAT sector');

  const out = new Uint8Array(SECTOR * (sectors.length + 1));
  const view = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true); // minor
  view.setUint16(26, 0x0003, true); // major — the 512-byte-sector version
  view.setUint16(28, 0xfffe, true); // byte order
  view.setUint16(30, 9, true); // 2^9 = 512
  view.setUint16(32, 6, true); // 2^6 = 64
  view.setUint32(44, 1, true); // one FAT sector
  view.setUint32(48, dirStart, true);
  view.setUint32(56, CUTOFF, true);
  view.setUint32(60, miniFat.length ? miniFatStart : END, true);
  view.setUint32(64, miniFat.length ? 1 : 0, true);
  view.setUint32(68, END, true); // no extra DIFAT
  view.setUint32(76, 0, true); // DIFAT[0] -> the FAT sector
  for (let i = 1; i < 109; i++) view.setUint32(76 + i * 4, 0xffffffff, true);

  sectors.forEach((data, i) => out.set(data, SECTOR * (i + 1)));
  for (let i = 0; i < SECTOR / 4; i++) view.setUint32(SECTOR + i * 4, fat[i] ?? 0xffffffff, true);
  return out;
}

/** The mark that ends a table cell — code 7, which is also how a row ends. */
const CELL = String.fromCharCode(7);
/** The three characters a field is punctuated with: begin, separator, end. */
const FIELD = [19, 20, 21].map((code) => String.fromCharCode(code));

/**
 * An old binary Word document — `.doc`, Word 97–2003 — assembled by hand.
 *
 * Everything the reader has to get right is here on purpose, and the fixture is
 * built out of the same numbers the reader reads back, so a wrong offset shows
 * up as a wrong document rather than as a crash:
 *
 * - **two pieces, one narrow and one wide.** The first paragraphs are CP1252,
 *   one byte per character, and hold `ž` — which CP1252 has. The rest are
 *   UTF-16 because they hold `č` and `ć`, which it does not. This is not a
 *   contrived split: it is what Word writes for a Croatian document, and
 *   reading such a file under one encoding garbles exactly those files.
 * - **the table stream inside the mini stream**, where a real small `.doc`
 *   keeps it.
 * - **a heading known by its `sti`** and a second known only by its name, in
 *   Croatian, because files do it both ways.
 * - **a table that is only punctuation** — cells ended by the cell mark, rows
 *   by a paragraph carrying `sprmPFTtp`.
 * - **a field**, whose instruction must be dropped and whose result must not.
 */
export function makeDoc() {
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  /* The 32 characters CP1252 puts where Latin-1 keeps control codes — the same
     table the reader has, used backwards. A character in neither this range nor
     Latin-1 has no narrow form, and the fixture says so rather than writing a
     byte that would come back as something else. */
  const CP1252_HIGH = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
    0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
  ];
  const narrowByte = (ch) => {
    const code = ch.charCodeAt(0);
    const high = CP1252_HIGH.indexOf(code);
    if (high !== -1) return 0x80 + high;
    if (code < 0x100) return code;
    throw new Error(`"${ch}" has no CP1252 byte — it belongs in the wide piece.`);
  };

  const IN_TABLE = [0x16, 0x24, 0x01]; // sprmPFInTable
  const ROW_END = [0x17, 0x24, 0x01]; // sprmPFTtp
  const IN_LIST = [0x0b, 0x46, 0x01, 0x00]; // sprmPIlfo
  const CENTRED = [0x03, 0x24, 0x01]; // sprmPJc80

  const NARROW = [
    { text: 'Zapisnik', istd: 1, sprms: [] },
    { text: 'Sastanak je održan u Vodicama.', istd: 0, sprms: [] },
  ];
  const WIDE = [
    { text: 'Zaključci', istd: 2, sprms: [] },
    { text: 'Prvi zaključak', istd: 0, sprms: IN_LIST },
    { text: 'Drugi zaključak', istd: 0, sprms: IN_LIST },
    { text: 'Stavka', istd: 0, sprms: IN_TABLE, cell: true },
    { text: 'Iznos', istd: 0, sprms: IN_TABLE, cell: true },
    { text: '', istd: 0, sprms: [...IN_TABLE, ...ROW_END], cell: true },
    { text: 'Prijevoz', istd: 0, sprms: IN_TABLE, cell: true },
    { text: '1.234,50', istd: 0, sprms: IN_TABLE, cell: true },
    { text: '', istd: 0, sprms: [...IN_TABLE, ...ROW_END], cell: true },
    // The instruction is machinery and must not be shown; the 2 after the
    // separator is what Word last drew, and must be.
    { text: `Stranica ${FIELD[0]}PAGE${FIELD[1]}2${FIELD[2]}.`, istd: 0, sprms: [] },
    { text: 'Kraj.', istd: 0, sprms: CENTRED },
  ];
  const mark = (para) => (para.cell ? CELL : '\r');

  const narrowText = NARROW.map((p) => p.text + mark(p)).join('');
  const wideText = WIDE.map((p) => p.text + mark(p)).join('');

  const narrowBytes = Uint8Array.from([...narrowText].map(narrowByte));
  const wideBytes = new Uint8Array(wideText.length * 2);
  {
    const view = new DataView(wideBytes.buffer);
    for (let i = 0; i < wideText.length; i++) view.setUint16(i * 2, wideText.charCodeAt(i), true);
  }

  /* Pages 0-1 the FIB, page 2 the text, page 3 the paragraph properties, page 4
     the character ones. The stream is padded to the mini cutoff so it lives in
     ordinary sectors while the table stream does not — which is the arrangement
     of every small Word file. */
  const TEXT = 0x400;
  const PAPX_PAGE = 3;
  const CHPX_PAGE = 4;
  const wideAt = TEXT + narrowBytes.length;
  const textEnd = wideAt + wideBytes.length;

  /* Where each paragraph ends, in bytes — the only index the property pages
     have. A narrow character costs one and a wide one two, which is why this
     cannot be counted in characters. */
  const bounds = [TEXT];
  {
    let at = TEXT;
    for (const para of NARROW) bounds.push((at += para.text.length + 1));
    at = wideAt;
    for (const para of WIDE) bounds.push((at += (para.text.length + 1) * 2));
  }

  const papxFkp = new Uint8Array(512);
  {
    const view = new DataView(papxFkp.buffer);
    const count = bounds.length - 1;
    bounds.forEach((fc, i) => view.setUint32(i * 4, fc, true));

    let at = (count + 1) * 4 + count * 13;
    if (at % 2) at++;
    [...NARROW, ...WIDE].forEach((para, i) => {
      /* The length convention: the leading byte is half the property list plus
         one, so the list is always an odd number of bytes and the whole entry an
         even one. A padding zero keeps that true. */
      const grpprl = [...u16(para.istd), ...para.sprms];
      if (grpprl.length % 2 === 0) grpprl.push(0);
      papxFkp[at] = (grpprl.length + 1) / 2;
      papxFkp.set(grpprl, at + 1);
      papxFkp[(count + 1) * 4 + i * 13] = at / 2;
      at += grpprl.length + 1;
    });
    if (at > 511) throw new Error('the paragraph property page overflowed');
    papxFkp[511] = count;
  }

  /*
   * Two bold words in the narrow piece, written **the two ways Word writes
   * bold**. `održan` carries the plain 1; `Vodicama` carries 0x81 — the toggle,
   * which means "the opposite of whatever the style says" and is what Word
   * actually puts in the file when somebody selects ordinary text and clicks
   * the Bold button.
   *
   * The second one is here because a fixture writing only the tidy 1 said the
   * reader worked while it was finding no bold at all in thirty-one real
   * documents that are visibly full of it.
   */
  const BOLD = [0x35, 0x08, 0x01]; // sprmCFBold, plainly on
  const BOLD_TOGGLE = [0x35, 0x08, 0x81]; // sprmCFBold, "unlike the style"
  const para = TEXT + NARROW[0].text.length + 1;
  const RUNS = [
    { at: TEXT, sprms: [] },
    { at: para + 'Sastanak je '.length, sprms: BOLD },
    { at: para + 'Sastanak je održan'.length, sprms: [] },
    { at: para + 'Sastanak je održan u '.length, sprms: BOLD_TOGGLE },
    { at: para + 'Sastanak je održan u Vodicama'.length, sprms: [] },
  ];

  const chpxFkp = new Uint8Array(512);
  {
    const view = new DataView(chpxFkp.buffer);
    const count = RUNS.length;
    [...RUNS.map((run) => run.at), textEnd].forEach((fc, i) => view.setUint32(i * 4, fc, true));

    let at = (count + 1) * 4 + count;
    if (at % 2) at++;
    RUNS.forEach((run, i) => {
      // A zero means "nothing said here" — that run keeps the default.
      if (run.sprms.length === 0) return;
      chpxFkp[(count + 1) * 4 + i] = at / 2;
      chpxFkp[at] = run.sprms.length;
      chpxFkp.set(run.sprms, at + 1);
      at += run.sprms.length + 1;
      if (at % 2) at++;
    });
    if (at > 511) throw new Error('the character property page overflowed');
    chpxFkp[511] = count;
  }

  const word = new Uint8Array(4096);
  word.set(narrowBytes, TEXT);
  word.set(wideBytes, wideAt);
  word.set(papxFkp, PAPX_PAGE * 512);
  word.set(chpxFkp, CHPX_PAGE * 512);

  /* The table stream. The style sheet first: one style known by the number Word
     gives its own, one known only by a Croatian name — a reader that handles
     only the first turns half the headings in this country into paragraphs. */
  const style = (sti, name) => {
    const std = [
      ...u16(sti),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(name.length),
      ...[...name].flatMap((ch) => u16(ch.charCodeAt(0))),
      ...u16(0),
    ];
    return [...u16(std.length), ...std];
  };
  const stshi = [...u16(3), ...u16(10), ...u16(0), ...u16(3), ...u16(3), ...u16(0), 0, 0, 0, 0, 0, 0];
  const stsh = [
    ...u16(stshi.length),
    ...stshi,
    ...style(0, 'Normal'),
    ...style(1, ''), // heading 1, named by its sti alone
    ...style(0x0ffe, 'Naslov 2'), // heading 2, named only in Croatian
  ];

  const plcBte = (page) => [...u32(TEXT), ...u32(textEnd), ...u32(page)];

  const pcd = (fc, narrow) => [...u16(0), ...u32(narrow ? ((fc * 2) | 0x40000000) >>> 0 : fc), ...u16(0)];
  const plcPcd = [
    ...u32(0),
    ...u32(narrowText.length),
    ...u32(narrowText.length + wideText.length),
    ...pcd(TEXT, true),
    ...pcd(wideAt, false),
  ];
  const clx = [0x02, ...u32(plcPcd.length), ...plcPcd];

  const table = [];
  const fcStshf = table.length;
  table.push(...stsh);
  const fcChpx = table.length;
  table.push(...plcBte(CHPX_PAGE));
  const fcPapx = table.length;
  table.push(...plcBte(PAPX_PAGE));
  const fcClx = table.length;
  table.push(...clx);

  const fib = new DataView(word.buffer);
  fib.setUint16(0x00, 0xa5ec, true); // wIdent
  fib.setUint16(0x02, 0x00c1, true); // nFib — Word 97
  fib.setUint16(0x0a, 0x0200, true); // fWhichTblStm: the table stream is 1Table
  fib.setUint16(0x20, 14, true); // csw
  fib.setUint16(0x3e, 22, true); // cslw
  fib.setUint32(0x40, word.length, true); // cbMac
  fib.setUint32(0x40 + 3 * 4, narrowText.length + wideText.length, true); // ccpText
  fib.setUint32(0x40 + 5 * 4, 2, true); // ccpHdd — a header we do not show
  fib.setUint16(0x98, 0x005d, true); // cbRgFcLcb
  const fcLcb = (index, fc, lcb) => {
    fib.setUint32(0x9a + index * 8, fc, true);
    fib.setUint32(0x9a + index * 8 + 4, lcb, true);
  };
  fcLcb(1, fcStshf, stsh.length);
  fcLcb(12, fcChpx, 12);
  fcLcb(13, fcPapx, 12);
  fcLcb(33, fcClx, clx.length);

  return compoundFile([
    { name: 'WordDocument', data: word },
    { name: '1Table', data: Uint8Array.from(table) },
  ]);
}

/**
 * A page whose content stream nothing will decode.
 *
 * The stream says it is Flate-compressed and is not — the shape of a file
 * written by something that got the header wrong, or repaired by a tool that
 * left a stream behind. Five of them turned up in one folder of four hundred
 * real PDFs, and pdf.js draws such a page perfectly happily, so it is on screen
 * looking ordinary while its glyphs cannot be reached at all.
 */
export function makeUndecodablePdf() {
  const stream = 'not compressed at all, whatever the dictionary says';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}/Filter/FlateDecode>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
