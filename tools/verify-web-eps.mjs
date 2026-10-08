/**
 * An EPS **in a browser**, where no LibreOffice can run (ADR 0007).
 *
 * Two files, made here so that no real drawing is needed:
 *
 * - `crtez.eps`, a DOS EPS whose preview is a palette TIFF — eight-bit
 *   indices into a colour map, the way Illustrator saves one and the way the
 *   `image` crate refuses — with a red corner at the top-left. It has to show
 *   as that picture, corner where it was, decoded by the WebAssembly core,
 *   and be labelled as the preview it is, not the drawing.
 * - `program.ps`, plain PostScript with no preview: it has to show what its
 *   comments say and that this build does not run it.
 *
 * Neither may advise installing LibreOffice — there is nowhere to install it
 * — and the conversion command says only the desktop app converts. Nothing
 * may leave the origin.
 *
 *   node tools/wasm-assets.mjs
 *   pnpm --filter @uleditor/shell-ui build
 *   pnpm --filter @uleditor/shell-ui preview --port 5273
 *   node tools/verify-web-eps.mjs [--url http://localhost:5273]
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5273';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/* The picked folder, with the two files. */
const PICKER = () => {
  const ascii = (text) => new TextEncoder().encode(text);

  /* A 4×2 palette TIFF, little-endian, uncompressed, one strip: index 1 is
     red, index 0 white, and only the top-left pixel is red. */
  function paletteTiff() {
    const width = 4;
    const height = 2;
    const pixels = new Uint8Array(width * height);
    pixels[0] = 1;
    const map = new Uint16Array(768);
    map.fill(0xffff, 0, 1); // index 0: white
    map[256] = 0xffff;
    map[512] = 0xffff;
    map[1] = 0xffff; // index 1: red
    const entries = [
      [256, 3, 1, width],
      [257, 3, 1, height],
      [258, 3, 1, 8],
      [259, 3, 1, 1],
      [262, 3, 1, 3],
      [273, 4, 1, 0], // strip offset, filled in below
      [277, 3, 1, 1],
      [279, 4, 1, pixels.length],
      [320, 3, 768, 0], // colour map offset, filled in below
    ];
    const ifdLength = 2 + entries.length * 12 + 4;
    const mapAt = 8 + ifdLength;
    const stripAt = mapAt + map.length * 2;
    entries[5][3] = stripAt;
    entries[8][3] = mapAt;
    const out = new Uint8Array(stripAt + pixels.length);
    const view = new DataView(out.buffer);
    out.set(ascii('II*\0'));
    view.setUint32(4, 8, true);
    view.setUint16(8, entries.length, true);
    entries.forEach(([tag, type, count, value], i) => {
      const at = 10 + i * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    map.forEach((v, i) => view.setUint16(mapAt + i * 2, v, true));
    out.set(pixels, stripAt);
    return out;
  }

  const postscript = ascii(
    '%!PS-Adobe-3.0 EPSF-3.0\n%%Title: (Logo za letak)\n%%Creator: Illustrator\n%%BoundingBox: 0 0 4 2\nshowpage\n',
  );
  const tiff = paletteTiff();
  const eps = new Uint8Array(30 + postscript.length + tiff.length);
  const view = new DataView(eps.buffer);
  eps.set([0xc5, 0xd0, 0xd3, 0xc6]);
  view.setUint32(4, 30, true);
  view.setUint32(8, postscript.length, true);
  view.setUint32(20, 30 + postscript.length, true);
  view.setUint32(24, tiff.length, true);
  eps.set(postscript, 30);
  eps.set(tiff, 30 + postscript.length);

  window.showDirectoryPicker = async () => {
    const storage = await navigator.storage.getDirectory();
    await storage.removeEntry('crtezi', { recursive: true }).catch(() => {});
    const root = await storage.getDirectoryHandle('crtezi', { create: true });
    for (const [name, bytes] of [
      ['crtez.eps', eps],
      ['program.ps', ascii('%!PS-Adobe-3.0\n%%Title: (Plakat)\n%%Creator: (Ghostscript tester)\n%%CreationDate: (2024-05-01)\n%%BoundingBox: 0 0 595 842\nshowpage\n')],
    ]) {
      const out = await (await root.getFileHandle(name, { create: true })).createWritable();
      await out.write(bytes);
      await out.close();
    }
    return root;
  };
};

const browser = await chromium.launch();
/* Without the service worker, so that every request is seen here. */
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
const external = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (request) => {
  const u = new URL(request.url());
  if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) {
    external.push(request.url());
  }
});

async function open(name) {
  await page.keyboard.press('Control+p');
  await page.locator('.palette input').fill(name);
  await page.locator('.palette-item', { hasText: name }).first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.ul-vec')].some((v) => v.offsetParent !== null && v.textContent.includes(n)),
    name,
    { timeout: 30_000 },
  );
  return page.locator('.ul-vec:visible');
}

const NO_INSTALL = /Install it|Get LibreOffice|is not installed/;

try {
  await page.addInitScript(PICKER);
  await page.goto(url);
  await page.waitForSelector('.shell', { timeout: 30_000 });
  await page.keyboard.press('Control+k');
  await page.getByText('crtez.eps').first().waitFor({ timeout: 10_000 });

  /* ── the DOS EPS: its preview, labelled ───────────────────────────── */

  const eps = await open('crtez.eps');
  const shown = await eps
    .locator('.ul-vec-preview img')
    .waitFor({ timeout: 30_000 })
    .then(() => true, () => false);
  check('a DOS EPS shows the preview it carries', shown);
  if (shown) {
    await page.waitForFunction(() => document.querySelector('.ul-vec-preview img')?.naturalWidth > 0);
    const picture = await eps.locator('.ul-vec-preview img').evaluate((img) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
      return { width: img.naturalWidth, height: img.naturalHeight, corner: at(0, 0), far: at(3, 1) };
    });
    check('at its own size', picture.width === 4 && picture.height === 2, `${picture.width} × ${picture.height}`);
    check(
      'its colours looked up in its own map: the red corner at the top-left',
      picture.corner.join() === '255,0,0' && picture.far.join() === '255,255,255',
      `${picture.corner} / ${picture.far}`,
    );
  }
  const caption = (await eps.locator('.ul-vec-preview figcaption').textContent().catch(() => '')) ?? '';
  check('labelled as the preview, not the drawing', /not the drawing/.test(caption), caption);
  check("and the PostScript's own title beside it", (await eps.locator('.ul-vec-facts').textContent())?.includes('Logo za letak'));
  const epsText = (await eps.textContent()) ?? '';
  check('no advice to install LibreOffice', !NO_INSTALL.test(epsText));
  check('it says the desktop app converts this', /desktop app converts this format/.test(epsText));

  /* ── plain PostScript: what it says about itself ─────────────────── */

  const ps = await open('program.ps');
  await ps.locator('.ul-vec-facts').waitFor({ timeout: 10_000 });
  const facts = (await ps.locator('.ul-vec-facts').textContent()) ?? '';
  check(
    'plain PostScript shows its title, program and date',
    facts.includes('Plakat') && facts.includes('Ghostscript tester') && facts.includes('2024-05-01'),
    facts,
  );
  check('and says it is a program this build does not run', /does not run PostScript/.test((await ps.textContent()) ?? ''));
  check('with no preview where there is none', (await ps.locator('.ul-vec-preview').count()) === 0);

  /* ── the conversion command, asked for anyway ───────────────────── */

  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette input').fill('LibreOffice');
  await page.locator('.palette-item').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  const toast = page.locator('.toast', { hasText: 'Only the desktop app converts' });
  check(
    'the conversion says only the desktop app does it',
    await toast.first().waitFor({ timeout: 10_000 }).then(() => true, () => false),
  );
  check('and offers no download', (await page.locator('.toast', { hasText: NO_INSTALL }).count()) === 0);

  check('nothing left the origin', external.length === 0, external.join(', '));
  check('no error in the page', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('the run itself', false, err.message);
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
