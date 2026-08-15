# Prompt — Faza 0 (spike / go-no-go)

Zalijepi ovo u novu Claude Code sesiju otvorenu u `c:\dev\ulEditor`.

---

Bootstrapiraj monorepo za **ulEditor** — open-source multi-format editor (kod, Markdown, PDF, Word, Excel na jednom mjestu). Kontekst i arhitektura su u `docs/ANALIZA-I-PLAN.md` — pročitaj ga prije nego išta napišeš.

## Stack

- **Tauri v2** (desktop + mobile)
- **Rust core** — `crates/ul-core`, `crates/ul-ffi`
- **TypeScript + React + Vite** UI
- **pnpm workspaces + cargo workspace** u istom repou
- Licenca **Apache-2.0**

## Pravilo ove faze

**Cilj je isključivo dokazati pet rizičnih pretpostavki. Kod je throwaway.** Ne gradi apstrakcije, ne piši plugin sustav, ne optimiziraj, ne dodaj značajke koje nisu u spike-u. Svaki spike koji prođe smije biti ružan.

## Koraci

Prvo minimalni skeleton: `apps/desktop`, `crates/ul-core`, `crates/ul-ffi`, `packages/shell-ui`, root `package.json` + `Cargo.toml` + `pnpm-workspace.yaml`. `git init`, prvi commit.

Zatim svaki spike u vlastitoj grani:

1. **`spike/desktop-build`** — Tauri v2 prozor se digne; `pnpm tauri build` prolazi na Windowsu. Dokumentiraj potrebne korake i preduvjete za macOS i Linux.

2. **`spike/android`** — Tauri v2 Android build (`pnpm tauri android init` + `android dev`) pokrene se na emulatoru ili uređaju.
   **Ovo je go/no-go za cijeli izbor stacka.** Ako padne, dokumentiraj točan uzrok i dokle si stigao — nemoj improvizirati zaobilazna rješenja.

3. **`spike/wasm`** — `ul-core` s jednom funkcijom `detect_format(bytes: &[u8]) -> FormatId` (prepoznaj PDF, ZIP/OOXML, plain text po magic bytes), kompajlirano u WASM preko `wasm-bindgen` i pozvano iz obične HTML stranice u browseru.

4. **`spike/pdf`** — `pdfium-render` renderira prvu stranicu PDF-a u `<canvas>` unutar Tauri prozora. Zabilježi kako se pdfium binary distribuira i koliko dodaje na veličinu builda.

5. **`spike/codemirror`** — CodeMirror 6 montiran u shellu; otvara i sprema datoteku preko Tauri commanda → Rust VFS (ne preko browser File API-ja).

## CI

GitHub Actions, matrica `windows-latest` / `macos-latest` / `ubuntu-latest`:

```
cargo clippy -- -D warnings
cargo deny check
pnpm build
```

## Izlazni artefakt

`docs/adr/0001-runtime.md` s:

- rezultatom svakog od 5 spike-ova (prošao / pao / djelomično) i koliko je vremena trajao
- konkretnim problemima na koje si naišao, s verzijama alata
- veličinom builda po platformi
- **eksplicitnom go/no-go preporukom za Tauri v2**, uključujući fallback na Electron (desktop) + React Native (mobile) sa zajedničkim `plugin-sdk` tipovima ako je Android spike pao

Na kraju mi javi sažetak: što radi, što ne, i koja je tvoja preporuka.
