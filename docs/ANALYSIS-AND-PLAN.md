# ulEditor — analysis, architecture and plan

Goal: one open-source editor that opens and **edits** code, Markdown, PDF, Word (DOCX), Excel (XLSX) and later PowerPoint in one place — desktop first, then web, then mobile.

## Founding decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | **Tauri v2** + a Rust core + a TypeScript UI | The only stack that covers desktop + web + mobile from one codebase. A ~10–15 MB build against Electron's ~150 MB |
| Office strategy | **Hybrid**: Univer / ProseMirror native + LibreOffice headless as a fidelity layer | Licence-clean, works everywhere, with a defined fallback when fidelity is not enough |
| Licence | **Apache-2.0** core, copyleft engines as opt-in plugins | Maximum flexibility, does not turn corporate contributors away |
| MVP | **Code + Markdown + PDF** | Usable within 4 months; proves the architecture before entering OOXML |

---

## 1. What is genuinely hard here

The reason an editor like this does not exist is not a shortage of ideas, but that **every format is a separate engine representing 5–15 years of work**:

- **OOXML** (ECMA-376) is a ~6000-page specification. LibreOffice has worked on it for 25 years and still loses formatting on complex documents.
- **PDF has no reflow.** Text is a set of positioned glyphs, not sentences. "Edit text in a PDF" is a fundamentally different problem from editing Word, and it never works perfectly.
- **Formulas and the calculation graph** in Excel are an interpreter of their own with ~500 functions, dependencies, iterative calculation and array formulas.

**The conclusion that shapes the entire architecture:** ulEditor **must not write engines**. It is **a shell that orchestrates them** — one UX, one file model, one clipboard, one search — while the heavy lifting is done by existing mature projects. The product's value lies in *integration and a consistent experience*, not in parsing XML.

It follows that **the plugin contract is the project's most important artefact**, more important than any individual editor. If the contract is good, formats get added in parallel and by contributors. If it is bad, the project chokes on the third format.

### The competition and the gap

| Solution | What it lacks |
|---|---|
| VS Code | No Office and no real PDF editing |
| LibreOffice | No serious code editor, dated UX, no web/mobile |
| ONLYOFFICE | Office yes, code no, AGPL, heavy runtime |
| Obsidian / Typora | Markdown only |
| Adobe Acrobat | PDF only, closed, expensive |

The empty space: **one consistent, fast, open-source shell across every format, with a cross-format clipboard and a shared search.**

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────┐
│  SHELL UI  (TypeScript + React + Vite)                │
│  tabs · split view · explorer · command palette        │
│  themes · settings · session · notifications           │
└───────────────────────────────────────────────────────┘
                          ▲
                 plugin-sdk (the public contract)
                          ▼
┌───────────────────────────────────────────────────────┐
│  EDITOR PLUGINS  (each implements EditorProvider)     │
│  code · markdown · pdf · sheet · doc · image           │
└───────────────────────────────────────────────────────┘
                          ▲
                 ul-ffi (Tauri commands / wasm-bindgen)
                          ▼
┌───────────────────────────────────────────────────────┐
│  CORE  (Rust)                                          │
│  VFS · format detection · plugin host · index (tantivy)│
│  conversion (LibreOffice headless) · FFI: pdfium, qpdf │
└───────────────────────────────────────────────────────┘
        │                    │                    │
   native lib            WASM build          mobile lib
   (desktop)             (web)               (iOS/Android)
```

**Why a Rust core:** the same code compiles to three targets. Without it, every target demands a reimplementation of the VFS, format detection and indexing. That is the only reason Tauri was chosen over Electron.

### The plugin contract

A sketch; finalised in phase 1 and under semver from then on.

```ts
interface EditorProvider {
  id: string;                       // "org.uleditor.pdf"
  displayName: string;
  matches: {
    extensions: string[];
    mimeTypes?: string[];
    magic?: Uint8Array[];           // detection by content, not just by extension
  };
  capabilities: Capability[];       // 'view'|'edit'|'annotate'|'export'|'search'|'collab'
  priority: number;                 // several providers for one format → the user chooses
  createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance>;
}

interface EditorInstance {
  mount(el: HTMLElement): void;
  unmount(): void;
  isDirty(): boolean;
  save(target?: SaveTarget): Promise<SaveResult>;
  undo(): void;  redo(): void;
  find(q: FindQuery): Promise<FindResult[]>;
  copySelection(): Promise<ClipboardPayload>;   // ← the cross-format bridge
  paste(payload: ClipboardPayload): Promise<boolean>;
  onDirtyChange: Event<boolean>;
}

interface EditorHost {
  fs: VirtualFileSystem;            // through the Rust core, the same API on all 3 targets
  commands: CommandRegistry;        // registration into the command palette
  convert: ConversionService;       // LibreOffice headless
  theme: ThemeService;
  settings: SettingsService;
  notify: NotificationService;
}
```

**A `ClipboardPayload` with several representations** (`text/plain`, `text/html`, `application/x-uleditor-table`, `image/png`) makes it possible to copy a range out of Excel and paste it into a Word document as a real table — functionality none of the competition offers across formats.

---

## 3. Library choices

All of them checked by `cargo-deny` / `license-checker` in CI — licences change.

| Format | Render | I/O + edit | Licence | Phase |
|---|---|---|---|---|
| Code / text | CodeMirror 6 | CodeMirror 6 + tree-sitter + an LSP client | MIT | 1 |
| Markdown | CodeMirror 6 + preview | the same | MIT | 1 |
| PDF | `pdfium-render` (desktop/mobile), PDF.js (web) | `lopdf`, qpdf, pdf-lib | BSD-3 / Apache-2.0 / MIT | 1 |
| Images | `image-rs` | crop / rotate / basic | MIT | 1 |
| XLSX | **Univer** | Univer + `calamine` (read) / `rust_xlsxwriter` (write) | Apache-2.0 / MIT | 2 |
| DOCX | ProseMirror | `docx-rs`, mapped onto an OOXML subset | MIT | 2 |
| ODF / conversions | LibreOffice `--headless` | `soffice` CLI orchestration from Rust | MPL-2.0 | 2 |
| PPTX | Univer Slides | — | Apache-2.0 | 5 |
| OCR | — | OCRmyPDF / Tesseract | MPL-2.0 / Apache-2.0 | 5 |

**CodeMirror 6 instead of Monaco** is a deliberate trade-off: some VS Code parity is lost, but decent behaviour on a mobile webview is gained. Monaco effectively does not work on mobile, and mobile is a declared target.

**Deliberately avoided for licence reasons:** MuPDF (AGPL), ONLYOFFICE (AGPL), HyperFormula (GPL-3.0), Handsontable (commercial). Should they be needed — they go into `plugins/` as opt-in packages under their own licence, not into the core.

---

## 4. Repository layout

pnpm workspaces + a cargo workspace in the same monorepo.

```
ulEditor/
├─ apps/
│  ├─ desktop/              # Tauri v2 — Windows/macOS/Linux
│  ├─ web/                  # Vite SPA, core-rs as WASM         (phase 3)
│  └─ mobile/               # Tauri v2 iOS/Android              (phase 4)
├─ crates/
│  ├─ ul-core/              # VFS, document registry, plugin host, event bus
│  ├─ ul-formats/           # FormatCodec trait + detection by magic bytes
│  ├─ ul-convert/           # LibreOffice headless orchestration (phase 2)
│  ├─ ul-index/             # full-text search (tantivy)
│  └─ ul-ffi/               # Tauri commands + wasm-bindgen exports
├─ packages/
│  ├─ plugin-sdk/           # TS types + host API — THE PUBLIC CONTRACT, semver
│  ├─ shell-ui/             # tabs, explorer, command palette, themes
│  ├─ editor-code/
│  ├─ editor-markdown/
│  ├─ editor-pdf/
│  ├─ editor-image/
│  ├─ editor-sheet/         # Univer                             (phase 2)
│  └─ editor-doc/           # ProseMirror                        (phase 2)
├─ plugins/                 # optional, other licences, opt-in
├─ tools/
│  └─ fidelity-harness/     # a document corpus + round-trip pixel diff
└─ docs/
   ├─ ARCHITECTURE.md
   ├─ PLUGIN-API.md
   └─ adr/                  # one ADR per significant decision
```

---

## 5. Roadmap

### Phase 0 — Spike / go-no-go (3–4 weeks)

No architecture gets written until the risky assumptions are proven. Five spikes, each one throwaway:

1. The Tauri v2 desktop build passes on Windows + macOS + Linux
2. **The Tauri v2 Android build runs on a device** ← the critical go/no-go for the whole stack choice
3. The `ul-core` skeleton compiles to WASM and is called from a browser
4. `pdfium-render` renders a PDF page inside a Tauri window
5. CodeMirror 6 mounted in the shell, opening and saving a file through the Rust VFS

**If #2 fails:** fall back to Electron for desktop plus a separate React Native mobile app sharing only the `plugin-sdk` types. Make that decision in phase 0, not in phase 4.

Output: `docs/adr/0001-runtime.md` with the go/no-go decision.

### Phase 1 — Desktop MVP (months 1–4)

State as of 15 August 2026.

| Item | State |
|---|---|
| Shell: tabs, explorer, palette (`Ctrl+Shift+P`), settings, themes | **done** |
| Session restore (tabs + tree roots) | **done** (desktop) |
| `plugin-sdk` v0.1 + registry + lazy editor loading | **done** |
| `editor-code`: CodeMirror 6, syntax highlighting, find/replace | **done** |
| `editor-markdown`: source + live preview | **done** |
| `editor-pdf`: rendering, text layer, annotations, pages (rotate / delete / reorder / merge / split) | **done** |
| **Read-only viewing of DOCX and XLSX** | **done** |
| **EPUB reader + reading mode** (not in the original plan) | **done** |
| **OCR over an image + the panel below** (not in the original plan) | **done** |
| **Text export to txt / md / docx / pdf** (not in the original plan) | **done** |
| **English as the default interface language, Croatian in settings** | **done** |
| Split view | **partial** — the horizontal panel below holds one document; two full tab groups remain open |
| `editor-code`: tree-sitter, LSP client | deferred to phase 1.1 |
| `editor-markdown`: mermaid | deferred to phase 1.1 |
| Global project-wide search | **done** — scanning in Rust; `tantivy` deferred while scanning suffices |
| **Search inside PDF, Word, Excel and e-books** (not in the plan) | **done** |
| **Quick open by file name (`Ctrl+P`)** | **done** |
| Auto-update, crash reporting, opt-in telemetry | needs signing and a backend; ships with the release itself |
| `editor-pdf` on pdfium instead of pdf.js | deferred — pdf.js suffices, the swap is an optimisation |

**Reading mode was not in the plan, and it made it into the contract.** It turned
out to be the item that best defends the project's whole thesis:
`EditorInstance.beginReading()` means one reading room in the shell serves EPUB,
PDF, Markdown and Word, while each of them defines for itself what a "page" and a
"chapter" are. The same thing search proved for `find()`.

**OCR proved a third seam.** The image viewer knows nothing about the panel below
— it publishes the result through the `scratch.openText` command. Every
conversion that produces something not yet a file on disk later takes the same
route. Along with it came the optional `EditorInstance.plainText()`, which was
needed for indexing in phase 1.1 anyway.

**Why LSP was deferred:** external processes with their own lifecycle, a large
piece of infrastructure that does not change the project's thesis.

**Why `tantivy` was not taken:** an index pays off when the corpus is large and
queries frequent, but it carries invalidation — and invalidation has no halfway
solution. Scanning cannot go stale because it holds no state, and for a workspace
of a few thousand files it answers in tenths of a second. The index stays in the
plan for the moment that stops being true, and by then it will have a defined job
instead of being the first assumption.

Output: **v0.1** — signed installers for Windows, macOS, Linux. A public release to attract contributors.

### Phase 2 — Office (months 4–10)

The project's biggest risk, which is why it comes only once the shell stands and contributors exist.

- `editor-sheet`: Univer integration, XLSX I/O, formulas, cell formatting, basic charts, virtualisation at 100k+ rows
- `editor-doc`: a ProseMirror schema mapped onto an OOXML subset — paragraphs, styles, lists, tables, images, header/footer, comments
- `ul-convert`: LibreOffice headless — DOCX ↔ PDF ↔ ODF ↔ HTML, batch conversion
- **Fidelity harness (critical, built on day one of phase 2):** a corpus of 500+ real documents; each one opened → saved → rendered to PDF → pixel-diffed against the original. Without this you have no idea whether you are losing formatting.
- **"Fidelity mode":** if a document uses an unsupported feature, it opens **read-only through the LibreOffice renderer with a clear warning** — a silently broken version is never saved. This is the most important rule in the entire project; quietly losing a user's formatting destroys trust for good.
- Cross-format clipboard

Output: **v0.5**

### Phase 3 — Web (months 10–14)

- `ul-core` → WASM; File System Access API + drag & drop; OPFS for a local cache
- PDF.js instead of pdfium on the web
- An optional self-hosted backend (Docker) for heavy conversions — LibreOffice does not go into WASM
- PWA, offline work

Output: a hosted instance + `docker-compose` for self-hosting

### Phase 4 — Mobile (months 14–20)

- Tauri v2 iOS/Android
- **A touch-first UI, not a desktop port:** gesture navigation, a contextual toolbar instead of menus, virtual keyboard handling
- A deliberately reduced scope: code, Markdown, PDF (viewing + annotations + signature), XLSX viewing + basic editing, DOCX viewing
- Share sheet, integration with Files / iCloud / Drive

### Phase 5 — Ecosystem (20+)

A plugin marketplace with a WASM sandbox · realtime collaboration (Loro CRDT, Rust-native, MIT) · an AI layer as a plugin, never in the core (local Ollama + API) · PPTX · track changes · PAdES signatures · OCR

---

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| OOXML fidelity — silently corrupting documents | Critical | A fidelity harness from day one of phase 2; a read-only fallback; never save silently with loss |
| Scope explosion | Critical | Everything above phase 1 is a plugin, not core. Strict `plugin-sdk` semver |
| The Tauri Android build does not work | High | Proven in phase 0, not in phase 4. A defined Electron fallback |
| WebKitGTK (Linux) behaves differently | Medium | A CI matrix with all three webviews from phase 0 |
| Mobile webview memory on large PDFs | Medium | Streaming render from Rust; never the whole document in the JS heap |
| Solo dev burnout | High | A usable v0.1 within 4 months; an early public release for the sake of contributors |
| A dependency's licence changes | Low | `cargo-deny` + `license-checker` block CI; an ADR per dependency |

---

## 7. Verification

**CI on every PR:**

```
cargo test && cargo clippy -- -D warnings && cargo deny check
pnpm test          # vitest — unit
pnpm e2e           # Playwright over the Tauri WebDriver
pnpm fidelity      # round-trip pixel diff, threshold < 2% difference  (from phase 2)
```

**Matrix:** Windows / macOS / Linux × (desktop, web). Android + iOS builds from phase 0.

**Performance budgets** (measured in CI, a PR fails if they are exceeded):

- cold start < 1.5 s
- opening a 10 MB PDF < 800 ms to the first page
- scrolling through a 100k-row XLSX at 60 fps
- desktop installer < 40 MB

**Manual verification at the end of phase 1:**

1. `pnpm tauri dev` — the application comes up
2. Open a repository directory → the explorer shows the tree
3. Open a `.ts` file → highlighting, autocomplete and go-to-definition work
4. Open a PDF → scrolling, text selection, add a highlight, delete a page, save, check in another reader
5. Open a `.md` → the live preview follows typing
6. Open a `.docx` and an `.xlsx` → the read-only preview renders
7. `Ctrl+Shift+P` → the command palette finds commands from every loaded plugin
8. Close and reopen → the session is restored
9. Package an installer, install it on a clean machine, repeat 1–8
