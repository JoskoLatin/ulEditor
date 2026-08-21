# ulEditor

> One open-source editor for every format — code, Markdown, PDF, Word, Excel — in one place.

**Status:** phase 0 complete, phase 1 together. The desktop app runs, seven editors work, e-books and Office documents open. The interface is in English; Croatian can be selected in settings.

## The thesis

No editor works seriously with code *and* Office documents *and* PDF. VS Code has no Office. LibreOffice has no code editor. Acrobat does PDF only. ulEditor fills that gap — **not by writing its own engines, but as a shell that orchestrates existing mature projects** behind a single UX, a shared search and a cross-format clipboard.

## Format status

| Format | State | Engine |
|---|---|---|
| Code, text (13 languages) | **works** | CodeMirror 6 |
| Markdown | **works** — source + live preview + reading mode | CodeMirror 6 + markdown-it |
| **EPUB** | **works** — chapters, pages, table of contents, remembered position | own reader (fflate + DOMPurify) |
| PDF | **works** — viewing, zoom, text layer, search, reading | pdf.js *(desktop → pdfium, phase 1)* |
| PDF annotations | **works** — highlights, notes, ink | pdf-lib |
| **PDF text** | **works** — typing text, font, size, colour, moving | pdf-lib + Liberation Sans |
| **PDF redaction** | **works** — text leaves the content stream, it is not covered up | own content-stream reader |
| **PDF text editing** | **works** — click an existing line and rewrite it | the same + pdf-lib |
| PDF pages | **works** — rotate, delete, reorder, merge, extract | pdf-lib |
| **DOCX** | **works — viewing + text editing** (headings, formatting, lists, tables, images) | own reader *(full editing → ProseMirror, phase 2)* |
| **XLSX** | **works — viewing** (sheets, formats, formulas, merged cells) | own reader *(editing → Univer, phase 2)* |
| Images | **works** — viewing, zoom, transparency, **OCR** | Tesseract (wasm) *(editing → image-rs, phase 1)* |
| ODF, conversions | phase 2 | LibreOffice headless |
| PPTX | phase 5 | Univer Slides |

Formats that have no editor yet open with **a clear explanation of what is missing and when it arrives**, not with a blank screen.

Annotations are written as **real PDF objects** (`/Highlight`, `/Text`, `/Ink`), not as a drawing stamped into the page — Acrobat and other readers open, edit and delete them as their own. Annotations already present in a file are loaded and displayed.

**Text is typed with the `T` tool** — click where it belongs and type; the box grows with the text, so what you see while typing is already what will land in the file. Afterwards it can be dragged with the mouse and reopened with a click. It is saved as a `/FreeText` **with its own appearance stream**: without one, such an annotation is invisible in pdf.js and in browsers — that is, everywhere except Acrobat.

The font is **embedded**, and that is a necessity rather than a nicety: the standard fourteen PDF fonts use WinAnsi, in which `č ć ž š đ` do not exist. We use Liberation Sans, which ships with pdf.js anyway (SIL OFL 1.1), so no font is committed to the repository, and only the subset of glyphs actually used goes into the file — a signature on a form adds about 9 KB. A character the font does not know is reported **while you type**, rather than quietly turning into a blank.

**Deleting text with the `⌫` tool** drags a rectangle over what has to go and **removes the glyphs from the page content stream**. A black rectangle over text is not deletion: the text stays in the file and comes back out through selection, copying, or any tool that reads PDF — a mistake that has repeatedly published the very thing it was meant to hide. The space the glyphs occupied is made up with an offset in the `TJ` array, so the rest of the line stays exactly where it was.

When it **cannot be guaranteed** that everything was removed — a font without a widths table, Type3 glyphs, text inside a Form XObject — the page is left alone and the reason is stated immediately, while the user is still looking at the spot. A redaction that quietly misses part of the text is worse than none at all.

**Editing existing text** uses the same `T` tool: click a line and it opens filled with what is written there. The old line leaves the content stream, the new one sits on **the same baseline**, in the same size and colour, both read from the document itself.

It is written **with our embedded font**, not the original one, and that has a cost worth knowing. For Helvetica and Arial there is no difference — Liberation Sans is metrically identical, so the replacement takes exactly the same width. For other fonts the size, position and colour are kept, but the letterforms change, and this is said **before** you type. The original font cannot be used because it is embedded in the document as a subset: it contains only the glyphs that document already used, so the first `č` you add would come out as a blank in the middle of a sentence.

Rotated text, stretched text, an invisible OCR layer and a font without a `/ToUnicode` table are **not offered for rewriting** — each with its own reason, rather than letting a replacement sit crooked or having letters guessed at.

Page operations do not change the document until it is saved — until then there is only a *plan*. Rotating and deleting work on the original without loss; reordering requires re-imposing pages, so the loss of annotations and forms is **reported before saving** instead of happening silently.

**Text in Word can be rewritten** — double-click it. The unit of change is a `w:r`, a piece of text with a single formatting: a paragraph often holds a dozen of them, so rewriting a whole paragraph would require the program to guess which formatting applies to which new letter. A run is rewritten without a single such decision.

The XML is **not re-serialised**; only the byte ranges the user touched are changed, and every other part of the archive — styles, numbering, images, metadata — passes through untouched. The verification measures exactly that: after saving, every other part must be **byte for byte identical**. Runs holding a line break, a tab, a drawing or split text are not offered for editing, because there more than the text would change.

Excel is **read-only** for now, and the document itself says so. Editing without a fidelity harness means quietly losing someone else's formatting, so these editors do not declare an `edit` capability — rather than declaring it and failing on save. Everything the preview does not show (headers, footnotes, comments, charts) is listed in the bar above the document.

## Reading mode

`Ctrl+Shift+R` hides the entire program frame and leaves only the text.

- **Pages or scroll.** Pages come from CSS columns, so the browser itself makes sure a heading is not torn from its paragraph. Turning: space bar, arrow keys, a click near the edge.
- **Typography:** serif/sans-serif, size, line height, column width in characters.
- **Background:** day, sepia, night — independent of the application theme, because a book is read for hours. For PDF, "night" inverts the page rendering.
- **Table of contents** from the book (EPUB nav/NCX), from headings (Markdown, Word) or from document outlines (PDF).
- **Progress and an estimate of the time left**, by word count rather than by chapter count.
- **The place you stopped at** is remembered per document and survives closing.

All of it goes through `EditorInstance.beginReading()` in the plugin contract: the editor says what counts as a "page" and a "chapter" for it, and the shell writes the reading room — once, for every format.

## Project-wide search

`Ctrl+Shift+H` searches the whole workspace. The scan happens in Rust — file
contents never cross the IPC boundary; the query goes up, only the hits come
back.

With the **"Also search inside PDF, Word, Excel and e-books"** checkbox there is
a second pass: documents are opened **with the same parsers the editors use for
display**, so a sentence from a contract in a PDF lands in the same list as a hit
from code. A hit in a spreadsheet carries its cell address (`Sales!B4`), in a PDF
the page number, in a book the chapter title. That is the difference from `grep`
and from every code editor.

The second pass is more expensive, so it is chosen rather than assumed.

**Why scanning, not `tantivy`.** An index pays off when the corpus is large and
queries are frequent, but it brings a problem with no halfway solution:
invalidation. A `git checkout` that changes a thousand files, an edit made
outside the program, a folder added and then removed — each of those has to
update the index, or search quietly lies. Scanning cannot go stale because it
holds no state. An index becomes justified only once the answer stops being
instant.

`Ctrl+P` opens a file by name. The list comes from Rust, not from the tree: the
tree loads lazily, so a file in an unexpanded folder would be invisible — and
that is precisely the one people look for most.

**In-document search (`Ctrl+Shift+F`) behaves identically across all formats** — one panel, the same results, whether the open document is code, Markdown, PDF, an e-book, Word or Excel. That comes from `EditorInstance.find()` in the plugin contract, without a single line of format-specific code.

Open tabs and tree roots are remembered and restored on the next start (desktop).

## Text recognition from images (OCR)

The **OCR** button in the image viewer reads the text and opens it in a **panel
below** — a horizontal split that stays beside the image, so what was recognised
can be compared with the original straight away.

That panel is not an ordinary tab: its text has no file on disk, so its bar
carries **the choice of format to save into** — `.txt`, `.md`, `.docx` or `.pdf`.
DOCX and PDF are assembled inside the program, with no external tool. The PDF
uses an embedded font without Croatian diacritics, so that is reported **before**
saving, under the same rule by which every other loss is reported.

The recognition language (Croatian / English) is chosen next to the button,
because the same image often holds both. Without the Croatian model, `č ć ž š đ`
come out as `c z s`.

**OCR works offline.** By default Tesseract pulls its worker, wasm core and
language models from a CDN; here everything is served from the application
itself (`tools/ocr-assets.mjs` copies it out of `node_modules`, about 11 MB). The
reason is not convenience but two things this project has on purpose: the desktop
CSP allows `'self'` only, and an editor that needs the internet to read text off
an image is a demo, not a tool.

## Interface language

The default is **English**; Croatian is selected in settings (`Ctrl+,`). Changing
it reloads the window: the PDF, book and Office views build DOM directly, so
swapping strings on the fly would mean tearing down every open document — and the
session is restored on start anyway.

Translations are keyed by **the English source text**, not by abstract
identifiers. An untranslated string therefore falls back to readable English
instead of to `shell.tab.close.tooltip`.

## Quick start

```bash
pnpm install

pnpm dev          # web build at http://localhost:5273
pnpm desktop      # Tauri desktop application

pnpm verify           # runtime check of the shell (needs `pnpm dev` running)
pnpm verify:reading   # reading room, EPUB, Word and Excel viewing
pnpm verify:ocr       # OCR, the panel below, interface language switching
pnpm verify:export    # text export to txt / md / docx / pdf
pnpm verify:pdf       # annotations and page operations (no browser)
pnpm verify:all       # all of the above — 180 checks

pnpm verify:search    # project search, in the REAL desktop application
```

`verify:search` starts the program itself with the WebView2 debug port open and
attaches to it over CDP. Search lives in Rust and is reachable only through a
Tauri command, so checking it in a browser would test the glue instead of the
work.

`verify:ocr` downloads a language model on first run; with no network it reports
as skipped, not as passed.

Prerequisites: Node 20+, pnpm 11+, Rust stable, and on Windows the Visual Studio Build Tools and WebView2.

## Architecture

```
shell-ui (React)  →  plugin-sdk  →  editors (code · markdown · book · office · pdf · image)
                          ↓            ↑
                          ↓        reader-core · i18n · text-export
                          ↓
                       ul-ffi
                          ↓
              ul-core / ul-formats  (Rust)
                          ↓
        native lib · WASM · mobile lib
```

The Rust core compiles for all three targets. Desktop gets a VFS sandboxed to the workspace roots with atomic saving; web gets the File System Access API. **The editors do not see the difference** — they depend only on `@uleditor/plugin-sdk`.

Adding a format means writing a provider and registering it in [main.tsx](packages/shell-ui/src/main.tsx). The shell does not change.

## Layout

| Path | Contents |
|---|---|
| [packages/plugin-sdk/](packages/plugin-sdk/) | The public contract between shell and editors. Semver from v0.1 |
| [packages/shell-ui/](packages/shell-ui/) | Tabs, explorer, command palette, themes, host services |
| [packages/editor-*/](packages/) | One editor per format |
| [crates/ul-formats/](crates/ul-formats/) | Format detection by content. Also built for WASM |
| [crates/ul-core/](crates/ul-core/) | Sandboxed VFS and workspace search |
| [apps/desktop/](apps/desktop/) | The Tauri v2 shell |
| [packages/reader-core/](packages/reader-core/) | Shared pagination engine and reading typography |
| [packages/i18n/](packages/i18n/) | Interface translations; the key is the English source |
| [packages/text-export/](packages/text-export/) | Text → txt / md / docx / pdf, with no external tool |
| [tools/verify-ui.mjs](tools/verify-ui.mjs) | Runtime check of the shell through Chromium |
| [tools/verify-reading.mjs](tools/verify-reading.mjs) | Runtime check of the reading room and Office viewing |

## Licence

Core and all first-party editors: **Apache-2.0** ([LICENSE](LICENSE)).

Copyleft engines (MuPDF, ONLYOFFICE, HyperFormula) — should they ever be needed — go into `plugins/` as separate opt-in packages under their own licence, never into the core. [deny.toml](deny.toml) enforces that in CI.

## Documentation

- [Analysis and plan](docs/ANALYSIS-AND-PLAN.md) — architecture, library choices, roadmap, risks
- [ADR 0001: choosing the runtime](docs/adr/0001-runtime.md) — phase 0 results and the go/no-go decision
- [Releases](docs/RELEASE.md) — how one tag produces desktop installers and a phone APK
- [Phase 0 prompt](docs/PROMPT-PHASE-0.md)
