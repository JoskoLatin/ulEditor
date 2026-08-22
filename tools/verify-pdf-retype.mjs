/**
 * Retyping a line **in the document's own font**.
 *
 * The old route deleted the line and wrote a new one with our embedded font. It
 * was right in the file and wrong on the page: everything except Helvetica came
 * back in different letterforms, so a corrected invoice announced itself as
 * corrected. This is what replaced it, and these are the properties that have to
 * hold for it to be worth anything:
 *
 * - the words change and **nothing else does** — same font object, no new font
 *   in the file, the same size and place;
 * - **the pen ends where it did**, so whatever follows on the line stays put
 *   even when the new text is shorter or longer;
 * - a character the font cannot write is **refused by name**, not written as a
 *   blank, so the caller can fall back to our font and say why;
 * - a line that has moved since it was picked is **not** rewritten over
 *   whatever now sits in its place.
 *
 * No browser: this is the content stream in and the content stream out. What the
 * editor does around it is checked in `verify-pdf-editing.mjs`.
 *
 *   node tools/verify-pdf-retype.mjs
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './ts-resolve.mjs';
import { makePdf, makeToUnicodePdf } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(ROOT, 'packages/editor-pdf/package.json'));
const load = (file) =>
  import(pathToFileURL(resolve(ROOT, `packages/editor-pdf/src/${file}`)).href);

const { applyRetype } = await load('retype.ts');
const { readPageContent, boundsOfOperation, textOf } = await load('content.ts');
const { standardWidths } = await load('text.ts');

const FONTS = {
  sans: 'LiberationSans-Regular.ttf',
  'sans-bold': 'LiberationSans-Bold.ttf',
  'sans-italic': 'LiberationSans-Italic.ttf',
};
const loadFont = async (face) =>
  new Uint8Array(await readFile(require.resolve(`pdfjs-dist/standard_fonts/${FONTS[face]}`)));

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const standard = await standardWidths(loadFont);
const bytesOf = (pdf) => new Uint8Array(Buffer.from(pdf, 'latin1'));

/** Every text operator of the first page, read back from finished bytes. */
async function operationsOf(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPages()[0];
  return readPageContent(page, standard).operations.map((operation) => ({
    text: textOf(operation),
    bounds: boundsOfOperation(operation),
    font: operation.font,
    size: operation.effectiveSize,
    origin: operation.origin,
  }));
}

/* ── a line rewritten keeps everything but its words ─────────────────── */

{
  const source = bytesOf(makeToUnicodePdf('Name and surname'));
  const [before] = await operationsOf(source);

  const outcome = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Name and surname', after: 'Name and address' },
    standard,
  );
  check('a line in a mapped font is rewritten', outcome.kind === 'done', outcome.kind);

  if (outcome.kind === 'done') {
    const [after] = await operationsOf(outcome.bytes);
    check('the words are the new ones', after.text === 'Name and address', String(after.text));
    check(
      'the font is the one that was already there',
      after.font.baseFont === before.font.baseFont && after.font.name === before.font.name,
      `${before.font.baseFont} → ${after.font.baseFont}`,
    );
    check('the size is untouched', after.size === before.size, `${before.size} → ${after.size}`);
    check(
      'and so is the baseline',
      Math.abs(after.origin.x - before.origin.x) < 0.001 &&
        Math.abs(after.origin.y - before.origin.y) < 0.001,
      `${JSON.stringify(before.origin)} → ${JSON.stringify(after.origin)}`,
    );

    /* The whole point: nothing is embedded to write the replacement, because the
       replacement is written with what the document already carried. */
    const doc = await PDFDocument.load(outcome.bytes, { ignoreEncryption: true });
    const fonts = doc.getPages()[0].node.Resources()?.lookup(PDFName.of('Font'));
    const names = [...fonts.entries()].map(([key]) => key.asString());
    check(
      'no font was added to the page',
      names.length === 1 && names[0] === '/F1',
      names.join(' '),
    );
  }
}

/* ── the pen ends where it did ───────────────────────────────────────── */

{
  /* A second operator in the same text object, positioned by nothing but where
     the first one left the pen. If the correction were missing it would slide. */
  const source = bytesOf(makeToUnicodePdf('Name and surname', { trailer: ' [ok]' }));
  const before = await operationsOf(source);
  check('the fixture has a line and a trailer', before.length === 2, `${before.length} operators`);

  /* Both new lines are spelt out of letters the page already draws — the point
     here is the arithmetic, and a missing glyph would stop it before that. */
  for (const [label, text] of [
    ['a shorter line', 'Name'],
    ['a longer line', 'Name and surname more'],
  ]) {
    const outcome = await applyRetype(
      source,
      { page: 1, rect: before[0].bounds, before: 'Name and surname', after: text },
      standard,
    );
    if (outcome.kind !== 'done') {
      check(`${label} is rewritten`, false, outcome.kind);
      continue;
    }
    const after = await operationsOf(outcome.bytes);
    check(
      `what follows ${label} does not move`,
      Math.abs(after[1].origin.x - before[1].origin.x) < 0.01,
      `x ${before[1].origin.x.toFixed(2)} → ${after[1].origin.x.toFixed(2)}`,
    );
  }
}

/* ── the standard fourteen, where the widths are agreed rather than listed ── */

{
  const source = bytesOf(makePdf('Total 100 EUR'));
  const [before] = await operationsOf(source);
  const outcome = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Total 100 EUR', after: 'Total 250 EUR' },
    standard,
  );
  check('a font that is only named can be written too', outcome.kind === 'done', outcome.kind);
  if (outcome.kind === 'done') {
    const [after] = await operationsOf(outcome.bytes);
    check('with the new figure', after.text === 'Total 250 EUR', String(after.text));
  }
}

/* ── what the font cannot write is named, not blanked ────────────────── */

{
  const source = bytesOf(makeToUnicodePdf('Name and surname'));
  const [before] = await operationsOf(source);
  const outcome = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Name and surname', after: 'Name and surname čć' },
    standard,
  );
  check('a letter the document never had is refused', outcome.kind === 'missing', outcome.kind);
  check(
    'and it is named, both of them',
    outcome.kind === 'missing' && outcome.chars.join('') === 'čć',
    outcome.kind === 'missing' ? outcome.chars.join(' ') : '',
  );
}

/* ── an embedded font with no map at all, which is the ordinary case ─── */

{
  /*
   * A subset of a font and no `/ToUnicode`: this is what a real invoice looks
   * like, and going by the map alone not one letter of it could be written. What
   * the page already draws can be, though — those codes have glyphs behind them
   * by definition.
   */
  const source = bytesOf(makeToUnicodePdf('Name and surname', { embedded: true, noMap: true }));
  const [before] = await operationsOf(source);

  const outcome = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Name and surname', after: 'Name and address' },
    standard,
  );
  check(
    'a page with no map is edited from the letters it already draws',
    outcome.kind === 'done',
    outcome.kind,
  );
  if (outcome.kind === 'done') {
    const [after] = await operationsOf(outcome.bytes);
    check('and it reads as it should', after.text === 'Name and address', String(after.text));
  }

  const beyond = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Name and surname', after: 'Name and prize' },
    standard,
  );
  check(
    'a letter that page never drew is still refused',
    beyond.kind === 'missing' && beyond.chars.join('') === 'piz',
    beyond.kind === 'missing' ? beyond.chars.join(' ') : beyond.kind,
  );
}

/* ── refusals that protect the document ──────────────────────────────── */

{
  const source = bytesOf(makeToUnicodePdf('Name and surname'));
  const [before] = await operationsOf(source);

  const broken = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Name and surname', after: 'Name\nand surname' },
    standard,
  );
  check('a line break sends the edit down the other route', broken.kind === 'refused', broken.kind);

  const moved = await applyRetype(
    source,
    { page: 1, rect: before.bounds, before: 'Something else entirely', after: 'Anything' },
    standard,
  );
  check('a line that no longer reads the same is left alone', moved.kind === 'refused', moved.kind);

  const elsewhere = await applyRetype(
    source,
    {
      page: 1,
      rect: { ...before.bounds, y: before.bounds.y + 40 },
      before: 'Name and surname',
      after: 'Anything',
    },
    standard,
  );
  check('and so is one that has moved', elsewhere.kind === 'refused', elsewhere.kind);

  const gone = await applyRetype(
    source,
    { page: 9, rect: before.bounds, before: 'Name and surname', after: 'Anything' },
    standard,
  );
  check('a page that is not there is not written to', gone.kind === 'refused', gone.kind);
}

/* ── twice over, because an edit is rarely the last one ──────────────── */

{
  const source = bytesOf(makeToUnicodePdf('Name and surname'));
  const [first] = await operationsOf(source);
  const once = await applyRetype(
    source,
    { page: 1, rect: first.bounds, before: 'Name and surname', after: 'Name and address' },
    standard,
  );
  if (once.kind !== 'done') {
    check('the first edit went through', false, once.kind);
  } else {
    const [second] = await operationsOf(once.bytes);
    const twice = await applyRetype(
      once.bytes,
      { page: 1, rect: second.bounds, before: 'Name and address', after: 'Name and username' },
      standard,
    );
    check('a second edit lands on the first', twice.kind === 'done', twice.kind);
    if (twice.kind === 'done') {
      const [after] = await operationsOf(twice.bytes);
      check('and reads as it should', after.text === 'Name and username', String(after.text));
    }
  }
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
