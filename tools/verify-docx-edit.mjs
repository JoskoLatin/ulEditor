/**
 * Provjera da izmjena Word dokumenta dira **samo ono što je korisnik dirao**.
 *
 * Uređivanje Officea bez ovoga znači tiho gubljenje tuđeg formatiranja, i to
 * je najveći rizik cijelog projekta. Zato ovdje glavna provjera nije da se
 * tekst promijenio nego suprotno: da je **sve ostalo ostalo isto** — svaki
 * drugi dio arhive bajt za bajt, a unutar `document.xml` svaki znak osim
 * prepisanih raspona.
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

/* ── čitanje runova ──────────────────────────────────────────────────── */

const original = makeDocx();
const archive = unzipSync(original);
const xml = strFromU8(archive['word/document.xml']);

const runs = findRuns(xml);
check('runovi su pronađeni', runs.length > 0, `${runs.length}`);

const editable = runs.filter((run) => !run.refusal);
check('barem jedan run se da prepisati', editable.length > 0, `${editable.length} od ${runs.length}`);

const texts = editable.map((run) => runText(xml, run));
check('tekst runa je pročitan', texts.every((text) => text.length > 0), JSON.stringify(texts[0]));

/* Rasponi moraju stajati unutar samog runa, inače bi zamjena pojela susjedni XML. */
check(
  'raspon teksta leži unutar svog runa',
  editable.every((run) => run.text.start >= run.start && run.text.end <= run.end),
);

/* ── odbijanja ───────────────────────────────────────────────────────── */

const tricky = [
  '<w:document xmlns:w="x"><w:body>',
  '<w:p><w:r><w:t>Dobar</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>Prvi</w:t><w:br/><w:t>Drugi</w:t></w:r></w:p>',
  '<w:p><w:r><w:tab/><w:t>Uvučeno</w:t></w:r></w:p>',
  '<w:p><w:r><w:drawing><wp:inline><w:txbxContent><w:p><w:r><w:t>Unutra</w:t></w:r></w:p></w:txbxContent></wp:inline></w:drawing></w:r></w:p>',
  '<w:p><w:r><w:t>Pola</w:t><w:t>vice</w:t></w:r></w:p>',
  '</w:body></w:document>',
].join('');

const trickyRuns = findRuns(tricky);
check('svi runovi su prebrojani, i ugniježđeni', trickyRuns.length === 6, `${trickyRuns.length}`);
check('običan run je prepisiv', trickyRuns[0].refusal === null, trickyRuns[0].refusal ?? '');
check('run s prijelomom retka se odbija', /br/.test(trickyRuns[1].refusal ?? ''), trickyRuns[1].refusal ?? '');
check('run s tabulatorom se odbija', /tab/.test(trickyRuns[2].refusal ?? ''), trickyRuns[2].refusal ?? '');
check(
  'run s crtežom se odbija',
  /drawing|ugniježđeni/.test(trickyRuns[3].refusal ?? ''),
  trickyRuns[3].refusal ?? '',
);
check(
  'run unutar crteža se i dalje da prepisati',
  trickyRuns[4].refusal === null && runText(tricky, trickyRuns[4]) === 'Unutra',
  trickyRuns[4].refusal ?? runText(tricky, trickyRuns[4]),
);
check(
  'razbijen tekst se odbija, ne spaja se nasumično',
  /više dijelova/.test(trickyRuns[5].refusal ?? ''),
  trickyRuns[5].refusal ?? '',
);

/* ── zamjena ─────────────────────────────────────────────────────────── */

const target = editable[0];
const REPLACEMENT = 'Prepisano & <provjereno> — čćžšđ';
const edited = applyRunEdits(xml, runs, [{ index: target.index, text: REPLACEMENT }]);

check('novi tekst je u XML-u, s escapeanim znakovima', edited.includes(escapeXml(REPLACEMENT)));
check('sirovi `&` nije ušao u XML', !edited.includes('Prepisano & <provjereno>'));
check(
  'razmaci se čuvaju',
  /<w:t xml:space="preserve">/.test(edited),
  'xml:space="preserve" je postavljen',
);

const reread = findRuns(edited);
check(
  'prepisani run se ponovno čita kao ono što je upisano',
  runText(edited, reread[target.index]) === REPLACEMENT,
  runText(edited, reread[target.index]),
);

/*
 * Sve osim jednog `w:t` elementa mora ostati isto. Usporedba ide nad XML-om iz
 * kojeg su izbačeni svi `w:t` — ostatak je struktura dokumenta.
 */
const skeleton = (source) => source.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>|<w:t\/>/g, '<w:t/>');
check('struktura dokumenta je netaknuta', skeleton(xml) === skeleton(edited));

const otherTexts = (source) =>
  findRuns(source)
    .filter((run) => !run.refusal && run.index !== target.index)
    .map((run) => runText(source, run));
check(
  'ostali runovi nisu dirani',
  JSON.stringify(otherTexts(xml)) === JSON.stringify(otherTexts(edited)),
);

/* ── cijela datoteka ─────────────────────────────────────────────────── */

const rebuilt = writeDocx(archive, runs, xml, [{ index: target.index, text: REPLACEMENT }]);
const after = unzipSync(rebuilt);

check(
  'arhiva ima iste dijelove',
  JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(archive).sort()),
  `${Object.keys(after).length} dijelova`,
);

const untouched = Object.keys(archive).filter((path) => path !== 'word/document.xml');
const identical = untouched.filter((path) => {
  const a = archive[path];
  const b = after[path];
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
});
check(
  'svi ostali dijelovi su bajt za bajt isti',
  identical.length === untouched.length,
  `${identical.length} od ${untouched.length}: ${untouched.filter((p) => !identical.includes(p)).join(', ') || 'nijedan ne odstupa'}`,
);

check(
  'izmjena je stigla u datoteku',
  strFromU8(after['word/document.xml']).includes(escapeXml(REPLACEMENT)),
);

/* ── entiteti ────────────────────────────────────────────────────────── */

check(
  'čitanje razrješava entitete',
  // 268 je Č, 0x107 je ć — brojčani entiteti idu i dekadski i heksadekadski.
  unescapeXml('a &amp; b &lt;c&gt; &#268;&#x107;') === 'a & b <c> Čć',
  unescapeXml('a &amp; b &lt;c&gt; &#268;&#x107;'),
);

/* Prazan tekst mora ostati valjan XML, a ne nestati zajedno s elementom. */
const emptied = applyRunEdits(xml, runs, [{ index: target.index, text: '' }]);
check(
  'prazan tekst ostavlja prazan element',
  findRuns(emptied)[target.index].refusal === null && runText(emptied, findRuns(emptied)[target.index]) === '',
);

/* ── ishod ───────────────────────────────────────────────────────────── */

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
