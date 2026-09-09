/**
 * The updater, checked without downloading anything.
 *
 * Almost everything that can be wrong with a self-updating program is wrong
 * *before* any network is involved, and silently: a public key that does not
 * match the private one in Secrets, a permission that was never granted, a
 * manifest naming an artefact nobody builds. Each of those produces the same
 * symptom — no update ever arrives — and none of them produces an error
 * anybody sees.
 *
 * So the pieces are compared against each other here:
 *
 * - the endpoint is a release of *this* repository, and the page's own sandbox
 *   was **not** widened for it, because the request is made in Rust;
 * - the public key is present and is a minisign key rather than a placeholder;
 * - the window is allowed to check, install and restart;
 * - the plugin is registered in Rust, and desktop-only;
 * - the release workflow signs, and does it in a way that cannot break a
 *   release that has no key;
 * - the manifest names artefacts the release actually contains, and leaves out
 *   a platform whose signature is missing rather than offering an update every
 *   application on it would refuse.
 *
 *   node tools/verify-updates.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestFrom } from './updater-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? '  ok  ' : ' FAIL '}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const REPOSITORY = 'https://github.com/JoskoLatin/ulEditor';

/* ── the configuration ───────────────────────────────────────────────── */

const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
const updater = conf.plugins?.updater ?? null;

check('the updater is configured', updater !== null);

const endpoints = updater?.endpoints ?? [];
check(
  'it looks for the manifest in a release of this repository',
  endpoints.length > 0 && endpoints.every((url) => url.startsWith(`${REPOSITORY}/releases/`)),
  endpoints.join(' '),
);
check(
  'and the file it looks for is the one the release writes',
  endpoints.every((url) => url.endsWith('/latest.json')),
  endpoints.join(' '),
);

const pubkey = updater?.pubkey ?? '';
let decoded = '';
try {
  decoded = Buffer.from(pubkey, 'base64').toString('utf8');
} catch {
  decoded = '';
}
check(
  'a public key is compiled in, and it is a real one',
  pubkey.length > 40 && decoded.includes('minisign public key'),
  decoded.split('\n')[0] || '(nothing that decodes)',
);

/* ── the CSP, which this feature must not widen ──────────────────────── */

/*
 * The obvious thing to do here is wrong, and it was done and undone in the
 * writing of this file: the CSP was widened to let the window reach github.com.
 * It does not need to. The check and the download happen in **Rust** — the
 * plugin's JS is a wrapper over an IPC call — so `connect-src` never sees them,
 * and every host added to it would be a hole in the page's sandbox opened for a
 * request the page does not make. Loosening the CSP for one feature is paid for
 * by every user, forever, which is the same argument that put the OCR models on
 * our own origin.
 */
const csp = conf.app?.security?.csp ?? '';
const connect = /connect-src ([^;]*)/.exec(csp)?.[1] ?? '';

for (const host of ['github.com', 'githubusercontent.com']) {
  check(
    `the CSP was not widened to reach ${host}`,
    !connect.includes(host),
    'the updater asks from Rust, so the window needs no permission to',
  );
}
check(
  'and it still allows only what the page itself fetches',
  connect.includes("'self'") && connect.includes('http://ipc.localhost'),
  connect.trim(),
);

/* ── the permissions ─────────────────────────────────────────────────── */

const capabilities = JSON.parse(read('apps/desktop/src-tauri/capabilities/default.json'));
const permissions = capabilities.permissions ?? [];
check('the window may ask and install', permissions.includes('updater:default'));
check(
  'and may restart itself afterwards',
  permissions.includes('process:allow-restart'),
  'an update installed but not running is an update nobody sees',
);

/* ── the Rust side ───────────────────────────────────────────────────── */

const lib = read('apps/desktop/src-tauri/src/lib.rs');
check(
  'the plugin is registered',
  lib.includes('tauri_plugin_updater::Builder::new()') && lib.includes('tauri_plugin_process::init()'),
);
check(
  'and only where a program updates itself',
  /#\[cfg\(desktop\)\]\s*\n\s*let builder = builder\s*\n\s*\.plugin\(tauri_plugin_updater/.test(lib),
  'a phone updates through its store',
);

const cargo = read('apps/desktop/src-tauri/Cargo.toml');
check(
  'the dependency is desktop-only too',
  /\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies\][\s\S]{0,200}tauri-plugin-updater/.test(
    cargo,
  ),
);

/* ── the release ─────────────────────────────────────────────────────── */

const release = read('.github/workflows/release.yml');
check(
  'the release passes the signing key to the bundler',
  release.includes('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}'),
);
check(
  'updater artifacts are asked for only when there is a key to sign them with',
  release.includes("if: env.HAS_SIGNING_KEY == 'true'") &&
    !JSON.stringify(conf.bundle).includes('createUpdaterArtifacts'),
  'otherwise a release without the secret would fail instead of merely offering no update',
);
check(
  'the manifest is written once, after every builder',
  release.includes('needs: [create-release, desktop]') &&
    release.includes('node tools/updater-manifest.mjs'),
);
check(
  "and tauri-action is told not to write one of its own",
  release.includes('includeUpdaterJson: false'),
  'four builders each writing latest.json leaves one platform on the page',
);

/* ── the manifest itself, over a release that never happened ─────────── */

const version = conf.version;
const assets = [
  `ulEditor_${version}_x64-setup.exe`,
  `ulEditor_${version}_x64_en-US.msi`,
  `ulEditor_${version}_x64-setup.exe.sig`,
  'ulEditor_aarch64.app.tar.gz',
  'ulEditor_aarch64.app.tar.gz.sig',
  'ulEditor_x64.app.tar.gz',
  'ulEditor_x64.app.tar.gz.sig',
  `ulEditor_${version}_amd64.AppImage`,
  `ulEditor_${version}_amd64.AppImage.sig`,
  `ulEditor_${version}_amd64.deb`,
  `ulEditor_${version}_android.apk`,
];
const signatures = new Map(assets.filter((a) => a.endsWith('.sig')).map((a) => [a, `sig-of-${a}`]));

const { manifest, missing } = manifestFrom({
  tag: `v${version}`,
  version,
  assets,
  signatureOf: (name) => signatures.get(name) ?? null,
  repository: REPOSITORY,
  pubDate: '2026-01-01T00:00:00.000Z',
});

check(
  'every desktop platform is in the manifest',
  Object.keys(manifest.platforms).sort().join(',') ===
    'darwin-aarch64,darwin-x86_64,linux-x86_64,windows-x86_64',
  Object.keys(manifest.platforms).join(', '),
);
check(
  'Windows updates through the installer, not the MSI',
  manifest.platforms['windows-x86_64']?.url.endsWith('-setup.exe'),
  manifest.platforms['windows-x86_64']?.url ?? '',
);
check(
  'macOS updates through the app archive, not the disk image',
  manifest.platforms['darwin-aarch64']?.url.endsWith('.app.tar.gz'),
  manifest.platforms['darwin-aarch64']?.url ?? '',
);
check(
  'Linux updates through the AppImage, the only one that needs no root',
  manifest.platforms['linux-x86_64']?.url.endsWith('.AppImage'),
  manifest.platforms['linux-x86_64']?.url ?? '',
);
check('the version has no leading v', manifest.version === version, manifest.version);
check('nothing was reported missing', missing.length === 0, missing.join(', ') || 'nothing');

/* A release where one platform failed to sign: that platform must be left out,
   not listed without a signature. */
const partial = manifestFrom({
  tag: `v${version}`,
  version,
  assets: assets.filter((a) => a !== 'ulEditor_x64.app.tar.gz.sig'),
  signatureOf: (name) => (name === 'ulEditor_x64.app.tar.gz.sig' ? null : signatures.get(name) ?? null),
  repository: REPOSITORY,
});
check(
  'an artefact with no signature is left out rather than offered',
  partial.manifest.platforms['darwin-x86_64'] === undefined &&
    partial.missing.includes('darwin-x86_64'),
  partial.missing.join(', '),
);
check(
  'and the platforms that did sign are still offered',
  Object.keys(partial.manifest.platforms).length === 3,
  Object.keys(partial.manifest.platforms).join(', '),
);

/* ── the way in, for a person ────────────────────────────────────────── */

const commands = read('packages/shell-ui/src/shell/commands.ts');
const menus = read('packages/shell-ui/src/shell/menus.ts');
check(
  'there is a command for it',
  commands.includes("id: 'help.updates'") && commands.includes("id: 'help.updatesOnStart'"),
);
check(
  'both are in the Help menu, and the automatic one shows a tick',
  menus.includes("{ command: 'help.updates' }") && menus.includes("command: 'help.updatesOnStart'") &&
    menus.includes('checked: (shell: Shell) => checksOnStart(shell)'),
);

const updates = read('packages/shell-ui/src/shell/updates.ts');
check(
  'the check on start is silent, and at most once a day',
  updates.includes('silent: true') && updates.includes('24 * 60 * 60 * 1000'),
);
check(
  'the plugin is imported dynamically, so the web bundle never holds it',
  updates.includes("await import('@tauri-apps/plugin-updater')"),
);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
