/**
 * Runtime provjera shella.
 *
 * Datoteke se ubacuju kroz pravi `drop` event umjesto kroz sistemski dijalog —
 * File System Access API se ne da voziti iz skripte, a drop prolazi kroz
 * potpuno isti put: adoptFiles → detekcija → registar → lijeni provider →
 * montaža editora. Dakle testira ono što nas zanima.
 *
 *   node tools/verify-ui.mjs [--url http://localhost:5273] [--headed]
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';
const headed = args.includes('--headed');

import { MD_SOURCE, TS_SOURCE, makeFakeDocx, makeMultiPagePdf, makePdf } from './fixtures.mjs';

/* ── pomoćno ─────────────────────────────────────────────────────────── */

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  const mark = passed ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/** `content` je string ili polje bajtova (za binarne formate). */
async function dropFile(page, name, content) {
  const bytes = typeof content === 'string' ? null : Array.from(content);
  await page.evaluate(
    async ([fileName, text, byteArray]) => {
      const body = byteArray ? new Uint8Array(byteArray) : text;
      const file = new File([body], fileName);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    [name, typeof content === 'string' ? content : '', bytes],
  );
}

/* ── izvođenje ───────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  await mkdir(SHOTS, { recursive: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  /* — okvir — */
  await page.waitForSelector('.shell', { timeout: 15000 });
  check('shell se renderira', true);

  for (const [label, selector] of [
    ['naslovna traka', '.titlebar'],
    ['aktivnosna traka', '.activitybar'],
    ['bočna ploča', '.sidebar'],
    ['statusna traka', '.statusbar'],
    ['pozdravni ekran', '.welcome'],
  ]) {
    check(`${label} postoji`, await page.locator(selector).isVisible());
  }

  /* — kod — */
  await dropFile(page, 'primjer.ts', TS_SOURCE);
  await page.waitForSelector('.cm-editor', { timeout: 15000 });
  const highlighted = await page.locator('.cm-line span[class*="ͼ"]').count();
  check('CodeMirror montiran', true);
  check('sintaksa obojana', highlighted > 0, `${highlighted} obojanih tokena`);
  check('kartica dobila ime', (await page.locator('.tab .name').first().innerText()) === 'primjer.ts');

  /* — markdown — */
  await dropFile(page, 'biljeske.md', MD_SOURCE);
  await page.waitForSelector('.ul-md', { timeout: 15000 });
  await page.waitForSelector('.ul-md-preview h1', { timeout: 10000 });
  const previewTitle = await page.locator('.ul-md-preview h1').first().innerText();
  check('Markdown pregled renderiran', previewTitle.trim() === 'ulEditor', previewTitle.trim());
  check('tablica u pregledu', (await page.locator('.ul-md-preview table').count()) === 1);

  /* — PDF — */
  await dropFile(page, 'dokument.pdf', makePdf());
  await page.waitForSelector('.ul-pdf', { timeout: 20000 });
  await page.waitForSelector('.ul-pdf-page[data-rendered="true"]', { timeout: 20000 });
  const canvasBox = await page.locator('.ul-pdf-page canvas').first().boundingBox();
  check('PDF stranica renderirana', !!canvasBox && canvasBox.width > 50, `${Math.round(canvasBox?.width ?? 0)}px`);
  const textSpans = await page.locator('.ul-pdf-text span').count();
  check('tekstualni sloj izgrađen', textSpans > 0, `${textSpans} fragmenata`);

  /* — oštećena datoteka — */
  // ZIP koji to nije: editor postoji, ali sadržaj se ne da pročitati. Poruka
  // mora biti ljudska, ne ono što je dobacila biblioteka za raspakiravanje.
  await dropFile(page, 'ugovor.docx', makeFakeDocx());
  await page.waitForSelector('.surface-error', { timeout: 10000 });
  const message = await page.locator('.surface-error p').innerText();
  check('oštećen DOCX daje razumljivu poruku', message.includes('damaged'), message.slice(0, 70));

  /* — anotacije nad PDF-om — */
  await page.locator('.tab').nth(2).click();
  await page.waitForTimeout(300);

  await page.locator('.ul-pdf-tool[title*="Highlight"]').click();
  // Selekcija se pravi programski: pravo povlačenje mišem preko nevidljivog
  // tekstualnog sloja nije pouzdano na jednom retku teksta.
  await page.evaluate(() => {
    const span = document.querySelector('.ul-pdf-text span');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('.ul-pdf-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForSelector('.ul-pdf-ann-highlight', { timeout: 10000 });
  check('istaknuće stvoreno iz selekcije', (await page.locator('.ul-pdf-ann-highlight').count()) >= 1);
  check(
    'PDF označen kao izmijenjen',
    (await page.locator('.tab[data-dirty="true"]').count()) >= 1,
    await page.locator('.ul-pdf-count').innerText(),
  );

  await page.locator('.ul-pdf-tool[title*="Note"]').click();
  await page.locator('.ul-pdf-page').first().click({ position: { x: 200, y: 60 } });
  await page.waitForSelector('.ul-pdf-note-popup', { timeout: 5000 });
  await page.locator('.ul-pdf-note-popup textarea').fill('Provjeriti čćžšđ');
  const noteBeforeSave = await page.locator('.ul-pdf-ann-note').count();
  await page.locator('.ul-pdf-note-popup button[data-primary="true"]').click();
  await page.waitForTimeout(250);
  const noteAfterSave = await page.locator('.ul-pdf-ann-note').count();
  check(
    'bilješka postavljena',
    noteAfterSave === 1,
    `prije spremanja ${noteBeforeSave}, poslije ${noteAfterSave}, traka: ${await page
      .locator('.ul-pdf-count')
      .innerText()}`,
  );

  // Postavljanje bilješke i upis teksta su dva odvojena koraka povijesti,
  // pa prvi undo vraća prazan tekst, a tek drugi miče samu bilješku.
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(250);
  const titleAfterOne = await page.locator('.ul-pdf-ann-note').first().getAttribute('title');
  check('prvi undo vraća tekst bilješke', titleAfterOne === 'Note', String(titleAfterOne));

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(250);
  const notesLeft = await page.locator('.ul-pdf-ann-note').count();
  const highlightsLeft = await page.locator('.ul-pdf-ann-highlight').count();
  check(
    'drugi undo miče bilješku, istaknuće ostaje',
    notesLeft === 0 && highlightsLeft >= 1,
    `bilješki ${notesLeft}, istaknuća ${highlightsLeft}`,
  );

  // Redo mora vratiti bilješku — inače undo nije reverzibilan.
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(250);
  check('redo vraća bilješku', (await page.locator('.ul-pdf-ann-note').count()) === 1);

  /* — tekst upisan u PDF — */
  await page.locator('.ul-pdf-tool[title*="Add text"]').click();
  check('postavke fonta se pojave tek uz alat za tekst', await page.locator('.ul-pdf-text-opts').isVisible());

  await page.locator('.ul-pdf-page').first().click({ position: { x: 90, y: 120 } });
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 10000 });

  const TYPED = 'Vodice — čćžšđ';
  await page.locator('.ul-pdf-text-input').pressSequentially(TYPED);

  /*
   * Font iz kojeg se računa okvir mora biti i onaj kojim se crta na ekranu.
   * Inače bi se širina okvira i širina teksta razišle, i to različito po
   * platformama — na Windowsu jedva, na Androidu vidljivo.
   */
  const usesEmbedded = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.ul-pdf-text-input')).fontFamily.includes(
      'ulEditor Sans',
    ),
  );
  check('polje za tipkanje koristi ugrađeni font', usesEmbedded);

  const grew = await page.evaluate(() => {
    const input = document.querySelector('.ul-pdf-text-input');
    return input.getBoundingClientRect().width;
  });

  await page.keyboard.press('Escape');
  await page.waitForSelector('.ul-pdf-ann-text', { timeout: 5000 });
  const boxText = await page.locator('.ul-pdf-ann-text').first().innerText();
  check('tekst ostaje na stranici nakon tipkanja', boxText === TYPED, JSON.stringify(boxText));
  check('okvir se proširio uz tekst', grew > 40, `${Math.round(grew)}px`);

  // Prazan okvir ne smije ostati iza sebe: kliknuti pa se predomisliti je
  // najčešći potez, a nevidljiva anotacija u dokumentu je smeće.
  const boxesBefore = await page.locator('.ul-pdf-ann-text').count();
  await page.locator('.ul-pdf-page').first().click({ position: { x: 260, y: 200 } });
  await page.waitForSelector('.ul-pdf-text-input', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check(
    'prazan okvir se ne sprema',
    (await page.locator('.ul-pdf-ann-text').count()) === boxesBefore,
    `${boxesBefore} prije, ${await page.locator('.ul-pdf-ann-text').count()} poslije`,
  );

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(250);
  check('undo miče upisani tekst', (await page.locator('.ul-pdf-ann-text').count()) === 0);

  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(250);
  check('redo ga vraća', (await page.locator('.ul-pdf-ann-text').count()) === 1);

  await page.locator('.ul-pdf-tool[title*="Select"]').click();

  /* — slika — */
  const png = await readFile(resolve(ROOT, 'apps/desktop/src-tauri/icons/128x128.png'));
  await dropFile(page, 'ikona.png', png);
  await page.waitForSelector('.ul-img', { timeout: 15000 });
  await page.waitForSelector('.ul-img-frame img', { timeout: 10000 });
  const imgBox = await page.locator('.ul-img-frame img').boundingBox();
  check('slika prikazana', !!imgBox && imgBox.width > 10, `${Math.round(imgBox?.width ?? 0)}px`);
  const imgStatus = await page.locator('.statusbar').innerText();
  check('dimenzije u statusnoj traci', imgStatus.includes('128 × 128'), imgStatus.replace(/\s+/g, ' ').slice(0, 60));

  /* — tabovi — */
  check('pet otvorenih kartica', (await page.locator('.tab').count()) === 5);

  /* — pretraga u dokumentu (isti ugovor za sve formate) — */
  await page.locator('.tab').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.waitForSelector('.findpanel', { timeout: 5000 });
  await page.locator('.findpanel-bar input').pressSequentially('formats');
  await page.waitForSelector('.findpanel-hit', { timeout: 10000 });
  const codeHits = await page.locator('.findpanel-hit').count();
  check('pretraga u kodu', codeHits >= 2, `${codeHits} pogodaka`);

  await page.locator('.findpanel-hit').nth(1).click();
  await page.waitForTimeout(200);
  check('skok na pogodak radi', (await page.locator('.findpanel-hit[data-active="true"]').count()) === 1);

  // Isti UI nad PDF-om — format koji inače nema nikakvo sučelje za pretragu.
  await page.locator('.tab').nth(2).click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+Shift+F');
  await page.waitForSelector('.findpanel', { timeout: 5000 });
  // Upit se namjerno zadržava kroz kartice, pa ga ovdje zamjenjujemo.
  await page.locator('.findpanel-bar input').fill('ulEditor');
  await page.waitForSelector('.findpanel-hit', { timeout: 15000 });
  const pdfHits = await page.locator('.findpanel-hit').count();
  const pdfLabel = await page.locator('.findpanel-hit .where').first().innerText();
  check('ista pretraga radi nad PDF-om', pdfHits > 0 && pdfLabel.includes('Stranica'), `${pdfHits} · ${pdfLabel}`);

  // Prebacivanje natrag na kod mora odmah maknuti rezultate iz PDF-a —
  // `reveal()` na tuđem rezultatu skočio bi u editor koji nije u prvom planu.
  await page.locator('.tab').first().click();
  await page.waitForTimeout(120);
  const staleWhere = await page.locator('.findpanel-hit .where').allInnerTexts();
  check(
    'rezultati iz druge kartice se ne zadržavaju',
    !staleWhere.some((t) => t.includes('Stranica')),
    staleWhere.slice(0, 2).join(', ') || 'prazno',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc zatvara pretragu', (await page.locator('.findpanel').count()) === 0);

  /* — paleta naredbi — */
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { timeout: 5000 });
  const allCommands = await page.locator('.palette-item').count();

  const paletteInput = page.locator('.palette-input input');
  check('paleta se sama fokusira', await paletteInput.evaluate((el) => el === document.activeElement));

  await paletteInput.pressSequentially('cycle theme');
  const paletteHits = await page.locator('.palette-item').count();
  check(
    'paleta filtrira naredbe',
    paletteHits > 0 && paletteHits < allCommands,
    `${allCommands} → ${paletteHits}`,
  );

  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  check('naredba mijenja temu', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

  /* — uređivanje i oznaka promjene — */
  await page.locator('.tab').first().click();
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('// izmjena\n');
  await page.waitForTimeout(150);
  // Dvije izmijenjene kartice: kod koji smo upravo tipkali i PDF s anotacijama.
  const dirty = await page.locator('.tab[data-dirty="true"]').count();
  check('oznaka nespremljenog na obje izmijenjene kartice', dirty === 2, `${dirty}`);

  /* — operacije nad stranicama — */
  await dropFile(page, 'visestranicni.pdf', makeMultiPagePdf(3));
  await page.waitForSelector('.tab', { timeout: 10000 });
  await page.locator('.tab').nth(5).click();
  // Neaktivne kartice ostaju u DOM-u (samo su skrivene), pa se od sada
  // selektori moraju ograničiti na vidljivu ploču.
  const pdf = page.locator('.mount:visible');
  await pdf.locator('.ul-pdf-page[data-rendered="true"]').first().waitFor({ timeout: 20000 });

  await pdf.locator('.ul-pdf-btn[title*="Pages"]').click();
  await pdf.locator('.ul-pdf-thumb').first().waitFor({ timeout: 10000 });
  check('traka pokazuje tri stranice', (await pdf.locator('.ul-pdf-thumb').count()) === 3);

  await pdf.locator('.ul-pdf-thumb').first().hover();
  await pdf.locator('.ul-pdf-thumb').first().locator('button[title*="Rotate right"]').click();
  await page.waitForTimeout(400);
  check(
    'rotirana stranica je označena kao izmijenjena',
    (await pdf.locator('.ul-pdf-thumb .num[data-changed="true"]').count()) === 1,
  );

  await pdf.locator('.ul-pdf-thumb').nth(1).hover();
  await pdf.locator('.ul-pdf-thumb').nth(1).locator('button[title*="Delete page"]').click();
  await page.waitForTimeout(500);
  check('brisanje ostavlja dvije stranice', (await pdf.locator('.ul-pdf-thumb').count()) === 2);
  check(
    'brojač stranica u traci prati brisanje',
    (await pdf.locator('.ul-pdf-total').innerText()).includes('2'),
    await pdf.locator('.ul-pdf-total').innerText(),
  );
  check(
    'izmjene stranica su opisane',
    (await pdf.locator('.ul-pdf-count').innerText()).includes('deleted'),
    await pdf.locator('.ul-pdf-count').innerText(),
  );

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(600);
  check('undo vraća obrisanu stranicu', (await pdf.locator('.ul-pdf-thumb').count()) === 3);

  await page.screenshot({ path: resolve(SHOTS, 'pages.png') });

  /* — snimke — */
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(SHOTS, 'shell-dark.png') });

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(SHOTS, 'shell-light.png') });

  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, 'markdown.png') });

  await page.locator('.tab').nth(2).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(SHOTS, 'pdf.png') });

  await page.locator('.tab').nth(4).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS, 'image.png') });

  await page.locator('.tab').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.locator('.findpanel-bar input').fill('const');
  await page.waitForSelector('.findpanel-hit', { timeout: 10000 });
  // Animacija ulaska ploče traje 140 ms; snimka prije toga izgleda blijedo.
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOTS, 'find.png') });
  await page.keyboard.press('Escape');

  check('snimke spremljene', true, 'tools/screenshots/');

  /* — konzola — */
  const ignorable = (text) => text.includes('Download the React DevTools') || text.includes('[vite]');
  const real = consoleErrors.filter((t) => !ignorable(t));
  check('bez grešaka u konzoli', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('izvođenje bez iznimke', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: resolve(SHOTS, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
await writeFile(resolve(SHOTS, 'report.json'), JSON.stringify({ checks, consoleErrors }, null, 2));

console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
