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
| Code / text | CodeMirror 6 | CodeMirror 6 + **an LSP client of our own** (`crates/ul-lsp`); tree-sitter not taken | MIT | 1 |
| Markdown | CodeMirror 6 + preview | the same | MIT | 1 |
| PDF | `pdfium-render` (desktop/mobile), PDF.js (web) | `lopdf`, qpdf, pdf-lib | BSD-3 / Apache-2.0 / MIT | 1 |
| Images | `image-rs` | **done** — crop, rotate, mirror, resize, PNG/JPEG/WebP/BMP/TIFF | MIT / Apache-2.0 | 1 |
| XLSX | **Univer** | Univer + `calamine` (read) / `rust_xlsxwriter` (write) | Apache-2.0 / MIT | 2 |
| DOCX | ProseMirror | `docx-rs`, mapped onto an OOXML subset | MIT | 2 |
| `.cdr` / EPS / PostScript | LibreOffice `--headless` | **done** — `soffice` CLI orchestration from Rust, in `crates/ul-convert` | MPL-2.0 | 2 |
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
│  ├─ ul-core/              # VFS, document registry, search, library
│  ├─ ul-formats/           # FormatCodec trait + detection by magic bytes
│  ├─ ul-image/             # crop, rotate, mirror, resize, re-encode
│  ├─ ul-convert/           # LibreOffice headless, for .cdr / EPS / PostScript
│  ├─ ul-lsp/               # a Language Server Protocol client (diagnostics)
│  └─ (no ul-index)         # tantivy is still not taken — see the search table
│  #  and no ul-ffi: the Tauri commands live in apps/desktop/src-tauri, since
│  #  a second crate between them and ul-core would have nothing to add
├─ packages/
│  ├─ plugin-sdk/           # TS types + host API — THE PUBLIC CONTRACT, semver
│  ├─ shell-ui/             # tabs, explorer, command palette, themes
│  ├─ editor-code/
│  ├─ editor-markdown/
│  ├─ editor-pdf/
│  ├─ editor-image/
│  ├─ editor-office/        # docx, doc, rtf, xlsx, xls, odt, ods — own readers
│  ├─ editor-book/          # EPUB
│  ├─ editor-vector/        # SVG, and .cdr / EPS through ul-convert
│  ├─ editor-3d/            # STL, OBJ, PLY, glTF, GLB, 3MF
│  ├─ reader-core/          # the reading room, shared by four editors
│  ├─ text-export/          # txt / md / docx / pdf out of anything textual
│  ├─ i18n/                 # the catalogues, and `t()`
│  ├─ (no editor-sheet)     # Univer not taken; the office package reads sheets
│  └─ (no editor-doc)       # ProseMirror not taken; byte-range editing instead
├─ plugins/                 # optional, other licences, opt-in
├─ tools/                   # every check, as a script that says what it proves
│  ├─ fidelity.mjs          # a real document corpus, edited and compared
│  ├─ verify-*.mjs          # one per claim; the desktop ones drive the app
│  └─ updater-manifest.mjs  # latest.json, written after every builder
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

State as of 9 September 2026.

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
| **Image editing** — turn, mirror, crop, resize, change format | **done** — through `image` in `crates/ul-image`, so the pixels are never decoded in the webview and the same code will serve the phone. A plan on screen, written once by the save |
| **SVG and 3D model viewing** (not in the original plan) | **done** — SVG with a source view, STL/OBJ/PLY/glTF/GLB/3MF through three.js; `.ai` opens as the PDF it contains |
| **English as the default interface language, Croatian in settings** | **done** |
| Split view | **done** — two tab groups side by side, each with its own document in front; the horizontal panel below is separate and holds the program's own output |
| `editor-code`: tree-sitter, LSP client | **LSP client done** — `crates/ul-lsp`: the underline in the margin with the compiler's own words, and the three questions beside it. What is this (a hover with the signature and the doc comment), what could this word become (completion), where was it defined (`F12`, `Ctrl+Click`, and the file opens even when it is outside every folder anybody opened). **tree-sitter is not taken and is not planned**: CodeMirror's Lezer already parses incrementally per language, and swapping it for wasm grammars would be a large change for nothing a person could see |
| `editor-markdown`: mermaid | **done** — a fence is drawn, and the library is imported the first time one appears rather than when the editor mounts. Two thirds of a megabyte gzipped is not a cost a document without a diagram should carry |
| Global project-wide search | **done** — scanning in Rust. `tantivy` still deferred, now on a measured basis rather than an assumed one: see the table below |
| **Search inside PDF, Word, Excel and e-books** (not in the plan) | **done** |
| **Quick open by file name (`Ctrl+P`)** | **done** |
| **A menu bar, and `Alt` to reach it** (not in the plan) | **done** — everything the program can do has a place a person can find it in, without knowing a shortcut first. `AltGr` is told apart from `Ctrl` whatever Windows reports, which is what a Croatian keyboard requires: `AltGr+Q` is a backslash, and it belongs in the document |
| Auto-update, crash reporting, opt-in telemetry | **auto-update and crash reporting done; telemetry not started and still opt-in.** The updater needed no certificate and no backend: the release page is the backend, and the signature is what makes it safe. Crash reporting arrived at the same answer from the other side — a report is a **file**, with no endpoint to send it to, and [tools/verify-crash.mjs](../tools/verify-crash.mjs) fails the run if either crash module grows a `fetch` or a URL. The half that turned out to matter more was not the reporting: a React render that throws took `#root` from 12,725 characters to **zero**, and two real faults did it. Both are fixed, and a boundary around the whole editor group catches the next one |
| `editor-pdf` on pdfium instead of pdf.js | **not taken, and now on a measured basis.** `pnpm pdf:timing` over 457 real PDFs, sampled by size, in the application: **median 536 ms to the first page, worst 1051 ms**, and no relationship to file size — a 4.9 MB document opens as fast as a 2 kB one. The swap would cost a native library per platform in every installer and a rewrite of the text layer, the annotations, the redaction and the retyping, all of which are built on pdf.js. Half a second is not worth that |

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

**LSP was deferred for the right reason and it turned out to be the right size
of job.** External processes with their own lifecycle is exactly what it was:
the protocol is a header, a blank line and some JSON, and every hour of the work
went on the lifecycle and on three failures that were completely silent — a
discarded stderr hiding a binary that could not run, a `didChange` a server
threw away because the client had declared the wrong synchronisation, and a
request from the server that nobody answered, after which it published nothing
at all. All three are written down in `crates/ul-lsp`, and the live test against
a real rust-analyzer is what found two of them.

**And asking was the same plumbing, minus one thing it did not have.** A
notification is finished when it has been written; a request is finished when a
message with the same id comes back, on a thread that is not the one waiting for
it. So a question leaves a channel under its id, the reading thread posts the
answer into whichever channel matches, and the question removes itself from the
register when it is dropped — without which every unanswered question would
leave a channel behind, one per keystroke that asked for a completion and was
overtaken by the next.

**The fourth silence is the one worth keeping.** Every path in this program has
been through the workspace's `resolve`, which canonicalises, and
`fs::canonicalize` on Windows returns `\\?\C:\dev\x`. That made the URL
`file:////?/C:/dev/x`, which no language server can parse — and **the underlines
went on appearing anyway**, because rust-analyzer walks a project itself and
publishes about files nobody opened. So the `didOpen` was ignored without a
word, every question was about a document the server had never heard of, and
every answer came back empty: indistinguishable from a server with nothing to
say. The unit tests passed, the live test passed, and only asking the question
inside the real application showed it — because that is the only place a path
has been canonicalised. Every one of the five failures in this crate has had the
same shape, which is the finding underneath the findings: **a language server
client fails by continuing to look like it works.**

**The fifth was `content modified`** — error `-32801`, the document having
changed while the server was thinking. It is not a failure and
it is not rare: every one of these questions is asked *while somebody is
typing*, so a `didChange` overtaking a request in flight is the ordinary case. A
client that read it as a refusal would have a tooltip that stops working for
exactly as long as anybody is working. It is named in `LspError` and the
question is asked once more.

**Two capability declarations did more than the code around them.**
`snippetSupport: false` makes rust-analyzer offer `push` where it would have
offered `push(${1:value})` — a completion that compiles, from a client that
cannot expand a tab stop and says so. `linkSupport: true` makes a server answer
with the *name* of a function beside the whole body of it, which is the
difference between landing on a declaration and selecting forty lines. Both are
promises, and the live test asserts both are kept.

**F12 had to be taken off the developer tools**, which is a smaller decision
than it sounds: it is what F12 means in a browser, and going to a definition is
what it means in every code editor. `Ctrl+Shift+I` is still the developer tools,
and over a PDF or a picture — where there is no name to follow — F12 does what
it always did. Finding that out was worth an hour: the shell listens for keys on
the window with `capture: true`, so a binding put inside CodeMirror would never
have fired, and would have looked exactly like a server with nothing to say.

**And why pdfium was not taken either.** The same instrument-before-opinion
rule as above, and the same outcome: measured with
[pdf-timing](../tools/pdf-timing.mjs) over 457 real PDFs, pdf.js puts the first
page on the screen in **half a second**, worst case one second, with no
relationship to how large the file is.

The first version of that instrument reported **sixteen seconds** for a
one-page 4.9 MB document, and the shape of the curve followed the file size
rather than the page count — which is the signature of a harness rather than of
a renderer. It was dropping each document into a browser by handing the bytes to
`page.evaluate`, which serialises five megabytes as an array of five million
numbers over the debugging protocol. It runs in the real application now,
opening files from disk the way a person does, and nothing but a path crosses
any boundary. A measurement that has not been checked against its own
instrument is an opinion with a number in it.

**Why `tantivy` was not taken:** an index pays off when the corpus is large and
queries frequent, but it carries invalidation — and invalidation has no halfway
solution. Scanning cannot go stale because it holds no state. The index stays in
the plan for the moment that stops being true.

That sentence used to end "and for a workspace of a few thousand files it answers
in tenths of a second", which nobody had measured. It has now been measured, over
one real `Documents` folder, with
[search-timing](../crates/ul-core/examples/search-timing.rs):

| | files walked | read as text | one search (release) |
|---|---|---|---|
| As it was | 100 000+ (the cap) | 72 236 | **17.2 s** |
| With the noise list corrected | 19 575 | 8 371 | **4.7 s** |
| And the reading done on eight threads | 19 575 | 8 371 | **2.2 s** |
| This repository, for comparison | 1 895 | 816 | **171 ms** |

**Almost all of it was somebody else's Python.** 90 998 of those files were under
`site-packages` and 18 721 under `__pycache__` — a portable ComfyUI installed
into the same folder as the contracts and the photographs. The noise list covered
`node_modules`, `.git`, `target` and `dist`: the JavaScript and Rust worlds, which
is where *this project's* own noise comes from, and nothing where the person using
it actually works.

So the measurement did not make the case for an index. It made the case for not
reading `site-packages`, which is a dozen lines and no invalidation. Seventeen
seconds is the sort of number that would have justified any amount of machinery,
and the machinery would have indexed the same ninety thousand files nobody wanted
searched.

**Then the reading was parallelised**, which is a smaller change than an index
and holds no state either: the walk hands out blocks of files, each block is read
on up to eight threads, and the findings are merged in the order the paths were
in — so two runs of one search still agree, and a search for a common word still
stops as soon as it has its five hundred hits. 4.7 s became 2.2 s.

**And the original claim turned out to be true where it mattered.** This
repository — an ordinary project folder, which is what somebody opens — answers
in **171 ms**. "Tenths of a second for a few thousand files" was right; what was
wrong was assuming a `Documents` folder is a few thousand files. The index still
has no job.

Output: **v0.2** — installers for Windows, macOS and Linux, plus a signed
Android APK, built by one tag in CI.

The plan said *signed* installers, and the desktop ones are not. That is an
Apple Developer ID at 99 USD a year and a Windows certificate at a few hundred
— a purchase, not a piece of work — so it is written down here as unfinished
rather than quietly dropped. Everything downstream of it waits with it:
auto-update has no meaning without a signature to check.

### Phase 2 — Office (months 4–10)

The project's biggest risk, which is why it comes only once the shell stands and
contributors exist. State as of 9 September 2026 — it started early, and neither
of the two engines it was designed around has been taken.

| Item | State |
|---|---|
| `editor-sheet`: Univer, XLSX I/O, formulas, cell formatting, charts, 100k+ rows | **partly** — sheets, number formats, merged cells and cell editing through a reader of our own, for `.xlsx`, `.xls` and `.ods`. A cell holding a formula does not open and says which formula it holds. Univer arrives for formulas and charts |
| `editor-doc`: a ProseMirror schema over an OOXML subset | **partly** — headings, formatting, lists, tables and images are read, in `.docx`, `.doc`, `.odt` and RTF; text is retyped a run at a time, and a paragraph can be added — the first change here that is not a substitution, and the one that showed the byte-range model does reach past one. and one the file already had can be taken away. ProseMirror is still what the deeper structural work needs: splitting a paragraph mid-run, a row in a table |
| **A cell that is not in the file** | **not a hole, and measured rather than argued.** `applyCellEdits` will write a `<c>` into a row that has none and a whole `<row>` into a sheet that has none, which raises the obvious worry: does an edit land outside the `<dimension ref>` the sheet declares, leaving it stale? It cannot. The grid a person can type into is derived from the cells that exist, never from `<dimension>`, so it is a subset of the used range — and over 19 real worksheets, **none** has a grid reaching past its declared dimension (six declare none at all, which is legal). A merged range is not reachable either: `renderSheet` skips covered cells, so there is nothing to double-click |
| `ul-convert`: LibreOffice headless | **done**, and smaller than it was meant to be: `.odt` and `.ods` open without it, so what it does is `.cdr`, EPS, PostScript and a PostScript-only `.ai` — the drawing models nobody else implements. Optional and asked for by name; the conversion writes to the temporary folder, never beside the original. DOCX ↔ PDF ↔ ODF conversion is not offered, because every one of those formats is read here already |
| **Fidelity harness** | **done** — [tools/fidelity.mjs](../tools/fidelity.mjs), 604 real documents at the last run, none failing. Not the instrument the plan named: nothing here re-lays-out what it opened, so pictures are not compared. What is measured is the promise actually made — every other part of the archive back byte for byte, the file reopening, the ordinals still meaning the same text, and nothing arriving as mojibake |
| **A new paragraph in a `.docx`** | **done** — `Ctrl+Enter`, held as a plan over the file as it was opened and applied whole on every save, so a second save writes the same bytes and an undo reaches back past one. The style is resolved through `w:next` rather than copied, the run formatting comes from the run it follows, a section break and a tracked-change mark are never carried, and a paragraph in a table cell is refused with its reason. [tools/verify-docx-insert.mjs](../tools/verify-docx-insert.mjs) |
| **A paragraph the file already had, removed** | **done** — `Ctrl+Shift+Backspace`, the same plan in the other direction: hidden in the view, applied on every save, and `Ctrl+Z` reaches back past one. The harder half, because a removal consumes a range other parts of the file may be half inside, so the refusals were each bought from Word over COM and are asked again on every run: the paragraph keeping two tables apart (Word merges them, 2 → 1), the last one behind a table (Word puts it back), half a protected range (Word revokes an untouched paragraph's permission, `1,0,0 → 0,0`), a section marker, half a field, and the last paragraph standing — counted against what the plan keeps, not what the file had. Word opens 11 of 11 with exactly one paragraph fewer; LibreOffice shows 41 real documents without the line that was taken, in the same save as 41 insertions and 46 rewrites. [tools/verify-docx-delete.mjs](../tools/verify-docx-delete.mjs) |
| **The reader that refuses** | **done** — [tools/verify-docx-word.mjs](../tools/verify-docx-word.mjs). LibreOffice is lenient: handed a body child it does not understand it opens the file and drops it, and the conversion reads as a success. Word refuses. It drives Word over COM and requires that ours opens, that it holds **exactly one paragraph more** than the original Word also opened, and that the text is in it. Its first finding was our own `makeDocx()` fixture, which had no `_rels/.rels` and no content type for the main part — not a package Word would open, and every check built on it had passed because every check was ours |
| **A reader that is not ours** | **done** — [tools/verify-office-readback.mjs](../tools/verify-office-readback.mjs). Every "it reopens" claim above went back through the same namespace-blind scanners that wrote the file, and a writer and a reader sharing a mistake agree perfectly. LibreOffice shares no code with us: **64 of 64 files we wrote opened in it**, and where it shows the spot we edited at all, **46 of 46 show the text we typed, diacritics and all** |
| **"Fidelity mode"** | **done** in the only form this program can honour: a format it cannot write hands the view over without an `edit`, a run it cannot rewrite without deciding something is not offered, and a redaction it cannot guarantee refuses the page and says why — while the person is still looking at the spot |
| Cross-format clipboard | **done** — a spreadsheet range arrives in a Markdown document as a table. The payload contract and every editor's `copySelection` had existed since the SDK was written and nothing carried a payload between them; the wire is `shell/clipboard.ts`, and it intercepts a paste only when an editor asks for it synchronously |

**An independent reader was the missing instrument, and building it took an
afternoon.** Everything the fidelity harness proves about a save, it proved with
the same tag scanners that wrote the file — so a writer and a reader sharing a
mistake agree with each other and the run reports `ok`. Nothing here had ever run
an XML parser, let alone a word processor, over a written part. `pnpm readback`
hands the file to LibreOffice, which answers the two questions no scanner of ours
can: does it open at all — the XML well-formed, every prefix declared, the
container acceptable — and is the text we typed the text a reader shows. The
answer over one real folder is **64 of 64 opened** and **46 of 46 showed the
marker**, which is the first outside confirmation this project's byte-range
writers have ever had.

**Its first version measured itself**, which by now is less a surprise than a
pattern. It reported eight failures — every one of them a table-layout schedule
or a workbook whose edited sheet was not the first — and not one of them a bug: a
`.csv` holds one sheet and a `.txt` export leaves out what its filter leaves out,
so "is the marker in the output?" was measuring the converter. The question it
asks now controls for that: the text that was in that spot **before** has to be
visible in the original's conversion, and only then is the marker required in
ours. A spot the reader never showed is a spot the instrument cannot ask about,
and it says so — eighteen of them — rather than counting them against the writer.
The same rule caught three files LibreOffice will not open **in their original
form**, which without the control would have been reported as damage this program
did.

**And structural editing was designed three ways and refuted three times.** The
next item in this phase is a new paragraph, and three independent designs — keep
the edit map and add an operation list, apply to the XML and re-render, refuse
everything that cannot be guaranteed — were each attacked by two critics and each
found fatal, on measured rather than argued grounds:

- **A paragraph's properties are not in the paragraph.** Numbering, frames and
  outline levels live in `word/styles.xml` at least as often as in the
  paragraph's own `w:pPr`, so copying those bytes verbatim does not reproduce
  what the paragraph is. Over 37 real documents, 33% of paragraphs are inside a
  `w:tc` and 21% of body paragraphs carry `numPr`; five of the 37 offer no
  candidate paragraph anywhere.
- **A field spans runs.** A complex field's result run is editable today, and
  splitting it puts `<w:fldChar w:fldCharType="end"/>` into the new paragraph
  with the field straddling both.
- **The dirty flag is text-only.** `#emitDirty` computes `this.#edits.size > 0`,
  so a structural step alone would never mark the document changed — press
  Enter, close the window, and the paragraph goes with no question asked.
- **Undo has no structural inverse.** `#restore` walks the existing spans and
  sets `textContent`; it cannot create or remove a paragraph.

None of that says the feature is out of reach. It says the byte-range model
reaches exactly as far as a substitution, and that the step beyond it is three
pieces of work rather than one: properties resolved rather than copied, a
structural step model of the shape `editor-pdf` already proved — *"page
operations change nothing until a save; until then there is only a plan"* — and
an assertion that an insert is correct rather than merely performed. `pnpm
readback` is that assertion, built first on purpose.

**The fourth design was written with those three pieces in it, and was attacked
again.** Four critics with four different lenses raised eleven problems, six of
them called fatal, every one grounded in a file and line or in a number from the
corpus. One of them was the design:

> *After a save, an inserted paragraph can be neither edited nor removed — and
> the flagship gesture always produces that case.* `save()` clears both undo
> stacks; deleting a paragraph was out of scope; and the gesture inserted an
> empty paragraph, which draws with no run inside it and so cannot be
> double-clicked. **The design copied the word "plan" from `editor-pdf` and
> dropped the property that makes a plan safe** — that editor's save clears no
> stack, its plan outlives the save, and `removePage` exists.

That is the finding that decided the architecture. The plan is now held over the
file **as it was opened**, for text and structure alike: `PreviewSource.commit`
is gone, every save applies the whole plan to the original, and nothing is
cleared. Saving twice writes the same bytes. Undo reaches back past a save. The
ordinal-rebasing arithmetic the design had needed — a page of it — was deleted
outright, because nothing shifts when nothing is ever advanced.

The other five each removed something that would have shipped:

- **`w:next` is the answer to "properties resolved".** Not a flattened style
  chain, which would freeze what should follow the document; the style itself
  declares its heir. Measured on 49 real documents: nine declare `w:next`, 90
  declarations, and every heading style among them hands on to body text —
  `Naslov1 → Normal`, and in one file `Heading → Tijeloteksta`.
- **The run formatting comes from the run, not the paragraph.** A critic built
  the design's own output against a real 48pt title and converted it: the new
  text arrived at the document default, sitting under the heading at a quarter
  of its size, because the size was direct formatting on the runs and the copied
  `w:pPr` said nothing about it.
- **Enter is not the gesture.** Enter has meant *done typing* in this view since
  the first run was rewritten, and `tools/verify-office-editing.mjs` presses it
  to commit; redefining it would have quietly turned every pass of that check
  into an unasked-for paragraph. The command is `Ctrl+Enter`.
- **The reading flow measures the document once.** `PagedFlow` recomputes its
  page count only in `relayout()`, and nothing in this editor had ever called
  it: a document that grew and did not say so has a last page nobody can reach.
- **The assertion the design proposed was wrong in both directions.** "The
  marker appears on a line of its own" passes on a defect — a 12pt line under a
  48pt heading is still its own line — and *fails* on a correct insertion after
  a numbered item, which LibreOffice exports as `    2. …`. So the structural
  claims are asserted against the XML the writer produced
  ([tools/verify-docx-insert.mjs](../tools/verify-docx-insert.mjs)) and
  LibreOffice is asked only the two questions no scanner of ours can answer: does
  it open, and is the text there. And the critic's last sentence — *"add one
  Word-side open before shipping, since Word is the reader that rejects a bad
  body child and LibreOffice is the one that hides it"* — turned out to be
  possible: Word is on this machine, so `pnpm verify:word` asks it, and the first
  thing it refused was our own fixture.

**And then it was built.** `Ctrl+Enter` adds a paragraph after the one the cursor
is in; a table cell is refused with a reason rather than in silence; an empty new
paragraph is never written, because a paragraph nobody typed into is one nobody
could click into again. `pnpm verify:insert` puts one into every real `.docx` in
the corpus — **44 of 44 that have anywhere to put one**, with the five that do
not named rather than counted as passes — and asserts on each that the document
is exactly one paragraph longer, that every character outside the single
insertion point is unchanged, that nothing forbidden was inherited, and that
saving twice writes the same file.

**Why neither engine was taken.** Both were chosen to make documents editable,
and byte-range editing turned out to make a stronger promise than either could:
what is not touched is not rewritten — not re-serialised, not reflowed, not
re-kerned — so styles, numbering, images and metadata come back byte for byte
rather than approximately. A re-serialising editor cannot claim that, and the
harness would have nothing to measure. They become necessary at the point where
the unit of change stops being a run or a cell — a new paragraph, a merged row,
a recalculated total — and that is what phase 2 has left to do.

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
   (`npm install -g typescript-language-server typescript` first — nothing is
   bundled, and without a server the file simply opens and is coloured)
4. Open a PDF → scrolling, text selection, add a highlight, delete a page, save, check in another reader
5. Open a `.md` → the live preview follows typing
6. Open a `.docx` and an `.xlsx` → the read-only preview renders
7. `Ctrl+Shift+P` → the command palette finds commands from every loaded plugin
8. Close and reopen → the session is restored
9. Package an installer, install it on a clean machine, repeat 1–8
