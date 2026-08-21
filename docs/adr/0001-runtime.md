# ADR 0001 — Choosing the runtime: Tauri v2

**Status:** accepted
**Date:** 2026-08-15
**Context:** phase 0 (spike / go-no-go), see [ANALYSIS-AND-PLAN.md](../ANALYSIS-AND-PLAN.md)

## Decision

**Tauri v2 + a Rust core + a TypeScript UI.** We continue as planned; the Electron fallback is not activated.

## Why the decision was open at all

The whole project rests on the claim that one codebase can cover desktop, web and mobile. If that does not hold, the architecture falls apart into three separate applications and the ~20-month estimate no longer holds either. Phase 0 existed to test that claim **before** a shell was built on top of it.

## Spike results

Environment: Windows 11 Pro 26200, Rust 1.97.1 (MSVC), Node 26.1.0, pnpm 11.21.0, Visual Studio Build Tools 2026, WebView2 present.

| # | Spike | Result | Note |
|---|---|---|---|
| 1 | Tauri v2 desktop build | **passed** | Debug binary 12.8 MB, the window opens, ~24 MB working set when idle |
| 2 | Tauri v2 Android build | **passed** | The APK builds, installs and runs on a physical device — see below |
| 3 | Rust core → WASM | **passed** | `ul-formats` builds for `wasm32-unknown-unknown`, 364 KB uncompressed before `wasm-opt` |
| 4 | PDF rendering | **passed**, but differently than planned | pdf.js instead of pdfium — see below |
| 5 | CodeMirror 6 in the shell | **passed** | Syntax highlighting, 13 languages loaded lazily |

Instead of five throwaway branches we went straight to a usable shell, because the first four spikes passed without resistance. That is a deviation from the plan and a deliberate one: the code was not thrown away.

### The deviation on PDF

The plan called for `pdfium-render`. What was delivered instead is pdf.js with a hand-written text layer.

**The reason:** pdf.js works on all three targets immediately and without shipping a native binary, so phase 1 becomes usable sooner. pdfium remains planned for desktop once performance on large documents demands it — the `EditorInstance` contract is the same, so the swap is a local change inside `editor-pdf`.

**The cost:** pdf.js is slower and uses more memory on documents of several hundred pages. To be measured before phase 4 (mobile), where webview memory is a real constraint.

The text layer was written by hand (~40 lines) rather than using the `TextLayer` class from pdf.js, because that API changed between major versions. Less dependence on someone else's unstable interface.

## The Android spike — carried out, passing

The critical go/no-go from the plan was carried out afterwards and **passed on a physical device**. That takes the Electron fallback off the table for good.

Environment: NDK 27.2.12479018, Gradle 8.14.3, target `aarch64-linux-android`. Device: Xiaomi 2201117TY (Redmi Note 11), Android 13 / SDK 33, arm64-v8a, MIUI V816.

What was proven:

- the APK builds (`tauri android build --debug --apk --target aarch64`) and contains only `lib/arm64-v8a`
- the app starts, `libuleditor_lib.so` loads, WebView 150.0.7871.181 renders the shell
- **the interface is embedded in the binary, not served from the computer** — the APK works with no dev server and no network
- logcat is clean: no errors, no refused resources, no CSP violations

With that, the claim "one core, three targets" is proven on all three rather than on two.

### What surfaced along the way

**Windows requires elevation for a symlink.** While assembling the APK, Tauri creates a symbolic link to `libuleditor_lib.so`, and without Developer Mode Windows permits that only for an administrator. Handled through [`tools/android-dev.ps1`](../../tools/android-dev.ps1), which runs elevated; nothing in the system is changed — the elevation serves only that symlink.

**MIUI blocks `adb install`.** Installing over USB fails with `INSTALL_FAILED_USER_RESTRICTED`, and Xiaomi gates that switch behind an inserted SIM card. The important part is that this is **not** an Android restriction — `dumpsys user` reports `Effective restrictions: none`, and `install_non_market_apps` is `1`. The message comes from Xiaomi's patched package manager, so no `adb` setting turns it off; not even `pm install` directly on the device gets through. Sideloading by tapping the APK takes a different route and works with no preparation at all.

The consequence for development: while the phone holds no SIM, `tauri android dev` (automatic install + hot reload) does not work, and neither does `adb shell input`, so checks cannot be driven on the device the way they are on desktop. The loop is: build the APK → `adb push` → install by hand. Enough to prove the point, not enough for daily work on phase 4 — that will need a SIM (any one, even inactive) or an emulator.

### Layout on the phone

The first run showed the shell in a plain desktop layout: the system status bar over the application title bar, and a fixed 264 px side panel next to a 48 px activity bar on a 392 px wide screen — leaving the main area **0 px** and breaking the description onto one word per line.

Fixed in the same pass, because the app is otherwise unusable for any further checking on the device:

- safe area insets (`env(safe-area-inset-*)` together with `viewport-fit=cover`); on this device they are 34 px at the top and 48 px at the bottom
- below 720 px the side panel goes **over** the content instead of squeezing it, and the width handle disappears
- the document name and keyboard shortcuts are removed from the title bar

Two traps that came out along the way and are worth remembering: `position: absolute` and `display: none` take an element out of the grid flow, so auto-placement shifts everything after it — positions **must** be stated explicitly. And measuring width is not enough: at an intermediate step the main area was exactly 345 px wide but sat on the second row, below the activity bar. The check now compares top edges too.

This is **not** the touch redesign from phase 4 — there are no gestures and no contextual toolbar, and the overlay panel closes with a button on the activity bar rather than a tap outside it.

Check: `pnpm verify:mobile` ([`tools/verify-mobile-layout.mjs`](../../tools/verify-mobile-layout.mjs)) drives the real app on the device over `adb forward` to the WebView devtools socket.

### Reaching documents on Android

The layout was only half the problem. An explorer with a folder tree is a desktop metaphor: it assumes the user knows where their file sits. On a phone they do not, and have no reason to. The mobile view therefore does not ask for a folder to be opened but surveys the device itself — [`crates/ul-core/src/library.rs`](../../crates/ul-core/src/library.rs).

**Scoped storage all but prevents that, and does so quietly.** Measured on the device: `adb` sees around 60 documents in `Download`, the app sees seven folders and **not one file**. Without the storage permission, `read_dir` lets only directories through and reports no error — a naive library would claim there are no documents.

Chosen: **`MANAGE_EXTERNAL_STORAGE`**. With it, the existing VFS, search, format detection and OCR all work over real files without a single change in the core. The cost is clear and recorded here: **Google Play grants that permission mostly to file managers**, so Play would require SAF (`ACTION_OPEN_DOCUMENT_TREE`) — and that hands back `content://` URIs which `std::fs` cannot open, meaning a URI-aware layer in `ul-core` and a change to the document contract. That is phase 4 work, not an incidental edit.

Three things measuring on the device turned up that guesswork would not:

- **Photos swallow the list.** First measurement: 2000 entries, of which 1956 images and 41 PDFs, with the limit hit mid-scan — documents in later folders never got in. Images now have their own quota (400) and are trimmed by time, so documents cannot be pushed out.
- **Denied access has to be reported.** `LibraryScan::looks_blocked` tells an empty device apart from hidden content (folders seen, files not), and the UI then offers instructions instead of an empty list.
- **The library must not widen the explorer.** Scanned folders go into a separate `library_roots`: they may be read, but they do not appear in the tree — otherwise on desktop a single glance at the library would drop Documents, Downloads and Desktop among the user's opened folders.

Check: `pnpm verify:library` ([`tools/verify-mobile-library.mjs`](../../tools/verify-mobile-library.mjs)). It deliberately revokes the permission via `appops` and requires the app to admit the obstacle rather than show an empty list.

**The permission is turned on by hand for now** (Settings → Apps → ulEditor → Permissions → All files access). The system does not offer it through an ordinary dialog, and jumping to that screen from the app needs a Kotlin piece that does not exist yet — so the library displays the exact path to the setting.

The debug APK is 145 MB, of which `libuleditor_lib.so` is 137.9 MB — almost all of it debug symbols and the embedded OCR models. The release size needs measuring before phase 4; the budget from the plan (`installer < 40 MB`) was written for desktop and needs a separate figure for mobile.

## An obstacle in the environment: Smart App Control

The release build (`tauri build`) failed on this machine:

```
error: failed to run custom build command for `serde v1.0.229`
  An Application Control policy has blocked this file. (os error 4551)
```

Windows Smart App Control is in enforcement mode and blocks the unsigned build-script binaries cargo generates. Debug builds pass; release does not.

**Consequence:** the installer size and cold start from the phase 1 plan have not yet been measured on this machine.

**Options:** build the release in CI (GitHub Actions runners have no SAC), on another machine, or turn Smart App Control off. The last is one-way — turning it back on requires reinstalling Windows — so that is the user's decision, not something done in passing.

## Consequences

**We accept:**
- a dependency on each platform's webview; the differences between WebView2, WKWebView and WebKitGTK must be in the CI matrix from the start
- Rust in the build chain, hence slower cold builds and a steeper onboarding for contributors
- CodeMirror instead of Monaco, hence no VS Code parity

**We gain:**
- one core for three targets, proven on all three
- a 12.8 MB debug binary against the ~150 MB Electron would require
- a file system sandbox enforced by Rust rather than by the UI

## Next step

Phase 0 is closed — all five spikes were carried out. Two measurements remain that need somebody else's environment rather than a new decision: a release build in CI (because of Smart App Control on this machine), and measuring the size and cold start of the mobile release build before phase 4.
