/**
 * The update manifest — `latest.json`, composed from a release that already
 * exists.
 *
 * **Why this is not left to `tauri-action`.** One tag runs four desktop
 * builders, and each of them would write a `latest.json` of its own describing
 * the one platform it built. Whichever finished last would be the one on the
 * release page, and the other three platforms would quietly stop seeing
 * updates — a failure with no error anywhere, discovered weeks later by
 * somebody whose Mac never offered them anything. So the manifest is written
 * once, after every builder has finished, out of what is actually attached to
 * the release.
 *
 * **What Tauri expects.** A version, and a `platforms` map keyed by
 * `<os>-<arch>`, each with the URL of an artefact and the signature of that
 * exact file. The signature is the whole point: the application refuses an
 * update that does not verify against the public key compiled into it, so a
 * manifest with a stale signature is a manifest that installs nothing. That is
 * why the `.sig` files are read from the release rather than from a build
 * directory — the bytes on the release page are the bytes that will be
 * downloaded.
 *
 * The mapping from file names to platforms is the part worth checking without a
 * network, so it lives in `manifestFrom` and is checked in
 * `verify-updates.mjs`.
 *
 *   node tools/updater-manifest.mjs v0.3.4
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Which artefact serves which platform.
 *
 * Windows updates through the NSIS installer rather than the MSI: the MSI
 * cannot replace a running program without a restart it schedules itself, and
 * Tauri's own updater is built around the `-setup.exe`. macOS updates through
 * the `.app.tar.gz` — the `.dmg` is what a person downloads by hand, and there
 * is no way to install one silently. Linux updates through the AppImage, which
 * is the only one of the three Linux packages a program can replace on its own:
 * a `.deb` and an `.rpm` need root.
 */
const PLATFORMS = [
  { key: 'windows-x86_64', matches: (name) => /_x64-setup\.exe$/.test(name) },
  { key: 'darwin-aarch64', matches: (name) => /_aarch64\.app\.tar\.gz$/.test(name) },
  { key: 'darwin-x86_64', matches: (name) => /_x64\.app\.tar\.gz$/.test(name) },
  { key: 'linux-x86_64', matches: (name) => /_amd64\.AppImage$/.test(name) },
];

/**
 * The manifest, out of a list of asset names and the signatures beside them.
 *
 * Pure on purpose: the interesting part is the mapping and what it does when a
 * platform is missing, and neither needs a release to exist.
 *
 * @param {{ tag: string, version: string, assets: string[],
 *           signatureOf: (name: string) => string | null,
 *           repository: string, pubDate?: string, notes?: string }} input
 */
export function manifestFrom(input) {
  const { tag, version, assets, signatureOf, repository } = input;
  const platforms = {};
  const missing = [];

  for (const platform of PLATFORMS) {
    const name = assets.find((asset) => platform.matches(asset));
    if (!name) {
      missing.push(platform.key);
      continue;
    }

    /* An artefact with no signature beside it is left out rather than listed:
       a platform in the manifest without a signature is an update every
       application on that platform will download and then refuse, which is
       worse than not being offered one. */
    const signature = signatureOf(`${name}.sig`);
    if (!signature) {
      missing.push(platform.key);
      continue;
    }

    platforms[platform.key] = {
      signature: signature.trim(),
      url: `${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
    };
  }

  return {
    manifest: {
      version: version.replace(/^v/, ''),
      notes: input.notes ?? `See ${repository}/releases/tag/${tag}`,
      pub_date: input.pubDate ?? new Date().toISOString(),
      platforms,
    },
    missing,
  };
}

/* ── the command line ────────────────────────────────────────────────── */

/** `gh` rather than a token and `fetch`: the release may still be a draft. */
function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function main() {
  const tag = process.argv[2] ?? process.env.TAG;
  if (!tag) {
    console.error('Usage: node tools/updater-manifest.mjs <tag>');
    process.exit(2);
  }

  const repository = (process.env.REPOSITORY ?? 'https://github.com/JoskoLatin/ulEditor').replace(
    /\/$/,
    '',
  );
  const slug = repository.replace(/^https:\/\/github\.com\//, '');

  const release = JSON.parse(gh(['release', 'view', tag, '--json', 'assets,name,body']));
  const assets = release.assets.map((asset) => asset.name);
  const ids = new Map(release.assets.map((asset) => [asset.name, asset.id ?? null]));

  /* A signature is a few hundred bytes of base64, and there are at most four of
     them, so they are simply fetched one at a time. Through the API rather than
     the browser URL: a draft release is not public, and the browser URL would
     answer with a login page that parses as a perfectly good signature. */
  const cache = new Map();
  const signatureOf = (name) => {
    if (cache.has(name)) return cache.get(name);
    if (!assets.includes(name)) {
      cache.set(name, null);
      return null;
    }
    let text = null;
    try {
      const id = ids.get(name);
      if (id) {
        text = gh([
          'api',
          '-H',
          'Accept: application/octet-stream',
          `/repos/${slug}/releases/assets/${id}`,
        ]);
      }
    } catch (err) {
      console.error(`could not read ${name}: ${err instanceof Error ? err.message : err}`);
    }
    cache.set(name, text);
    return text;
  };

  const version = tag.replace(/^v/, '');
  const { manifest, missing } = manifestFrom({
    tag,
    version,
    assets,
    signatureOf,
    repository,
    notes: `${repository}/releases/tag/${tag}`,
  });

  const platforms = Object.keys(manifest.platforms);
  if (platforms.length === 0) {
    console.error(
      'No signed artefact is attached to this release, so there is no manifest to write.\n' +
        'That is what happens when TAURI_SIGNING_PRIVATE_KEY is missing — see docs/RELEASE.md.',
    );
    process.exit(1);
  }

  const path = join(tmpdir(), 'latest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`latest.json for ${tag}: ${platforms.join(', ')}`);
  if (missing.length > 0) {
    console.log(`::warning::no signed artefact for ${missing.join(', ')} — they will see no update`);
  }

  gh(['release', 'upload', tag, path, '--clobber']);
  console.log('uploaded');
}

/* Imported by the check, run by the release. */
if (process.argv[1] && process.argv[1].endsWith('updater-manifest.mjs')) main();
