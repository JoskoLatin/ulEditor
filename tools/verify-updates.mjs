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
 *   release that has no key — in a job of its own that builds nothing, while
 *   the builders hold no secret and the publishers no key;
 * - the manifest names artefacts the release actually contains, and leaves out
 *   a platform whose signature is missing rather than offering an update every
 *   application on it would refuse.
 *
 *   node tools/verify-updates.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assetEndpoint, manifestFrom } from './updater-manifest.mjs';

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

const capability = JSON.parse(read('apps/desktop/src-tauri/capabilities/desktop.json'));
const permissions = capability.permissions ?? [];
/* Every capability there is, found as Tauri finds them — every file under
   capabilities/, at any depth, and inline in every tauri*.conf.json — and in
   each shape a file may have: one capability, a list of them, or
   `{ "capabilities": [...] }`. So that neither permission can come back
   somewhere this does not look (the review of c144c3c). A file of a kind it
   cannot read — Tauri also reads JSON5 and TOML — is a failure of its own. */
const TAURI_DIR = join(ROOT, 'apps/desktop/src-tauri');
const under = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? under(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const capabilityFiles = under(join(TAURI_DIR, 'capabilities'));
const configFiles = readdirSync(TAURI_DIR)
  .filter((name) => /^tauri\b.*\.conf\.(json|json5|toml)$/i.test(name) || /^Tauri.*\.toml$/.test(name))
  .map((name) => join(TAURI_DIR, name));
const unreadable = [...capabilityFiles, ...configFiles].filter((path) => !path.endsWith('.json'));
const capabilitiesIn = (value) =>
  Array.isArray(value) ? value : Array.isArray(value?.capabilities) ? value.capabilities : [value];
const permissionsOf = (capability) =>
  typeof capability === 'string'
    ? []
    : (capability?.permissions ?? []).map((permission) =>
        typeof permission === 'string' ? permission : permission?.identifier,
      );
const everyPermission = [
  ...capabilityFiles
    .filter((path) => path.endsWith('.json'))
    .flatMap((path) => capabilitiesIn(JSON.parse(readFileSync(path, 'utf8')))),
  ...configFiles
    .filter((path) => path.endsWith('.json'))
    .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')).app?.security?.capabilities ?? []),
].flatMap(permissionsOf);
/* The plugin's own `check` takes a proxy from whoever calls it, and a proxy
   named by script in the page carries what it read out of the program from
   Rust, where the CSP does not reach. The page asks through the core's own two
   commands instead, which take nothing from it. */
check(
  'the page has no updater permission of its own',
  !permissions.some((name) => name.startsWith('updater:')),
  permissions.join(', '),
);
/* Nor may it restart the program: a page that could would start every
   question paced "for the session" afresh (the review of 46418d0). The core
   restarts it itself, once an update is in place — an update installed but
   not running is an update nobody sees. */
check(
  'the page may not restart the program',
  !permissions.some((name) => name.startsWith('process:')),
  permissions.join(', '),
);

/*
 * And the file says which platforms it applies to. Without that the Android
 * build fails in its build script: Tauri resolves every permission identifier
 * against the plugins actually compiled for the target, the updater is not one
 * of them there, and an unknown identifier is an error rather than a shrug. It
 * cost a red Android job on a change that had nothing to do with Android.
 */
check(
  'and the capability is declared desktop-only',
  Array.isArray(capability.platforms) &&
    ['linux', 'macOS', 'windows'].every((os) => capability.platforms.includes(os)) &&
    !capability.platforms.includes('android'),
  (capability.platforms ?? []).join(', '),
);
check(
  'every capability file is one this check can read',
  unreadable.length === 0,
  unreadable.map((path) => path.slice(ROOT.length + 1)).join(', '),
);
check(
  'while no capability anywhere grants the updater or a restart',
  !everyPermission.some((name) => /^(updater|process):/.test(name ?? '')),
  everyPermission.join(', '),
);

/* ── the Rust side ───────────────────────────────────────────────────── */

const lib = read('apps/desktop/src-tauri/src/lib.rs');
const install = lib.slice(lib.indexOf('async fn install_update('), lib.indexOf('/// A phone updates through its store.'));
check(
  'the core restarts it after an installed update',
  /download_and_install\([\s\S]*?\.await\s*\.map_err\([\s\S]*?\)\?;[\s\S]*app\.restart\(\)/.test(install),
);
check('the plugin is registered', lib.includes('tauri_plugin_updater::Builder::new()'));
/* The process plugin is what a page would restart the program through. It
   is not compiled in at all, so a permission naming it fails the build. */
check(
  'and the process plugin is not, in the core or the page',
  !lib.includes('tauri_plugin_process') &&
    !read('apps/desktop/src-tauri/Cargo.toml').includes('tauri-plugin-process') &&
    !read('packages/shell-ui/package.json').includes('@tauri-apps/plugin-process') &&
    !read('packages/shell-ui/src/host/native.ts').includes('plugin-process'),
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

/* With line endings made the same: a Windows checkout has CRLF, and the
   splitting below looks for "\njobs:\n". Read as it came, the Windows runner
   found no jobs at all and failed every check about them. */
const release = read('.github/workflows/release.yml').replace(/\r\n/g, '\n');

/* The jobs, each as its own text: a name two spaces in, and a colon. A key
   that is only in the right job is the whole point of the split, and it is a
   property of the file, so it is read off the file. */
const jobs = new Map();
{
  let current = null;
  for (const line of release.slice(release.indexOf('\njobs:\n')).split(/\r?\n/).slice(2)) {
    const named = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (named) {
      current = named[1];
      jobs.set(current, '');
    } else if (current) {
      jobs.set(current, `${jobs.get(current)}${line}\n`);
    }
  }
}
const job = (name) => jobs.get(name) ?? '';
const holding = (secret) =>
  [...jobs].filter(([, text]) => text.includes(`secrets.${secret}`)).map(([name]) => name);
const writers = [...jobs]
  .filter(([, text]) => /contents:\s*write|permissions:\s*write-all/.test(text))
  .map(([name]) => name)
  .sort();

check(
  'nothing in the release may write unless its job asks',
  /\npermissions: \{\}\r?\n/.test(release),
);
check(
  'the update key is given to the desktop signer and nothing else',
  holding('TAURI_SIGNING_PRIVATE_KEY').join() === 'desktop-sign',
  holding('TAURI_SIGNING_PRIVATE_KEY').join(', ') || 'no job',
);
check(
  'the Android key to the Android signer and nothing else',
  holding('ANDROID_KEYSTORE_BASE64').join() === 'android-sign',
  holding('ANDROID_KEYSTORE_BASE64').join(', ') || 'no job',
);
check(
  'the builders hold no secret at all',
  ['desktop-build', 'android-build'].every((name) => jobs.has(name) && !job(name).includes('secrets.')),
);
check(
  'the signers build nothing, and run no package scripts',
  ['desktop-sign', 'android-sign'].every((name) => !/tauri (android )?build|cargo /.test(job(name))) &&
    /pnpm install [^\n]*--ignore-scripts/.test(job('desktop-sign')),
);
check(
  'only the draft and the publishers may write to the repository',
  writers.join() === 'android-publish,create-release,desktop-publish',
  writers.join(', '),
);
check(
  'and none of them holds a signing key',
  writers.every((name) => !/secrets\.(TAURI_SIGNING|ANDROID_KEY)/.test(job(name))),
);
/* Any `cache:` key at all, not only pnpm's: setup-java v6 turns a JDK cache on
   with `cache:` or `cache-jdk:`, and the Android signer would then run a
   keytool restored from what a CI run on main wrote (found by the independent
   review of the setup-java 6 pin). */
check(
  'nothing restored from a cache goes into a release',
  !/uses: (Swatinem\/rust-cache|actions\/cache)|^\s*cache(-[a-z]+)?:/m.test(release),
  'a cache is written by other runs',
);
check(
  'a builder checks out without leaving a token for the build to find',
  ['desktop-build', 'android-build'].every(
    (name) =>
      (job(name).match(/uses: actions\/checkout@/g) ?? []).length ===
      (job(name).match(/persist-credentials: false/g) ?? []).length,
  ),
);
check(
  'a signer installs only the signer, and runs no package scripts',
  (job('desktop-sign').match(/pnpm install[^\n]*/g) ?? []).every(
    (line) => line.includes('--ignore-scripts') && line.includes('--filter'),
  ),
);
check(
  'and runs nothing a builder handed on',
  /* Every place a signer names what came from a builder is one of these —
     read, signed, removed — and nothing else, however it might be run. */
  ['desktop-sign', 'android-sign'].every((name) =>
    (job(name).match(/\bdist(-android)?\/[^\s"')]*/g) ?? []).every((token) =>
      ['dist/', 'dist/*.app.tar.gz', 'dist-android/unsigned.apk', 'dist-android/unsigned.aab'].includes(token),
    ),
  ) && !/(node|sh|bash|pwsh)\s+(\.\/)?dist/.test(job('desktop-sign') + job('android-sign')),
);
check(
  'what a builder handed on is checked to be installers and nothing else, signed or not',
  /node tools\/sign-updates\.mjs dist --unsigned/.test(job('desktop-sign')),
  "a builder's own latest.json or .sig must not reach the release",
);
check(
  'the Android secrets are in no step of a trial run',
  (job('android-sign').match(/secrets\.ANDROID_/g) ?? []).length ===
    (job('android-sign').match(/publish == 'true' && secrets\.ANDROID_/g) ?? []).length,
);
check(
  "an APK is checked to be signed with the release's certificate",
  /RELEASE_CERTIFICATE: [0-9a-f]{64}/.test(job('android-sign')) &&
    job('android-sign').includes('"$signed_with" != "$RELEASE_CERTIFICATE"') &&
    /* And reading nothing fails too, in a trial as well: apksigner names its
       signers differently from one build-tools to the next. */
    job('android-sign').includes('[ -z "$signed_with" ]'),
  'a keystore that is not the release key signs an APK no phone takes as an update',
);
check(
  'and no v4 signature file goes on the release page with it',
  job('android-sign').includes('--v4-signing-enabled false'),
);
check(
  'a release is signed in the release environment',
  ['desktop-sign', 'android-sign'].every((name) =>
    job(name).includes("environment: ${{ needs.plan.outputs.publish == 'true' && 'release' || 'trial' }}"),
  ),
);
check(
  'updater artifacts are asked for by the builder, never by tauri.conf.json',
  /createUpdaterArtifacts=true/.test(job('desktop-build')) &&
    !JSON.stringify(conf.bundle).includes('createUpdaterArtifacts'),
  'on in the file, a build without a key would fail instead of merely offering no update',
);
check(
  "every signature is checked against the application's key before anything is published",
  /node tools\/sign-updates\.mjs dist\r?\n/.test(job('desktop-sign')) &&
    /needs: \[plan, create-release, desktop-sign\]/.test(job('desktop-publish')),
);
check(
  'the manifest is written once, after every builder',
  /needs: \[plan, desktop-build\]/.test(job('desktop-sign')) &&
    job('desktop-publish').includes('node tools/updater-manifest.mjs'),
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
/* Through host/native.ts, which holds every Tauri import of the shell as a
   dynamic one — verify-host.mjs checks that for all of them, in the bundle too. */
check(
  'the shell asks through the core, by the dynamic import the web bundle never holds',
  updates.includes('await native.core()') &&
    updates.includes("'check_update'") &&
    updates.includes("'install_update'") &&
    !read('packages/shell-ui/src/host/native.ts').includes('plugin-updater'),
);
/* The interface language picks which wording the core's question is in, never
   what it says — as for the trust question (trust.rs). */
check(
  "and the core's two commands take nothing from the page but a progress channel and the interface language",
  /async fn check_update\(\s*app: tauri::AppHandle,\s*updates: State<'_, Updates>,?\s*\)/.test(lib) &&
    /async fn install_update\(\s*app: tauri::AppHandle,\s*updates: State<'_, Updates>,\s*on_event: tauri::ipc::Channel<Downloading>,\s*ui_language: Option<String>,?\s*\)/.test(
      lib,
    ),
);
/* Card 515: script in the page could ask for an install with no click, and
   an install closes the program under the person. */
/* Read without its comments, which can name what the code no longer does
   (the review of c144c3c). */
const code = install.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const asks = code.indexOf('ask(&app, &asked');
const locked = code.indexOf('questions.0.try_lock()');
check(
  'and the core asks the person before an install, one question at a time, paced',
  code.includes('trust::update_question(') &&
    code.includes('may_ask(') &&
    code.includes('asking().declined(') &&
    locked >= 0 &&
    asks > locked &&
    asks < code.indexOf('download_and_install('),
);

/* Where the signatures are read from.

   Everything above tests the manifest out of signatures handed to it, which is
   the mapping worth checking without a network — and it passed happily while
   the release job could not read a single signature off the page. `gh` gives an
   asset two identifiers and only one of them works on the REST endpoint, so the
   choice between them is pinned here rather than discovered on the next
   release. */
const asset = {
  name: 'ulEditor_0.5.0_x64-setup.exe.sig',
  id: 'RA_kwDOT_zNdc4hYnH3',
  apiUrl: 'https://api.github.com/repos/JoskoLatin/ulEditor/releases/assets/560099831',
  url: 'https://github.com/JoskoLatin/ulEditor/releases/download/untagged-01af/x.sig',
};

check(
  'an asset is read through the URL carrying its numeric id',
  assetEndpoint(asset) === asset.apiUrl,
  assetEndpoint(asset) ?? 'nothing',
);

check(
  'the GraphQL node id is never made into a REST path',
  !String(assetEndpoint(asset)).includes(asset.id),
);

/* The browser URL would answer a draft release with a login page, and a login
   page is a perfectly good string — it would land in the manifest as a
   signature and every application would refuse the update it described. */
check(
  'the browser download URL is not used',
  assetEndpoint({ name: asset.name, apiUrl: asset.url }) === null,
);

check(
  'an asset with no usable URL yields nothing rather than a guess',
  assetEndpoint({ name: asset.name }) === null && assetEndpoint({}) === null,
);

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
