/**
 * Priprema OCR resursa za posluživanje iz same aplikacije.
 *
 * Tesseract po zadanom skida worker, wasm jezgru i jezične modele s CDN-a.
 * To pada na dvije stvari koje ovaj projekt namjerno ima:
 *
 * 1. **CSP desktop verzije** dopušta `connect-src 'self'`. Vanjski dohvat je
 *    blokiran, i to s pravom — labavljenje CSP-a zbog jedne značajke plaćaju
 *    svi korisnici, zauvijek.
 * 2. **Rad bez mreže.** Editor koji traži internet da bi pročitao tekst sa
 *    slike na tuđem laptopu u zrakoplovu nije alat nego demo.
 *
 * Zato sve ide u `public/ocr/`, odakle se poslužuje s istog izvora.
 *
 *   node tools/ocr-assets.mjs
 */

import { access, copyFile, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/shell-ui/public/ocr');

/** pnpm izolira ovisnosti po paketu, pa `require.resolve` iz korijena ne vidi sve. */
const SEARCH = [
  resolve(ROOT, 'packages/shell-ui/node_modules'),
  resolve(ROOT, 'packages/editor-image/node_modules'),
  resolve(ROOT, 'node_modules'),
];

/** Model `fast` je ~4× manji od punog, uz zanemarivu razliku na čistom tekstu. */
const LANGUAGE_VARIANT = '4.0.0_best_int';

async function packageDir(name) {
  for (const base of SEARCH) {
    const candidate = join(base, name);
    try {
      await access(join(candidate, 'package.json'));
      return candidate;
    } catch {
      // Sljedeće mjesto.
    }
  }
  throw new Error(`Paket ${name} nije pronađen. Pokreni pnpm install.`);
}

async function copyInto(from, to, files) {
  for (const file of files) {
    await copyFile(join(from, file), join(to, file));
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  /* Worker: skripta koju tesseract.js pokreće u web workeru. */
  const worker = await packageDir('tesseract.js');
  await copyInto(join(worker, 'dist'), OUT, ['worker.min.js']);

  /*
   * Jezgra.
   *
   * Motor radi s `oem: 1` (LSTM), pa idu samo LSTM varijante — sve tri, jer
   * izbor između obične, SIMD i relaxed-SIMD ovisi o tome što preglednik
   * podržava, a to se ne zna unaprijed.
   *
   * Uzima se `.wasm.js` oblik: to je ono što worker doslovno traži kroz
   * `importScripts`, i nosi wasm u sebi, pa zaseban `.wasm` nije potreban.
   */
  /*
   * Jezgra se traži uz sam `tesseract.js`, ne zasebno: worker i wasm moraju
   * biti iz istog izdanja. Zasebna instalacija zna povući drugu verziju, a
   * neslaganje se vidi tek u runtimeu kao `importScripts` koji ne nalazi
   * datoteku.
   */
  const core = join(dirname(await realpath(worker)), 'tesseract.js-core');
  const coreFiles = (await readdir(core)).filter((name) =>
    /^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(name),
  );
  if (coreFiles.length !== 3) {
    throw new Error(`Očekujem tri LSTM jezgre, našao ${coreFiles.length}: ${coreFiles.join(', ')}`);
  }
  await copyInto(core, OUT, coreFiles);

  /* Jezični modeli. Tesseract ih traži kao `<lang>.traineddata.gz`. */
  const languages = ['eng', 'hrv'];
  for (const lang of languages) {
    const dir = await packageDir(`@tesseract.js-data/${lang}`);
    await copyFile(
      join(dir, LANGUAGE_VARIANT, `${lang}.traineddata.gz`),
      join(OUT, `${lang}.traineddata.gz`),
    );
  }

  /* Popis onoga što je stvarno kopirano — provjere ga čitaju umjesto da
     pogađaju imena datoteka koja ovise o verziji tesseract.js-core. */
  const entries = await readdir(OUT);
  await writeFile(
    join(OUT, 'manifest.json'),
    JSON.stringify({ languages, files: entries.filter((n) => n !== 'manifest.json') }, null, 2),
  );

  let total = 0;
  for (const entry of entries) total += (await stat(join(OUT, entry))).size;

  console.log(`OCR resursi u packages/shell-ui/public/ocr — ${entries.length} datoteka, ${(total / 1024 / 1024).toFixed(1)} MB`);
  console.log(`jezici: ${languages.join(', ')}`);
}

await main();
