# Prompt — Phase 0 (spike / go-no-go)

Paste this into a fresh Claude Code session opened in `c:\dev\ulEditor`.

---

Bootstrap the monorepo for **ulEditor** — an open-source multi-format editor (code, Markdown, PDF, Word, Excel in one place). The context and architecture are in `docs/ANALYSIS-AND-PLAN.md` — read it before writing anything.

## Stack

- **Tauri v2** (desktop + mobile)
- **Rust core** — `crates/ul-core`, `crates/ul-ffi`
- **TypeScript + React + Vite** UI
- **pnpm workspaces + a cargo workspace** in the same repository
- Licence **Apache-2.0**

## The rule for this phase

**The goal is solely to prove five risky assumptions. The code is throwaway.** Do not build abstractions, do not write a plugin system, do not optimise, do not add features that are not part of a spike. Any spike that passes is allowed to be ugly.

## Steps

First a minimal skeleton: `apps/desktop`, `crates/ul-core`, `crates/ul-ffi`, `packages/shell-ui`, a root `package.json` + `Cargo.toml` + `pnpm-workspace.yaml`. `git init`, first commit.

Then each spike on its own branch:

1. **`spike/desktop-build`** — a Tauri v2 window comes up; `pnpm tauri build` passes on Windows. Document the steps and prerequisites needed for macOS and Linux.

2. **`spike/android`** — a Tauri v2 Android build (`pnpm tauri android init` + `android dev`) runs on an emulator or a device.
   **This is the go/no-go for the entire stack choice.** If it fails, document the exact cause and how far you got — do not improvise workarounds.

3. **`spike/wasm`** — `ul-core` with a single function `detect_format(bytes: &[u8]) -> FormatId` (recognise PDF, ZIP/OOXML, plain text by magic bytes), compiled to WASM through `wasm-bindgen` and called from a plain HTML page in a browser.

4. **`spike/pdf`** — `pdfium-render` renders the first page of a PDF into a `<canvas>` inside a Tauri window. Record how the pdfium binary is distributed and how much it adds to the build size.

5. **`spike/codemirror`** — CodeMirror 6 mounted in the shell; it opens and saves a file through a Tauri command → the Rust VFS (not through the browser File API).

## CI

GitHub Actions, a `windows-latest` / `macos-latest` / `ubuntu-latest` matrix:

```
cargo clippy -- -D warnings
cargo deny check
pnpm build
```

## Output artefact

`docs/adr/0001-runtime.md` containing:

- the result of each of the 5 spikes (passed / failed / partial) and how long it took
- the concrete problems you ran into, with tool versions
- the build size per platform
- **an explicit go/no-go recommendation for Tauri v2**, including the fallback to Electron (desktop) + React Native (mobile) with shared `plugin-sdk` types if the Android spike failed

At the end, report a summary: what works, what does not, and what your recommendation is.
