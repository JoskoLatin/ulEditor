/**
 * Preparing the OCR assets to be served from the application itself.
 *
 * By default Tesseract downloads its worker, wasm core and language models from a
 * CDN. That breaks two things this project has on purpose:
 *
 * 1. **The desktop CSP** allows `connect-src 'self'`. External fetching is
 *    blocked, and rightly so — loosening the CSP for one feature is paid for by
 *    every user, forever.
 * 2. **Working offline.** An editor that needs the internet to read text off an
 *    image on somebody else's laptop on a plane is a demo, not a tool.
 *
 * So everything goes into `public/ocr/`, from where it is served on the same
 * origin.
 *
 *   node tools/ocr-assets.mjs
 */

import { access, copyFile, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/shell-ui/public/ocr');

/** pnpm isolates dependencies per package, so `require.resolve` from the root does not see everything. */
const SEARCH = [
  resolve(ROOT, 'packages/shell-ui/node_modules'),
  resolve(ROOT, 'packages/editor-image/node_modules'),
  resolve(ROOT, 'node_modules'),
];

/** The `fast` model is about 4× smaller than the full one, with a negligible difference on clean text. */
const LANGUAGE_VARIANT = '4.0.0_best_int';

async function packageDir(name) {
  for (const base of SEARCH) {
    const candidate = join(base, name);
    try {
      await access(join(candidate, 'package.json'));
      return candidate;
    } catch {
      // The next location.
    }
  }
  throw new Error(`Package ${name} was not found. Run pnpm install.`);
}

async function copyInto(from, to, files) {
  for (const file of files) {
    await copyFile(join(from, file), join(to, file));
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  /* The worker: the script tesseract.js runs inside a web worker. */
  const worker = await packageDir('tesseract.js');
  await copyInto(join(worker, 'dist'), OUT, ['worker.min.js']);

  /*
   * The core.
   *
   * The engine runs with `oem: 1` (LSTM), so only the LSTM variants go in — all
   * three, because the choice between plain, SIMD and relaxed-SIMD depends on
   * what the browser supports, and that is not known in advance.
   *
   * The `.wasm.js` form is taken: that is what the worker literally asks for
   * through `importScripts`, and it carries the wasm inside, so a separate
   * `.wasm` is not needed.
   */
  /*
   * The core is looked for beside `tesseract.js` itself, not separately: the
   * worker and the wasm have to come from the same release. A separate install
   * tends to pull a different version, and the mismatch shows up only at runtime
   * as an `importScripts` that cannot find its file.
   */
  const core = join(dirname(await realpath(worker)), 'tesseract.js-core');
  const coreFiles = (await readdir(core)).filter((name) =>
    /^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(name),
  );
  if (coreFiles.length !== 3) {
    throw new Error(`Expected three LSTM cores, found ${coreFiles.length}: ${coreFiles.join(', ')}`);
  }
  await copyInto(core, OUT, coreFiles);

  /* The language models. Tesseract asks for them as `<lang>.traineddata.gz`. */
  const languages = ['eng', 'hrv'];
  for (const lang of languages) {
    const dir = await packageDir(`@tesseract.js-data/${lang}`);
    await copyFile(
      join(dir, LANGUAGE_VARIANT, `${lang}.traineddata.gz`),
      join(OUT, `${lang}.traineddata.gz`),
    );
  }

  /* A listing of what was actually copied — the checks read it instead of
     guessing file names that depend on the tesseract.js-core version. */
  const entries = await readdir(OUT);
  await writeFile(
    join(OUT, 'manifest.json'),
    JSON.stringify({ languages, files: entries.filter((n) => n !== 'manifest.json') }, null, 2),
  );

  let total = 0;
  for (const entry of entries) total += (await stat(join(OUT, entry))).size;

  console.log(`OCR assets in packages/shell-ui/public/ocr — ${entries.length} files, ${(total / 1024 / 1024).toFixed(1)} MB`);
  console.log(`jezici: ${languages.join(', ')}`);
}

await main();
