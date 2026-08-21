/**
 * Checking that editing a Word document touches **only what the user touched**.
 *
 * Editing Office without this means quietly losing somebody else's formatting,
 * and that is the biggest risk in the whole project. So the central check here is
 * not that the text changed but the opposite: that **everything else stayed the
 * same** — every other part of the archive byte for byte, and inside
 * `document.xml` every character outside the rewritten ranges.
 *
 *   node tools/verify-docx-edit.mjs
 */

import { unzipSync, strFromU8 } from 'fflate';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDocx } from './fixtures.mjs';
import './ts-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { findRuns, runText, applyRunEdits, writeDocx, escapeXml, unescapeXml } = await import(
  pathToFileURL(resolve(ROOT, 'packages/editor-office/src/docx-edit.ts')).href
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ── reading the runs ────────────────────────────────────────────────── */

const original = makeDocx();
const archive = unzipSync(original);
const xml = strFromU8(archive['word/document.xml']);

const runs = findRuns(xml);
check('the runs were found', runs.length > 0, `${runs.length}`);

const editable = runs.filter((run) => !run.refusal);
check('at least one run can be rewritten', editable.length > 0, `${editable.length} of ${runs.length}`);

const texts = editable.map((run) => runText(xml, run));
check('the run text was read', texts.every((text) => text.length > 0), JSON.stringify(texts[0]));

/* The ranges have to sit inside the run itself, or a replacement would eat the neighbouring XML. */
check(
  'the text range lies inside its own run',
  editable.every((run) => run.text.start >= run.start && run.text.end <= run.end),
);

/* ── refusals ────────────────────────────────────────────────────────── */

const tricky = [
  '<w:document xmlns:w="x"><w:body>',
  '<w:p><w:r><w:t>Plain</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>First</w:t><w:br/><w:t>Second</w:t></w:r></w:p>',
  '<w:p><w:r><w:tab/><w:t>Indented</w:t></w:r></w:p>',
  '<w:p><w:r><w:drawing><wp:inline><w:txbxContent><w:p><w:r><w:t>Inside</w:t></w:r></w:p></w:txbxContent></wp:inline></w:drawing></w:r></w:p>',
  '<w:p><w:r><w:t>Half</w:t><w:t>way</w:t></w:r></w:p>',
  '</w:body></w:document>',
].join('');

const trickyRuns = findRuns(tricky);
check('every run was counted, nested ones included', trickyRuns.length === 6, `${trickyRuns.length}`);
check('a plain run is rewritable', trickyRuns[0].refusal === null, trickyRuns[0].refusal ?? '');
check('a run with a line break is refused', /br/.test(trickyRuns[1].refusal ?? ''), trickyRuns[1].refusal ?? '');
check('a run with a tab is refused', /tab/.test(trickyRuns[2].refusal ?? ''), trickyRuns[2].refusal ?? '');
check(
  'a run with a drawing is refused',
  /drawing|nested/.test(trickyRuns[3].refusal ?? ''),
  trickyRuns[3].refusal ?? '',
);
check(
  'a run inside a drawing is still rewritable',
  trickyRuns[4].refusal === null && runText(tricky, trickyRuns[4]) === 'Inside',
  trickyRuns[4].refusal ?? runText(tricky, trickyRuns[4]),
);
check(
  'split text is refused rather than joined at random',
  /several parts/.test(trickyRuns[5].refusal ?? ''),
  trickyRuns[5].refusal ?? '',
);

/* ── replacement ─────────────────────────────────────────────────────── */

const target = editable[0];
const REPLACEMENT = 'Rewritten & <checked> — čćžšđ';
const edited = applyRunEdits(xml, runs, [{ index: target.index, text: REPLACEMENT }]);

check('the new text is in the XML, with its characters escaped', edited.includes(escapeXml(REPLACEMENT)));
check('a raw `&` did not get into the XML', !edited.includes('Rewritten & <checked>'));
check(
  'the spaces are preserved',
  /<w:t xml:space="preserve">/.test(edited),
  'xml:space="preserve" is set',
);

const reread = findRuns(edited);
check(
  'the rewritten run reads back as what was typed',
  runText(edited, reread[target.index]) === REPLACEMENT,
  runText(edited, reread[target.index]),
);

/*
 * Everything bar a single `w:t` element has to stay the same. The comparison runs
 * over the XML with every `w:t` stripped out — what is left is the document
 * structure.
 */
const skeleton = (source) => source.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>|<w:t\/>/g, '<w:t/>');
check('the document structure is untouched', skeleton(xml) === skeleton(edited));

const otherTexts = (source) =>
  findRuns(source)
    .filter((run) => !run.refusal && run.index !== target.index)
    .map((run) => runText(source, run));
check(
  'the other runs were not touched',
  JSON.stringify(otherTexts(xml)) === JSON.stringify(otherTexts(edited)),
);

/* ── the whole file ──────────────────────────────────────────────────── */

const rebuilt = writeDocx(archive, runs, xml, [{ index: target.index, text: REPLACEMENT }]);
const after = unzipSync(rebuilt);

check(
  'the archive has the same parts',
  JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(archive).sort()),
  `${Object.keys(after).length} parts`,
);

const untouched = Object.keys(archive).filter((path) => path !== 'word/document.xml');
const identical = untouched.filter((path) => {
  const a = archive[path];
  const b = after[path];
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
});
check(
  'every other part is identical byte for byte',
  identical.length === untouched.length,
  `${identical.length} of ${untouched.length}: ${untouched.filter((p) => !identical.includes(p)).join(', ') || 'none drifted'}`,
);

check(
  'the change reached the file',
  strFromU8(after['word/document.xml']).includes(escapeXml(REPLACEMENT)),
);

/* ── entities ────────────────────────────────────────────────────────── */

check(
  'reading resolves the entities',
  // 268 is Č, 0x107 is ć — numeric entities come both decimal and hexadecimal.
  unescapeXml('a &amp; b &lt;c&gt; &#268;&#x107;') === 'a & b <c> Čć',
  unescapeXml('a &amp; b &lt;c&gt; &#268;&#x107;'),
);

/* Empty text has to stay valid XML rather than vanish along with its element. */
const emptied = applyRunEdits(xml, runs, [{ index: target.index, text: '' }]);
check(
  'empty text leaves an empty element',
  findRuns(emptied)[target.index].refusal === null && runText(emptied, findRuns(emptied)[target.index]) === '',
);

/* ── outcome ─────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
