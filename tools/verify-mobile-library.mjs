/**
 * Knjižnica dokumenata na **fizičkom telefonu**.
 *
 * Dvije stvari koje se ne daju provjeriti nigdje drugdje:
 *
 * 1. **Da uopće nešto nađe.** Skeniranje ovisi o tome što Android propusti, a
 *    to se ponaša drukčije od svakog desktop datotečnog sustava.
 * 2. **Da laž ne prođe.** Bez dozvole Android vrati mape bez ijedne datoteke i
 *    ne javi grešku. Naivna knjižnica bi tada tvrdila „nemaš dokumenata” iako
 *    ih uređaj ima stotine. Zato se dozvola ovdje namjerno oduzima i provjerava
 *    da aplikacija kaže istinu.
 *
 * Dozvola se namješta preko `appops`, jer je `MANAGE_EXTERNAL_STORAGE` sustav
 * ne nudi kroz obični dijalog.
 *
 *   node tools/verify-mobile-library.mjs [--skip-install]
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { startDevice, stopDevice, installApk, deviceScreenshot, adb } from './device-session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'tools/screenshots');
const APK = resolve(
  ROOT,
  'apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk',
);

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const setAllFiles = (mode) =>
  adb('shell', 'appops', 'set', 'org.uleditor.app', 'MANAGE_EXTERNAL_STORAGE', mode);

/**
 * Otvara knjižnicu i čeka da skeniranje stane.
 *
 * Gumb je preklopnik, a knjižnica je na uskom ekranu zadani pogled — pa slijepi
 * klik jednako često zatvori koliko i otvori. Zato se gleda stanje, ne broji
 * klikovi. Pogledi na telefonu stoje u naslovnoj traci (`.view-btn`), ne u
 * okomitoj traci uz rub — nje ondje nema.
 */
async function openLibrary(page) {
  const shown = async () => (await page.locator('.library').count()) > 0;

  for (let attempt = 0; attempt < 2 && !(await shown()); attempt++) {
    await page.locator('.view-btn').first().click();
    await page.waitForTimeout(400);
  }
  await page.waitForSelector('.library', { timeout: 10000 });

  /* Skeniranje je gotovo kad se pojavi rezultat, zapreka ili poruka koja više
     nije „tražim…”. Čekanje na fiksno vrijeme bi bilo ili prekratko ili sporo. */
  await page.waitForFunction(
    () =>
      document.querySelector('.library-item') ||
      document.querySelector('.library-blocked') ||
      [...document.querySelectorAll('.library-note')].some((n) => !n.textContent.includes('…')),
    { timeout: 180000 },
  );
}

let session;

try {
  await mkdir(SHOTS, { recursive: true });

  if (!process.argv.includes('--skip-install')) {
    await installApk(APK);
    check('APK instaliran', true);
  }

  /* ── s dozvolom ─────────────────────────────────────────────────────── */

  await setAllFiles('allow');
  session = await startDevice();
  await openLibrary(session.page);

  const found = await session.page.evaluate(() => {
    const chips = [...document.querySelectorAll('.library-formats button')].map((b) => ({
      label: b.firstChild?.textContent?.trim() ?? '',
      count: Number(b.querySelector('span')?.textContent ?? 0),
    }));
    return {
      items: document.querySelectorAll('.library-item').length,
      blocked: !!document.querySelector('.library-blocked'),
      chips,
      first: document.querySelector('.library-name')?.textContent ?? '',
    };
  });

  const countOf = (label) => found.chips.find((c) => c.label === label)?.count ?? 0;
  const images = countOf('Image');
  const documents = found.items - images;

  console.log(
    `\n  nađeno: ${found.items} · dokumenata ${documents} · slika ${images}` +
      `\n  formati: ${found.chips.map((c) => `${c.label} ${c.count}`).join(', ')}\n`,
  );

  check('knjižnica je našla dokumente', documents > 0, `${documents} dokumenata`);
  check('nije prijavljena zapreka kad dozvola postoji', !found.blocked);
  check('ponuđen je filtar po formatu', found.chips.length > 1);

  /*
   * Bez zasebne kvote fotografije progutaju popis: na ovom uređaju su prvom
   * mjerenju dale 1956 slika naspram 41 PDF-a, a granica je pukla usred
   * skeniranja. Kvota je 400, pa se ovdje traži da je poštovana i da dokumenti
   * nisu ispali.
   */
  check('fotografije ne guše dokumente', images <= 400, `${images} slika`);

  /* Dokument se mora dati **otvoriti**, ne samo prikazati u popisu: putanja je
     izvan radnog prostora, pa skeniranje mora usvojiti korijene. */
  await session.page.locator('.library-item').first().click();
  const opened = await session.page
    .waitForSelector('.tabbar .tab', { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  check('dokument iz knjižnice se otvara', opened, found.first.slice(0, 40));

  await deviceScreenshot(resolve(SHOTS, 'mobile-library.png'));
  await stopDevice(session);
  session = null;

  /* ── bez dozvole ────────────────────────────────────────────────────── */

  await setAllFiles('deny');
  session = await startDevice();
  await openLibrary(session.page);

  const denied = await session.page.evaluate(() => ({
    items: document.querySelectorAll('.library-item').length,
    blocked: !!document.querySelector('.library-blocked'),
    heading: document.querySelector('.library-blocked strong')?.textContent ?? '',
  }));

  check('bez dozvole nema lažnih rezultata', denied.items === 0, `${denied.items} stavki`);
  check(
    'uskraćen pristup je prijavljen, ne prešućen',
    denied.blocked,
    denied.heading || 'nema poruke',
  );

  await deviceScreenshot(resolve(SHOTS, 'mobile-library-blocked.png'));
} catch (err) {
  check('ran without an exception', false, err instanceof Error ? err.message : String(err));
  await deviceScreenshot(resolve(SHOTS, 'failure-mobile-library.png')).catch(() => {});
} finally {
  await stopDevice(session);
  // Uređaj se ostavlja upotrebljivim.
  await setAllFiles('allow').catch(() => {});
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
