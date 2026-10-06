/**
 * Signs a release's update artefacts, and checks every signature before any of
 * them goes anywhere.
 *
 * This runs in the release's signing job and nowhere else. That job is the only
 * one the update key is given to, and it builds nothing: the installers come
 * into it as files from builders that never saw the key, so no build script,
 * npm package or restored cache was ever in a position to sign something of
 * its own. See `.github/workflows/release.yml`.
 *
 * Every signature is then verified against a public key — the one compiled into
 * the application unless another is given. A secret that is not the
 * application's key would otherwise sign a release every installed copy
 * refuses, in silence; it fails here instead, before anything is published.
 *
 *   node tools/sign-updates.mjs <folder> [--pubkey <base64 of the public key file>]
 *
 * The private key is read the way `tauri signer sign` reads it, from
 * `TAURI_SIGNING_PRIVATE_KEY` (its contents) and
 * `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPublicKey, verifySignature } from './update-signature.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What a release signs: what Tauri signed when it signed at build time — every
 * package a program could update from, the `.dmg` excepted, which is only ever
 * opened by a person.
 */
export const SIGNED = /(\.msi|-setup\.exe|\.deb|\.rpm|\.AppImage|\.app\.tar\.gz)$/;

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--pubkey');
  const given = at >= 0 ? args.splice(at, 2)[1] : null;
  const folder = args[0];
  if (!folder || (at >= 0 && !given)) {
    console.error('Usage: node tools/sign-updates.mjs <folder> [--pubkey <base64>]');
    process.exit(2);
  }

  const conf = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const { bytes: publicKey } = readPublicKey(given ?? conf.plugins?.updater?.pubkey ?? '');

  const names = readdirSync(folder).filter((name) => SIGNED.test(name)).sort();
  if (names.length === 0) {
    console.error(`Nothing to sign in ${folder}.`);
    process.exit(1);
  }

  /* The CLI as the JavaScript file it is, from the desktop package: the same
     signer version the application was built with, not whatever is on PATH. */
  const tauriCli = createRequire(join(ROOT, 'apps/desktop/package.json')).resolve(
    '@tauri-apps/cli/tauri.js',
  );

  let failed = 0;
  for (const name of names) {
    const file = join(folder, name);
    execFileSync(process.execPath, [tauriCli, 'signer', 'sign', file], { stdio: 'pipe' });
    const { ok, reason } = verifySignature(
      readFileSync(file),
      readFileSync(`${file}.sig`, 'utf8'),
      publicKey,
    );
    console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}  — ${reason}`);
    if (!ok) failed++;
  }

  if (failed) {
    console.error(
      `\n${failed} of ${names.length} signatures do not verify against the key the application carries. ` +
        'Nothing has been published; see docs/RELEASE.md, "The update key".',
    );
    process.exit(1);
  }
  console.log(`\n${names.length} artefacts signed and verified.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
