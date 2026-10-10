/**
 * What an EPS or PostScript file says about itself, read without running it
 * (packages/editor-vector/src/eps.ts, ADR 0007).
 *
 * The comments are somebody else's text shown in this page, and a DOS EPS
 * header is somebody else's numbers: both are fed lies here. A header whose
 * PostScript section lies outside the file gives no PostScript rather than a
 * slice of something else; a comment is printable ASCII only, cut at 200
 * characters, the first of each kind, without the parentheses PostScript
 * strings are written in, and `(atend)` — "given at the end" — is no value.
 *
 * No browser: the module has no DOM, and is imported as the source that ships.
 *
 *   node tools/verify-eps.mjs
 */

import './ts-resolve.mjs';

const { isDosEps, postscriptOf, isPostscript, dscFields } = await import(
  '../packages/editor-vector/src/eps.ts'
);
const { conversionOffer } = await import('../packages/editor-vector/src/conversion.ts');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const ascii = (text) => new TextEncoder().encode(text);

/** A DOS EPS: header, PostScript, and `tail` after it. */
function dosEps(postscript, tail = new Uint8Array(0), at = 30, length = postscript.length) {
  const out = new Uint8Array(30 + postscript.length + tail.length);
  out.set([0xc5, 0xd0, 0xd3, 0xc6]);
  const view = new DataView(out.buffer);
  view.setUint32(4, at, true);
  view.setUint32(8, length, true);
  out.set(postscript, 30);
  out.set(tail, 30 + postscript.length);
  return out;
}

const program = ascii(
  [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%Title: (Logo za letak.eps)',
    '%%Creator: Adobe Illustrator(R) 24.0',
    '%%CreationDate: 3/14/2021 10:22 AM',
    '%%BoundingBox: 0 0 595 842',
    '%%Title: (a second title, which is not the one)',
    'newpath 0 0 moveto showpage',
  ].join('\r\n'),
);

/* ── telling a DOS EPS ─────────────────────────────────────────────── */

check('a DOS EPS is told by its four bytes', isDosEps(dosEps(program)));
check('plain PostScript is not one', !isDosEps(program));
check('nor are four bytes of which only three match', !isDosEps(new Uint8Array([0xc5, 0xd0, 0xd3, 0x00, 0x01])));

/* ── the PostScript inside, and the lies about where it is ─────────── */

const inside = postscriptOf(dosEps(program, ascii('TIFF-SECTION')));
check(
  'the PostScript of a DOS EPS is the section its header names',
  new TextDecoder().decode(inside) === new TextDecoder().decode(program),
);
check('and the file itself when it is plain PostScript', postscriptOf(program) === program);
for (const [lie, eps] of [
  ['starts past the end', dosEps(program, undefined, 10_000)],
  ['runs past the end', dosEps(program, undefined, 30, program.length + 1)],
  ['ends past everything', dosEps(program, undefined, 30, 0xffffffff)],
  ['starts past everything', dosEps(program, undefined, 0xffffffff, 1)],
]) {
  check(`a section that ${lie} gives no PostScript`, postscriptOf(eps).length === 0);
}
check('a header cut short gives none', postscriptOf(dosEps(program).subarray(0, 10)).length === 0);
check('a DOS EPS is PostScript when its section is', isPostscript(dosEps(program)));
check('and not when its section lies', !isPostscript(dosEps(program, undefined, 10_000)));

/* ── the comments ──────────────────────────────────────────────────── */

const fields = dscFields(dosEps(program));
check('the title, without its parentheses', fields.title === 'Logo za letak.eps', fields.title);
check('the first title, not a later one', !fields.title?.includes('second'));
check('the program that wrote it', fields.creator === 'Adobe Illustrator(R) 24.0', fields.creator);
check('the date', fields.creationDate === '3/14/2021 10:22 AM', fields.creationDate);
check('the bounds', fields.boundingBox === '0 0 595 842', fields.boundingBox);

const hostile = dscFields(
  ascii(`%!PS\n%%Title: (<img src=x onerror=alert(1)>\u0000\u001b[31m‮)\n%%Creator: ${'A'.repeat(500)}\n%%BoundingBox: (atend)\n`),
);
check(
  'control and non-ASCII characters are dropped from a comment',
  hostile.title === '<img src=x onerror=alert(1)>[31m',
  JSON.stringify(hostile.title),
);
check('a comment is cut at 200 characters', hostile.creator?.length === 201 && hostile.creator.endsWith('…'));
check('(atend) is no value', hostile.boundingBox === undefined);

const late = dscFields(ascii(`%!PS\n${'% padding\n'.repeat(500)}%%Title: (too far down)\n`));
check('only the first 4 KiB are read', late.title === undefined);

check('a file with no comments has no fields', Object.keys(dscFields(ascii('%!PS\nshowpage\n'))).length === 0);

/* ── what the page offers (card 512) ───────────────────────────────── */

/* Outside Windows the core refuses PostScript before LibreOffice is started,
   since LibreOffice would run it through Ghostscript: the page says so there
   rather than offering a button that can only end in the refusal. */
const host = (available, formats) => ({
  available: async () => available,
  ...(formats ? { formats: async () => formats } : {}),
  convert: async () => new Uint8Array(),
});
const everywhere = ['cdr', 'eps', 'ps', 'ai']; // what ul-convert lists on Windows
const outsideWindows = ['cdr']; // and elsewhere

check('no LibreOffice: it says so', (await conversionOffer(host(false, everywhere), 'eps')) === 'missing');
for (const extension of ['eps', 'ps', 'ai', 'cdr']) {
  const offer = await conversionOffer(host(true, everywhere), extension);
  check(`on Windows the button is offered for .${extension}`, offer === 'offered', offer);
}
for (const extension of ['eps', 'ps', 'ai']) {
  const offer = await conversionOffer(host(true, outsideWindows), extension);
  check(`outside Windows .${extension} gets the reason, not a button`, offer === 'refused', offer);
}
check(
  'outside Windows a CorelDRAW drawing still gets the button',
  (await conversionOffer(host(true, outsideWindows), 'cdr')) === 'offered',
);
check(
  'a host that cannot say what it converts offers the button as before',
  (await conversionOffer(host(true, undefined), 'eps')) === 'offered',
);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
