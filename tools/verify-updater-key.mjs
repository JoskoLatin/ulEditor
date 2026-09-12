/**
 * The private half of the update key, checked against the public half the
 * application carries.
 *
 * `verify-updates.mjs` names this as the first thing that can be wrong with a
 * self-updating program and cannot check it: the public key compiled into the
 * build may simply not be the counterpart of the private key in Secrets. Every
 * other part can be right — the endpoint, the manifest, the permissions, the
 * plugin — and every installation still refuses every update, because the
 * signature is made by a key the application does not trust. Nothing logs it.
 * The update is declined before a byte of it runs, which is exactly what that
 * design is for, and the program on someone's machine simply stops getting
 * newer.
 *
 * It cannot live in `verify-updates.mjs` because the private key is not in the
 * repository and must never be: it exists on the machine of whoever publishes,
 * and in GitHub Secrets. So this is asked for by name, like the checks that
 * need Word or LibreOffice, and it is worth asking for once before trusting a
 * key for the first time — and again if `tauri.conf.json` ever gets a new
 * `pubkey`.
 *
 *   node tools/verify-updater-key.mjs
 *   node tools/verify-updater-key.mjs "D:/keys/uleditor-updater.key"
 *
 * The key is looked for at `~/.tauri/uleditor-updater.key` unless a path is
 * given. A passphrase, if the key has one, is read from
 * `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the same variable the release workflow
 * passes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * Both halves are minisign, and Tauri wraps each of them in base64 once more:
 * `tauri.conf.json` holds base64 of the public key *file*, and a `.sig` holds
 * base64 of the whole signature *file*. Decoding once gives the minisign text
 * in both cases — two comment lines and the payload between them.
 */
const unwrap = (text) => Buffer.from(text.trim(), 'base64').toString('utf8');
const payloadLines = (text) =>
  text.split(/\r?\n/).filter((line) => line && !/^(un)?trusted comment:/.test(line));

const conf = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const configured = conf.plugins?.updater?.pubkey ?? '';

let publicKey = null;
let commentedId = null;
try {
  const text = unwrap(configured);
  commentedId = /minisign public key:\s*([0-9A-Fa-f]{16})/.exec(text)?.[1] ?? null;
  publicKey = Buffer.from(payloadLines(text)[0] ?? '', 'base64');
} catch {
  publicKey = Buffer.alloc(0);
}

check(
  'the application carries an Ed25519 minisign public key',
  publicKey.length === 42 && publicKey.subarray(0, 2).toString('latin1') === 'Ed',
  `${publicKey.length} bytes, algorithm ${JSON.stringify(publicKey.subarray(0, 2).toString('latin1'))}`,
);

/**
 * minisign prints a key's id with its bytes the other way round from the way it
 * stores them. A pubkey pasted from one key under the comment line of another
 * would pass every other check here and fail only on somebody else's machine.
 */
const storedId = Buffer.from(publicKey.subarray(2, 10)).reverse().toString('hex').toUpperCase();
check(
  'the key id in its own comment line is the key underneath it',
  commentedId !== null && commentedId.toUpperCase() === storedId,
  `${commentedId ?? 'no comment line'} vs ${storedId}`,
);

const keyPath = process.argv[2] ?? join(homedir(), '.tauri', 'uleditor-updater.key');
const present = existsSync(keyPath);
check('there is a private key to check', present, keyPath);

if (!present) {
  console.log('\n  This machine has no update key. It is created once and kept outside the');
  console.log('  repository — see docs/RELEASE.md, "The update key". Pass the path as an');
  console.log('  argument if it is somewhere other than ~/.tauri/uleditor-updater.key.');
  console.log(`\n${checks.filter((c) => c.passed).length}/${checks.length} checks passed`);
  process.exit(1);
}

/**
 * `tauri signer generate` writes the public half beside the private one, in the
 * same base64 wrapping `tauri.conf.json` wants. Comparing the two is the whole
 * question in one line — the signing round trip below proves it rather than
 * trusting that the pair on disk was never edited.
 */
const beside = `${keyPath}.pub`;
check(
  'the public half beside it is the one in tauri.conf.json',
  existsSync(beside) && readFileSync(beside, 'utf8').trim() === configured.trim(),
  existsSync(beside) ? beside : `${beside} is missing`,
);

const scratch = mkdtempSync(join(tmpdir(), 'uleditor-updater-'));
const payload = join(scratch, 'payload.bin');
writeFileSync(payload, Buffer.from('an artefact that is about to be signed'));

/**
 * The CLI is run as the JavaScript file it is, rather than through `pnpm exec`:
 * on Windows the shim is a `.cmd`, and Node refuses to spawn one without a
 * shell. Resolving it from the desktop package also means this checks the same
 * signer version the release builds with, not whatever is on the PATH.
 */
const tauriCli = createRequire(join(ROOT, 'apps/desktop/package.json')).resolve('@tauri-apps/cli/tauri.js');

let signature = null;
try {
  execFileSync(
    process.execPath,
    [
      tauriCli, 'signer', 'sign',
      '-f', keyPath,
      '-p', process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
      payload,
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  signature = Buffer.from(payloadLines(unwrap(readFileSync(`${payload}.sig`, 'utf8')))[0], 'base64');
} catch (error) {
  check('the key signs', false, String(error.message ?? error).split('\n')[0]);
}

if (signature) {
  check('the key signs', true, `${signature.length} bytes`);

  check(
    'the signature names the key the application trusts',
    signature.subarray(2, 10).equals(publicKey.subarray(2, 10)),
    `${signature.subarray(2, 10).toString('hex')} vs ${publicKey.subarray(2, 10).toString('hex')}`,
  );

  /**
   * "ED" signs a BLAKE2b-512 hash of the file, "Ed" the file itself. Tauri
   * produces the first; both are read here so a change in its CLI shows up as a
   * failure to verify rather than silently checking the wrong bytes.
   */
  const prehashed = signature.subarray(0, 2).toString('latin1') === 'ED';
  const digest = (bytes) => (prehashed ? createHash('blake2b512').update(bytes).digest() : bytes);
  const ed25519 = createPublicKey({
    // SubjectPublicKeyInfo for Ed25519 is a fixed 12-byte prefix and the key.
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.subarray(10)]),
    format: 'der',
    type: 'spki',
  });

  const content = readFileSync(payload);
  check(
    'a signature made with this key verifies against that public key',
    verify(null, digest(content), ed25519, signature.subarray(10)),
    prehashed ? 'prehashed, BLAKE2b-512' : 'over the file itself',
  );

  /**
   * Without this the check above proves only that something was computed: a
   * verifier that returns true for everything would pass it.
   */
  check(
    'the same key refuses a file that was altered after signing',
    !verify(null, digest(Buffer.concat([content, Buffer.from('!')])), ed25519, signature.subarray(10)),
  );
}

rmSync(scratch, { recursive: true, force: true });

const failed = checks.filter((c) => !c.passed);
if (failed.length) {
  console.log('\n  An update signed by this key would be refused by every installation of');
  console.log('  the build in this working tree. Either the key is not the one this');
  console.log('  application was built to trust, or `pubkey` in tauri.conf.json is not');
  console.log('  the public half of the key that will sign. docs/RELEASE.md explains');
  console.log('  what each half is for and what losing one costs.');
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
