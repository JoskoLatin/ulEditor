# Releases

One tag produces one release, and it holds both the desktop installers and the
phone APK. Desktop and Android are not separate versions of the project — the
same Rust ([crates/ul-core/](../crates/ul-core/),
[crates/ul-formats/](../crates/ul-formats/)) and the same frontend
([packages/shell-ui/](../packages/shell-ui/)) go to both, and
[gen/android/](../apps/desktop/src-tauri/gen/android/) is only a wrapper Tauri
generates from the same configuration. They part ways at the very end, as files
the user downloads.

All of it is built by [.github/workflows/release.yml](../.github/workflows/release.yml).

## What one tag produces

| File | For whom |
| --- | --- |
| `ulEditor_0.2.0_x64_en-US.msi`, `ulEditor_0.2.0_x64-setup.exe` | Windows |
| `ulEditor_0.2.0_aarch64.dmg`, `ulEditor_0.2.0_x64.dmg` | macOS |
| `ulEditor_0.2.0_amd64.deb`, `ulEditor_0.2.0_amd64.AppImage`, `ulEditor-0.2.0-1.x86_64.rpm` | Linux |
| `ulEditor_0.2.0_android.apk` | A phone, installed directly |
| `ulEditor_0.2.0_android.aab` | Google Play, should it ever be needed |

Tauri also produces `ulEditor_x64.app.tar.gz` and `ulEditor_aarch64.app.tar.gz`.
Those are the macOS bundles for the built-in updater, not something a person
downloads — the `.dmg` is what a person downloads.

## One-time preparation: the signing key

Android refuses to install an unsigned release APK. The key is created once and
serves every future release.

```powershell
keytool -genkey -v -keystore uleditor-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias uleditor
```

Keep the file **outside the repository** and make a backup of it. This is not a
formality: lose the key and you can no longer publish an update to an app that is
already on someone else's phone — Android refuses an update signed with a
different key. The only way out is a new app under a new package name.

Then turn the key into text GitHub can store:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("uleditor-release.jks")) | Set-Clipboard
```

And enter four values under **Settings → Secrets and variables → Actions**:

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | whatever just landed in the clipboard |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `uleditor` |
| `ANDROID_KEY_PASSWORD` | the key password (usually the same one, with the `keytool` invocation above) |

Without `ANDROID_KEYSTORE_BASE64` the Android job stops immediately and says why.
The desktop installers are still built — a release does not fail because of the
phone.

## The update key

The program looks for a new version by itself, and installs one only if it was
signed with this key. That is the whole security model: the public half is
compiled into the application, the private half never leaves GitHub Secrets, and
an artefact that does not verify is refused before a byte of it runs. A hijacked
release page, a proxy rewriting the download, a DNS answer from somewhere else —
all of them end the same way.

The key is created once and serves every future release:

```powershell
pnpm --filter @uleditor/desktop exec tauri signer generate -w "$HOME/.tauri/uleditor-updater.key"
```

**One already exists** at `~/.tauri/uleditor-updater.key`, and its public half is
in [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) under
`plugins.updater.pubkey`. It has no passphrase; `-p "a passphrase"` on the
command above makes one that does, and then the second secret below is needed
too.

Two values under **Settings → Secrets and variables → Actions**:

| Secret | Contents |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the whole contents of `~/.tauri/uleditor-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase, or nothing at all for a key without one |

Keep the file **outside the repository** and back it up. This is not a
formality, and it is the same warning as for the Android key with a different
shape: lose the private half and every copy already installed stops seeing
updates, because each of them verifies against the public half compiled into
the build it is running. The only way out is a release with a new key, which
every existing installation has to be replaced by hand.

Before trusting a key for the first time — and again whenever `pubkey` in
`tauri.conf.json` changes — ask whether the two halves are actually a pair:

```powershell
pnpm verify:updater-key
```

It signs a throwaway file with the private key on this machine and verifies the
signature against the public key the application carries, then checks that the
same key refuses a file altered after signing. `verify-updates.mjs` names this
as the first thing that can be wrong with a self-updating program and cannot
check it, because the private half is not in the repository: every other part
can be right and every installation still refuse every update, in silence,
because the signature was made by a key the application does not trust. The two
halves being a pair is not visible by looking at them — a public key copied
beside the wrong private key passes every comparison and fails only on somebody
else's machine, which is why this signs rather than compares.

**Without the secret a release still happens.** The installers are built and
attached as always; only the `.sig` files and `latest.json` are missing, so the
program on somebody's machine simply never offers that version. A warning says
so in the log of the `The update manifest` job. That is deliberate: enabling
updater artifacts in `tauri.conf.json` unconditionally would make `tauri build`
refuse to build at all without a key, and a release that does not happen is a
much worse failure than one that is not offered as an update.

`latest.json` is written by one job after every builder has finished, out of
what is actually attached to the release — see
[tools/updater-manifest.mjs](../tools/updater-manifest.mjs). Four builders each
writing their own would leave whichever finished last on the page, and the other
three platforms would stop seeing updates with nothing logged anywhere.

Which artefact serves which platform is not a free choice: Windows updates
through the NSIS `-setup.exe` because an MSI cannot replace a running program,
macOS through the `.app.tar.gz` because a `.dmg` cannot be installed silently,
and Linux through the AppImage because a `.deb` needs root.

## Publishing

The version is decided in
[tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) — the installers,
the APK `versionCode` and the number beside the name in the window all read it
from there, so desktop and Android cannot drift apart.

It is also mirrored into `package.json`, `apps/desktop/package.json` and
`Cargo.toml`, because npm and cargo each insist on their own copy. Change all
four together; `pnpm verify:version` compares them and CI runs it, after one
release shipped with the root manifest a version behind.

```powershell
git tag v0.2.0
git push origin v0.2.0
```

The release is created as a **draft** — artefacts collect into it while the five
builders run, and you publish it once you have downloaded and tried them.

## When one builder fails

Re-running the failed job from the Actions page is right when the failure was the
runner's fault and nothing needs changing: it attaches to the same draft rather
than opening a second one.

It is the wrong move once the fix is a change to the workflow file itself. A
re-run takes the workflow from the tag, which is the version that just failed, so
the fix is not in it. Push the fix to `main` and start **Actions → Release → Run
workflow** instead:

| Field | Value |
| --- | --- |
| Use workflow from | `main` — this is the workflow file that will run |
| `tag` | `v0.2.0` — the existing tag, and the source that will be built |
| `platforms` | `android`, or `desktop`, or `all` |

The two are separate on purpose: the workflow comes from `main`, the source code
from the tag. So a rebuilt installer is built from the same commit as the ones
already in the release, with a workflow that works. The finished platforms are
left alone, and what is rebuilt overwrites its own files in the draft.

## What the installer registers

The installers register ulEditor for about sixty extensions — Markdown, plain
text, source files, PDF, EPUB, Word, Excel, SVG, 3D models and images — which is
what puts it in **Open with** and in the "choose an app for this file type"
dialog. It does not become the default for anything: Windows 10 and 11 do not
let an installer take a file type over, and that is the right behaviour. The
person picks, once, and Windows remembers.

The registration alone would be worse than useless. A program that is offered
for `.pdf` and then opens an empty window has claimed something it cannot do,
so the desktop shell takes the path it is started with — from the command line
on Windows and Linux, from the `Opened` event on macOS, which never puts it on
the command line. A second double-click while the program is running reaches
the window that is already open rather than starting another copy of it.

None of this is exercised by CI: it lives in the installer, and the only honest
check is to install a build and double-click something.

## Building for Android locally

Nothing has changed for development —
[tools/android-dev.ps1](../tools/android-dev.ps1) still builds a *debug* APK and
needs no key at all:

```powershell
pnpm android:build
```

A signed *release* APK is produced locally only if
`apps/desktop/src-tauri/gen/android/keystore.properties` and the `.jks` it points
at both exist. While they do not, gradle quietly skips that part.
