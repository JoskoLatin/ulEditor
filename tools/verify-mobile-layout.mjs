/**
 * Raspored na **fizičkom telefonu**.
 *
 * Mobilni shell nije stisnuti desktop nego drukčija podjela prostora:
 * navigacija gore, alati otvorenog dokumenta uz lijevi rub, ploča pada odozgo
 * i miče se čim je odabir napravljen. Sve to ovisi o stvarnoj širini ekrana i o
 * ponašanju sistemskih traka, pa se u pregledniku ne da provjeriti — uski
 * viewport bi testirao medijski upit, ne uređaj.
 *
 * Mjeri se, ne gleda: umetci se očitavaju iz webviewa, lomljenje teksta se
 * broji u retcima, a položaji se uspoređuju u pikselima.
 *
 *   node tools/verify-mobile-layout.mjs [--skip-install]
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { startDevice, stopDevice, installApk, deviceScreenshot } from './device-session.mjs';

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

let session;

try {
  await mkdir(SHOTS, { recursive: true });

  if (!process.argv.includes('--skip-install')) {
    await installApk(APK);
    check('APK instaliran na uređaj', true);
  }

  session = await startDevice();
  const { page } = session;
  check('spojen na webview na telefonu', true);

  /*
   * Shell obnavlja sesiju, pa se ploča i kartice pojave tek nakon prvog
   * rendera. Bez predaha provjera zatekne prazan DOM i zaključi da je sve
   * zatvoreno, a onda joj ploča iskoči pred klik.
   */
  await page.waitForTimeout(1200);

  /* Gumb zatvara ploču samo ako je njegov pogled već aktivan; inače prebacuje
     pogled i ploča ostaje. Zato se ne broje klikovi nego se gleda stanje. */
  const panelOpen = async () => (await page.locator('.sidebar').count()) > 0;
  for (let guard = 0; guard < 5 && (await panelOpen()); guard++) {
    await page.locator('.view-btn').first().click();
    await page.waitForTimeout(400);
  }

  /* Mjeri se pozdravni ekran, pa otvorenih dokumenata ne smije biti. */
  for (let guard = 0; guard < 20 && (await page.locator('.tab').count()) > 0; guard++) {
    await page.locator('.tab .close').first().click();
    await page.waitForTimeout(250);
  }

  /*
   * Umetci se čitaju iz samog webviewa. Android ih ne mora prijaviti: bez
   * izreza u ekranu `safe-area-inset-top` zna biti nula i onda sistemska traka
   * i dalje stoji preko naslovne. Zato se vrijednost ispisuje, a ne samo
   * uspoređuje — bez broja se ne zna je li popravak uopće primijenjen.
   */
  const insets = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = [
      'position:fixed;top:0;left:0;visibility:hidden',
      'padding-top:env(safe-area-inset-top)',
      'padding-right:env(safe-area-inset-right)',
      'padding-bottom:env(safe-area-inset-bottom)',
      'padding-left:env(safe-area-inset-left)',
    ].join(';');
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const read = (v) => Math.round(parseFloat(v) || 0);
    const out = {
      top: read(cs.paddingTop),
      right: read(cs.paddingRight),
      bottom: read(cs.paddingBottom),
      left: read(cs.paddingLeft),
    };
    probe.remove();
    return out;
  });

  console.log(
    `\n  umetci: gore ${insets.top}px · desno ${insets.right}px · dolje ${insets.bottom}px · lijevo ${insets.left}px`,
  );

  const layout = await page.evaluate(() => {
    const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const sub = document.querySelector('.welcome-sub');
    const lineHeight = sub ? parseFloat(getComputedStyle(sub).lineHeight) : 0;
    const main = rect('.main');

    return {
      viewport: window.innerWidth,
      /* Odzumiranje je prvi znak da je nešto razvuklo shell preko ekrana. */
      documentWidth: document.documentElement.scrollWidth,
      titlebarPadTop: Math.round(
        parseFloat(getComputedStyle(document.querySelector('.titlebar')).paddingTop) || 0,
      ),
      mainWidth: Math.round(main?.width ?? 0),
      mainLeft: Math.round(main?.left ?? -1),
      subLines: sub && lineHeight ? Math.round(sub.scrollHeight / lineHeight) : 0,
      titleVisible: !!document.querySelector('.titlebar-title')?.getClientRects().length,
      /* Navigacija je gore; okomite trake uz rub više nema. */
      railVisible: !!document.querySelector('.activitybar')?.getClientRects().length,
      viewButtons: [...document.querySelectorAll('.view-btn')].map((b) =>
        b.getAttribute('aria-label'),
      ),
      desktopOnlyVisible: [...document.querySelectorAll('.desktop-only')].filter(
        (b) => b.getClientRects().length,
      ).length,
    };
  });

  console.log(`  viewport: ${layout.viewport}px · glavno područje: ${layout.mainWidth}px\n`);

  check(
    'medijski upit za uski ekran je aktivan',
    layout.viewport <= 720,
    `viewport ${layout.viewport}px`,
  );

  /*
   * Sadržaj koji se ne da stisnuti razvuče grid preko ekrana, a WebView tada
   * odzumira **cijelu** stranicu — `innerWidth` naraste s 392 na 591 px i
   * dodiri padnu pokraj gumba. Točno se to dogodilo s otvorenim PDF-om.
   */
  check(
    'ništa ne razvlači stranicu preko širine ekrana',
    layout.documentWidth <= layout.viewport,
    `dokument ${layout.documentWidth}px, ekran ${layout.viewport}px`,
  );

  check('navigacija je gore, okomite trake uz rub nema', !layout.railVisible);

  check(
    'pogledi su u naslovnoj traci',
    layout.viewButtons.length >= 2,
    layout.viewButtons.join(' · '),
  );

  /* Mape su desktop metafora; knjižnica ih na telefonu zamjenjuje u cijelosti. */
  check(
    'desktop radnje se na telefonu ne nude',
    layout.desktopOnlyVisible === 0,
    `${layout.desktopOnlyVisible} vidljivih`,
  );

  check('glavno područje koristi punu širinu', layout.mainWidth >= layout.viewport - 2);
  check('glavno područje počinje od lijevog ruba', layout.mainLeft === 0);

  check(
    'opis se ne lomi na jednu riječ po retku',
    layout.subLines > 0 && layout.subLines <= 5,
    `${layout.subLines} redaka`,
  );

  check('naziv dokumenta je maknut iz naslovne trake', !layout.titleVisible);

  check(
    'naslovna traka poštuje umetak odozgo',
    layout.titlebarPadTop === insets.top,
    `padding ${layout.titlebarPadTop}px, umetak ${insets.top}px`,
  );

  /* ── ploča pada odozgo ──────────────────────────────────────────────── */

  await page.locator('.view-btn').first().click();
  await page.waitForSelector('.sidebar', { timeout: 8000 });

  const panel = await page.evaluate(() => {
    const el = document.querySelector('.sidebar').getBoundingClientRect();
    const body = document.querySelector('.shell-body').getBoundingClientRect();
    return {
      top: Math.round(el.top - body.top),
      left: Math.round(el.left),
      width: Math.round(el.width),
      bottom: Math.round(el.bottom),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    };
  });

  check(
    'ploča pada odozgo, punom širinom',
    panel.top === 0 && panel.left === 0 && panel.width >= panel.viewportW - 2,
    `vrh ${panel.top}px, širina ${panel.width}px`,
  );

  /*
   * Ispod ploče mora ostati ploha koja se da pogoditi prstom — po njoj se
   * zatvara. Ranija izvedba sa strane ostavljala je 38 px, manje nego što
   * palac pouzdano pogodi.
   */
  const strip = panel.viewportH - panel.bottom;
  check('ispod ploče ostaje ploha za zatvaranje', strip >= 56, `${strip}px`);

  await deviceScreenshot(resolve(SHOTS, 'mobile-panel.png'));

  await page.mouse.click(panel.viewportW / 2, panel.bottom + strip / 2);
  await page.waitForTimeout(400);
  check('dodir ispod ploče ju zatvara', (await page.locator('.sidebar').count()) === 0);

  await deviceScreenshot(resolve(SHOTS, 'mobile-welcome.png'));
} catch (err) {
  check('izvođenje bez iznimke', false, err instanceof Error ? err.message : String(err));
  await deviceScreenshot(resolve(SHOTS, 'failure-mobile.png')).catch(() => {});
} finally {
  await stopDevice(session);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} provjera prošlo`);
process.exit(failed.length === 0 ? 0 : 1);
