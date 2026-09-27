# ADR 0002 — Phase 3, the web target: what goes to WASM, and what does not

**Status:** accepted 2026-09-27 — the backend's place is to be decided when it comes
**Date:** 2026-09-27
**Context:** phase 3 (Web), [ANALYSIS-AND-PLAN.md § Phase 3](../ANALYSIS-AND-PLAN.md)

## Decision

Phase 3 is not carried out as the plan writes it.

- **`ul-core` does not go to WASM.** It is the virtual file system, the library
  scan and the search, all over `std::fs`
  ([crates/ul-core/src/lib.rs:9-11](../../crates/ul-core/src/lib.rs)). The
  browser already has its own file system in
  [host/browser-fs.ts](../../packages/shell-ui/src/host/browser-fs.ts) — File
  System Access and drag & drop — and a WASM `ul-core` would have no disk to
  talk to.
- **`ul-image` and `ul-formats` go to WASM**, through `wasm-bindgen-cli`
  pinned to the version in `Cargo.lock` (0.2.127 today) and refused on any
  mismatch. `wasm-pack` is not used: it wraps the same CLI, adds an npm
  scaffold nothing here needs, and the rustwasm organisation behind it was
  wound down in 2025.
- **The first vertical slice is image editing in the browser** — the one thing
  the code already defers to phase 3 by name
  ([host/services.ts:304-309](../../packages/shell-ui/src/host/services.ts)).
  `ul-image` is shaped for it: `info(bytes)` and `apply(bytes, ops)`, no file
  system in either signature
  ([crates/ul-image/src/lib.rs:222,236](../../crates/ul-image/src/lib.rs)),
  and the `ImageService` interface takes it without a change.
- **The conversion backend is not in phase 3.** On desktop LibreOffice serves
  only `.cdr`, `.eps` and `.ps`
  ([host/tauri-convert.ts:4-9](../../packages/shell-ui/src/host/tauri-convert.ts)),
  while a service that feeds untrusted uploads to LibreOffice is the largest
  new attack surface phase 3 could add. It comes later, as its own module with
  its own ADR. `ConversionService` already fits an HTTP adapter.
- **OPFS is dropped** until something needs it. What a person notices is the
  folder tree surviving a reload, and that is a `FileSystemHandle` kept in
  IndexedDB — handles are serialisable — with permission asked again on return.
- **The hosted instance is the static `dist`** behind Caddy, which sends the
  CSP as a header: today the policy lives only in
  [tauri.conf.json](../../apps/desktop/src-tauri/tauri.conf.json), and
  `index.html` has none.

## Why the plan is corrected rather than followed

The web build already works: CI builds the bundle and drives it in Chromium,
File System Access and drag & drop exist, and the Office editors are plain
TypeScript. Opening a `.docx` through WASM would prove nothing that is not
already proven. Editing an image in a tab would — it is the one feature the
browser lacks because the Rust is not there.

## The seam

`EditorHost` ([plugin-sdk/src/host.ts](../../packages/plugin-sdk/src/host.ts))
and `createShell` ([shell-ui/src/host/index.ts](../../packages/shell-ui/src/host/index.ts))
are the seam, and the Kapa already counts `EditorHost` as the ulul contract.
Its claim to be the one place that knows the platform does not hold today:
eleven files in `shell-ui/src` outside `src/host/` import `@tauri-apps/*`
directly. All but one are guarded by `shell.platform`; `shell/crash.ts` imports `invoke` statically,
so the Tauri API is in the web bundle. The fix is a `Shell.native` that is
`null` on the web and wraps the window, zoom, updater, devtools, launch
paths, crash reports, library scan and file listing — and a check in CI that
`@tauri-apps/` is imported only under `src/host/`.

No new `@uleditor/host` package: its only consumer would be `shell-ui`, and
ulul writes its own host over `plugin-sdk`.

## Not a finding: Google Fonts in the CSP

The review behind this ADR called `fonts.googleapis.com` and
`fonts.gstatic.com` in the CSP dead permissions. They are not. A PDF line set
in a family the screen does not have can be fetched for display from Google
Fonts ([editor-pdf/src/fonts.ts](../../packages/editor-pdf/src/fonts.ts),
`95a6024`) — only when the person presses the button that says so, and only
for the box being typed in; the file keeps its own glyphs. The entry stays on
desktop and goes into the web instance's header too, so that the button does
not break there.

## Steps

Each ends in a check in the style of `tools/verify-*.mjs`, and the ones marked
go through an independent security review first.

1. This ADR.
2. `Shell.native`; `crash.ts` imports lazily; `tools/verify-host.mjs` fails
   when `@tauri-apps/` is imported outside `src/host/` — shown by adding one to
   `shell/zoom.ts` and watching it go red.
3. `tools/wasm-assets.mjs`: `cargo build` and `wasm-bindgen --target web` into
   `public/wasm/`, the CLI version read from `Cargo.lock`; `ul-image` gains
   `cdylib` and `#[wasm_bindgen]` under `cfg(wasm32)` as `ul-formats` has.
   The `wasm` CI job hands the artefact to the frontend jobs. A check in Node
   rotates a PNG and finds the red corner where it should be. *(security:
   pinning, supply chain)*
4. `host/wasm-images.ts`, and a browser check that the window and the bytes
   agree and that nothing leaves the machine. A pixel cap from `info()` before
   `apply()`, and a fresh instance after a trap — `panic = "abort"` freezes a
   WASM instance. *(security: untrusted image bytes in the tab)*
5. Format detection on the web through WASM, after a parity check against the
   TypeScript detector over the real document corpus finds no disagreement.
   **Done differently (2026-09-27).** The parity check ran over 70 369 real
   files and found no disagreement; a twelve-byte specimen found one, an
   off-by-one in the Rust WebP rule, now fixed. The swap was then not made:
   the TypeScript detector is also what `fidelity.mjs`, `verify-doc.mjs` and
   four other Node checks classify their corpus with, and moving it to WASM
   would make each of them need Rust and `wasm-bindgen` to start. Both
   detectors stay, and `tools/verify-formats-parity.mjs` in CI holds them to
   one answer.
6. A hand-written service worker, registered only on the web; a check that a
   reload offline still opens a `.docx`. *(security: what it caches)*
   **Done (2026-09-27)**: `packages/shell-ui/sw/sw.js`, filled in at build
   time by `sw/plugin.ts` with its version and precache list, and registered
   from `host/offline.ts` on the web only. The precache is index.html, the
   entry and each editor with what they import statically: 29 files,
   3.53 MB on disk. The PDF worker, its fonts, the diagrams, the image module
   and OCR are kept on first use. It keeps only same-origin GETs without a
   query that answered `ok`; `/assets/` cache-first, `/wasm/` and `/ocr/`
   network-first (their names do not change between builds), and a page
   offline or behind a 5xx gets this build's own index.html. No
   `skipWaiting`: a deploy reaches a person once every ulEditor tab is
   closed.
   The security review said NE the first time: Cache Storage is shared with
   every page on the origin, so one script that ran there once could leave
   its own code to be served on every start, past redeploys and rollbacks,
   and nothing could switch the worker off from the server. Now the build
   writes the SHA-256 of every file it serves into sw.js, and nothing kept
   is served unless its bytes match; the version covers those digests and
   the Caddyfile's `header` block. `sw/off.js`, shipped as /sw.js by
   `tools/deploy-web.ps1 -ServiceWorkerOff`, deletes ulEditor's caches and
   unregisters. Caddy answers a missing `/sw.js`, `/wasm/*` or `/ocr/*`
   with a 404 instead of index.html.
   The second round said PROLAZI, with two findings fixed before the first
   deploy. Headers kept beside a body were served with it, so an entry could
   carry a `Refresh` to another site: every answer from the cache now gets
   the Caddyfile's headers instead. And one that predates the worker, from
   step 7: `/assets/` is sent immutable for a year, so wrong bytes the
   server sent once stay in the browser's HTTP cache after it is clean. A
   name in `/assets/` that the build knows is now answered only with its
   own bytes — asked for again past the HTTP cache if not, refused if still
   not.
   The third round said PROLAZI and found the same true of any path: a
   server in the wrong hands chooses the Cache-Control, so it can pin the
   page or a module in the HTTP cache for a year. The page is now always
   asked for past that cache (700 bytes), and a `/wasm/` or `/ocr/` file
   that is not this build's is asked for once more past it. The off switch
   does not reach the HTTP cache; after a known compromise the person clears
   the site's data and the cached files too.
   `tools/verify-web-offline.mjs` (32 checks) stops the server, clears the
   browser's HTTP cache and reloads, and a `.docx` never opened before has
   to open; it also poisons the cache, plants headers, has the server send
   wrong and pinned bytes and a 502, and throws the off switch. Of 34
   deliberate breakages it catches 29; the five it cannot see are layers
   under the check on read (the write-side digest, the query guard,
   `!response.ok`, both origin guards, the delete before install).
7. `deploy/web/`: compose and Caddyfile — pinned image, read-only, no
   capabilities, CSP header equal to the desktop one minus `ipc:`. A check
   that the served header matches and `isSecureContext` is true. *(security,
   whole step)*
   **Done (2026-09-27)**: deploy/web/, `tools/deploy-web.ps1`, and
   `tools/verify-web-csp.mjs`, which serves the build under the policy read
   from deploy/web/Caddyfile and drives the worker, the module, pdf.js and
   OCR. The container needs `NET_BIND_SERVICE` back: the image's caddy
   binary carries it as a file capability, and under no-new-privileges exec
   is refused without it. The name needs a DNS record on the router.
8. The workspace root survives a reload.

## To measure before committing

- The size of `ul-image` as WASM. The review built it once as a scratch
  cdylib and read 1.03 MB, 342 KB gzipped; step 3 measures the real one and
  records it.
- How long `apply()` blocks the main thread on the largest real photograph.
  Over 200 ms and it moves to a worker.
- `isSecureContext` on the hosted instance from this workstation: File System
  Access needs HTTPS, and Windows does not trust the internal CA, so from here
  the instance may fall back to read-only.
- What the service worker precaches: `dist/assets` is 37 MB, OCR 16 MB of it.
  Precache stays under 5 MB; OCR and the PDF worker are cached on first use.
  *Measured at step 6: 3.53 MB.*
