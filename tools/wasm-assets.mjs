/**
 * Building the Rust the browser runs, into `public/wasm/`.
 *
 * ADR 0002: `ul-image` goes to the browser as WebAssembly, so that a picture
 * can be edited in a tab with the same code the desktop uses. This builds it
 * and puts the result where Vite serves it from the application's own origin —
 * the same arrangement as `ocr-assets.mjs`, and for the same reasons: the CSP
 * allows `'self'`, and a plane has no network.
 *
 * **The CLI has to be the exact version of the crate.** `wasm-bindgen` writes
 * the JavaScript half of the bridge and the crate writes the Rust half; a CLI a
 * patch release apart produces glue that fails at load time, or worse, loads
 * and mis-reads. So the version is read out of `Cargo.lock` and a CLI that says
 * anything else is refused, with the line that installs the right one.
 * `wasm-pack` is not used: it wraps the same CLI and adds an npm scaffold that
 * nothing here needs.
 *
 * Only the desktop does without these files; its installer never runs this.
 *
 *   node tools/wasm-assets.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/shell-ui/public/wasm');
const TARGET = 'wasm32-unknown-unknown';

/** The crates the browser gets, and the name each one's glue is served under. */
const CRATES = [{ crate: 'ul-image', file: 'ul_image' }];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  return result;
}

const lock = await readFile(resolve(ROOT, 'Cargo.lock'), 'utf8');
/* Exactly one: with two versions locked, which one the glue must match is a
   question, and picking the first would answer it silently. */
const locked = [...lock.matchAll(/\[\[package\]\]\s*name = "wasm-bindgen"\s*version = "([^"]+)"/g)].map((m) => m[1]);
if (locked.length !== 1) {
  console.error(`Cargo.lock holds ${locked.length} versions of wasm-bindgen (${locked.join(', ')}) — it has to be exactly one`);
  process.exit(1);
}
const wanted = locked[0];

const cli = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
const have = /wasm-bindgen (\S+)/.exec(cli.stdout ?? '')?.[1];
if (have !== wanted) {
  console.error(
    `wasm-bindgen ${have ?? 'is not installed'}, and Cargo.lock asks for ${wanted}:\n` +
      `  cargo install wasm-bindgen-cli --version ${wanted} --locked`,
  );
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const manifest = { wasmBindgen: wanted, files: {} };
for (const { crate, file } of CRATES) {
  const build = run('cargo', ['build', '--locked', '-p', crate, '--target', TARGET, '--release']);
  if (build.status !== 0) {
    console.error(build.stderr);
    process.exit(1);
  }
  const wasm = resolve(ROOT, 'target', TARGET, 'release', `${file}.wasm`);
  const bind = run('wasm-bindgen', [wasm, '--target', 'web', '--no-typescript', '--out-dir', OUT]);
  if (bind.status !== 0) {
    console.error(bind.stderr);
    process.exit(1);
  }
  for (const name of [`${file}.js`, `${file}_bg.wasm`]) {
    const bytes = await readFile(join(OUT, name));
    manifest.files[name] = { bytes: (await stat(join(OUT, name))).size, gzip: gzipSync(bytes, { level: 9 }).length };
  }
}

await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`WebAssembly in packages/shell-ui/public/wasm — wasm-bindgen ${wanted}`);
for (const [name, size] of Object.entries(manifest.files)) {
  console.log(`  ${name.padEnd(20)} ${kb(size.bytes).padStart(8)}  ${kb(size.gzip).padStart(7)} gzipped`);
}
