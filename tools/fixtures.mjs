/**
 * Testni dokumenti koje dijele provjere.
 *
 * PDF se sastavlja ručno umjesto da stoji kao binarni asset u repozitoriju —
 * tako je vidljivo što točno testiramo i lako se mijenja.
 */

export const TS_SOURCE = `import { createShell } from './host';

/** Provjera bojanja sintakse i preloma redaka. */
export function main(): number {
  const shell = createShell();
  const formats = ['pdf', 'docx', 'xlsx'] as const;
  return formats.length + (shell ? 1 : 0);
}
`;

export const MD_SOURCE = `# ulEditor

Provjera **živog pregleda**.

| Format | Faza |
| --- | --- |
| PDF | 1 |
| XLSX | 2 |

> Dokument se nikad ne sprema tiho pokvaren.

\`\`\`ts
const x: number = 42;
\`\`\`
`;

/**
 * Minimalni ispravan PDF s točnom xref tablicom.
 * @param {string} text tekst koji se ispisuje na stranici
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

/** ZIP koji izgleda kao .docx — za provjeru detekcije i poruke o nepodržanom formatu. */
export function makeFakeDocx() {
  return 'PK' + ' '.repeat(26) + 'word/document.xml' + ' '.repeat(40);
}
