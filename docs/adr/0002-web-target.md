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
7. `deploy/web/`: compose and Caddyfile — pinned image, read-only, no
   capabilities, CSP header equal to the desktop one minus `ipc:`. A check
   that the served header matches and `isSecureContext` is true. *(security,
   whole step)*
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
