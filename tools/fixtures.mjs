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
 * @param {{ embedded?: boolean, trailer?: string, noMap?: boolean }} [opts]
 *   `embedded` attaches a `/FontFile2`, which is what tells the reader the
 *   glyphs travel with the document; `noMap` leaves out the `/ToUnicode`, which
 *   is the case where a code says nothing about the letter; `trailer` adds a
 *   second `Tj` in the same text object, positioned by nothing but the pen — so
 *   it moves if a rewrite fails to put the pen back.
 * @returns {string}
 */
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
    '<</Type/Font/Subtype/TrueType/BaseFont/ABCDEF+Inter-Regular/FirstChar 32/LastChar 126' +
      `/Widths[${widths}]/FontDescriptor 6 0 R${opts.noMap ? '' : '/ToUnicode 7 0 R'}>>`,
    '<</Type/FontDescriptor/FontName/ABCDEF+Inter-Regular/Flags 32/ItalicAngle 0/Ascent 750' +
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
  return 'PK' + ' '.repeat(26) + 'word/document.xml' + ' '.repeat(40);
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
