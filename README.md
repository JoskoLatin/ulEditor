<p align="center">
  <img src="apps/desktop/src-tauri/icons/icon.png" width="128" alt="">
</p>

<h1 align="center">ulEditor</h1>

<p align="center">
  One open-source editor for every format — code, Markdown, PDF, Word, Excel, OpenDocument — in one place.
</p>

<p align="center">
  <a href="https://github.com/JoskoLatin/ulEditor/releases/latest"><img alt="Download" src="https://img.shields.io/badge/download-latest%20release-2ea44f"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/badge/licence-Apache--2.0-blue"></a>
  <a href="https://github.com/JoskoLatin/ulEditor/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JoskoLatin/ulEditor/actions/workflows/ci.yml/badge.svg"></a>
</p>

**Status:** phases 0 and 1 complete, phase 2 begun. The desktop app runs, thirteen editors work, e-books and Office documents open — Word, Excel and OpenDocument alike, back to the binary formats of 1997 — and the window splits in two. The interface is in English; Croatian can be selected in settings.

What phase 1 asked for and did not get: **the installers are not code-signed**, so Windows and macOS both warn on first launch — see [below](#the-warning-you-will-see-and-why). That is a certificate to buy, not code to write, and the Android build is signed.

## Download

**[→ Get the latest release](https://github.com/JoskoLatin/ulEditor/releases/latest)**

One tag builds every artifact, so the desktop installers and the phone build in
a release are always the same version of the same code.

| Platform | File | Installing it |
|---|---|---|
| **Windows** 10/11 | `…_x64-setup.exe`, or `…_x64_en-US.msi` | Run it. Windows will say "unrecognised app" — see below. |
| **macOS** Apple Silicon | `…_aarch64.dmg` | Open, drag to Applications. First launch: see below. |
| **macOS** Intel | `…_x64.dmg` | The same. |
| **Linux** | `…_amd64.AppImage`, `…_amd64.deb`, or `…x86_64.rpm` | `chmod +x` the AppImage and run it; `sudo dpkg -i` the .deb on Debian and Ubuntu; `sudo rpm -i` the .rpm on Fedora and openSUSE. |
| **Android** 7+ | `ulEditor_…_android.apk` | Allow installing from this source, then open the file. |

### The warning you will see, and why

The desktop builds are **not code-signed**, so on first launch:

- **Windows** shows "Windows protected your PC" → *More info* → *Run anyway*.
- **macOS** says the app "cannot be opened because the developer cannot be
  verified" → right-click the app → *Open* → *Open*.

This is not a judgement about the software. Both systems mean "nobody has paid
for a certificate", nothing more: an Apple Developer ID costs 99 USD a year and
a Windows certificate a few hundred. Until this is worth that, the warning
stays — and you can build it yourself from source and compare (see
[Quick start](#quick-start)).

The Android APK **is** signed, with a key that never leaves GitHub Secrets, so
updates install over the top. Since it does not come from the Play Store,
Android still asks you to permit installation from this source once.

## The thesis

No editor works seriously with code *and* Office documents *and* PDF. VS Code has no Office. LibreOffice has no code editor. Acrobat does PDF only. ulEditor fills that gap — **not by writing its own engines, but as a shell that orchestrates existing mature projects** behind a single UX, a shared search and a cross-format clipboard.

## Format status

| Format | State | Engine |
|---|---|---|
| Code, text (**24 languages**, incl. `.bat`, `.ps1`, shell, YAML, TOML, Go, Ruby, Swift, Lua) | **works** | CodeMirror 6 (+ a batch mode of our own — nothing anywhere had one) |
| Markdown | **works** — source + live preview + reading mode | CodeMirror 6 + markdown-it |
| **EPUB** | **works** — chapters, pages, table of contents, remembered position | own reader (fflate + DOMPurify) |
| PDF | **works** — viewing, zoom, text layer, search, reading | pdf.js *(desktop → pdfium, phase 1)* |
| PDF annotations | **works** — highlights, notes, ink | pdf-lib |
| **PDF text** | **works** — typing text, font, size, colour, moving | pdf-lib + Liberation Sans |
| **PDF redaction** | **works** — text leaves the content stream, it is not covered up | own content-stream reader |
| **PDF text editing** | **works** — click an existing line and rewrite it, in the document's own font | the same + pdf-lib |
| PDF pages | **works** — rotate, delete, reorder, merge, extract | pdf-lib |
| **DOCX** | **works — viewing + text editing** (headings, formatting, lists, tables, images) | own reader *(full editing → ProseMirror, phase 2)* |
| **DOC** (Word 97–2003) | **works — viewing** (headings, bold, lists, tables, fields) | own OLE2/FIB reader |
| **XLSX** | **works — viewing + cell editing** (sheets, formats, formulas, merged cells) | own reader + byte-range editing *(formulas → Univer, phase 2)* |
| **XLS** (Excel 97–2003) | **works — viewing + cell editing**; a save writes a new `.xlsx` beside the original | own OLE2/BIFF8 reader |
| **ODS** (OpenDocument) | **works — viewing + cell editing**, written back into the `.ods` itself | own reader + byte-range editing |
| **ODT** (OpenDocument) | **works — viewing** (headings, formatting, lists, tables, images) | own reader |
| Images | **works** — viewing, zoom, transparency, **OCR** | Tesseract (wasm) *(editing → image-rs, phase 1)* |
| **SVG** | **works — viewing** (zoom, fit, and the markup one button away) | own viewer — the drawing is loaded as an image, so it cannot run anything |
| **Illustrator** `.ai` | **works — viewing**, because an `.ai` holds a whole PDF and is detected as one | the PDF viewer |
| **3D models** | **works — viewing** (STL, OBJ, PLY, glTF, GLB, 3MF — turn, zoom, wireframe, triangle count) | three.js *(loaded only when a model is opened)* |
| **RTF** | recognised by its first bytes, not read yet — and no longer reported as a damaged Word file | — |
| Corel `.cdr`, EPS, PostScript | phase 2 — each says so on opening rather than showing a blank page | LibreOffice headless (libcdr) |
| PPTX, ODP, ODG | phase 5 | Univer Slides |

Formats that have no editor yet open with **a clear explanation of what is missing and when it arrives**, not with a blank screen.

**The bytes decide, and they outrank the name.** Running the readers over a
folder of real documents turned up two files whose names lied: Rich Text saved
as `.doc`, and a tab-separated instrument export saved as `.xls`. Both were
perfectly good files, and both were handed to a binary reader that could only
report them as damaged. A format that is *defined* by a signature — PDF, the
OOXML and OpenDocument containers, the old binary Office pair — is therefore
never accepted on the strength of its extension alone: if none of the
signatures matched and what is left reads as text, it opens as text. Formats
that genuinely are text keep their own readers, so an ASCII `.stl` is still a
model and an `.svg` is still a drawing.

Annotations are written as **real PDF objects** (`/Highlight`, `/Text`, `/Ink`), not as a drawing stamped into the page — Acrobat and other readers open, edit and delete them as their own. Annotations already present in a file are loaded and displayed.

**Text is typed with the `T` tool** — click where it belongs and type; the box grows with the text, so what you see while typing is already what will land in the file. Afterwards it can be dragged with the mouse and reopened with a click. It is saved as a `/FreeText` **with its own appearance stream**: without one, such an annotation is invisible in pdf.js and in browsers — that is, everywhere except Acrobat.

The font is **embedded**, and that is a necessity rather than a nicety: the standard fourteen PDF fonts use WinAnsi, in which `č ć ž š đ` do not exist. We use Liberation Sans, which ships with pdf.js anyway (SIL OFL 1.1), so no font is committed to the repository, and only the subset of glyphs actually used goes into the file — a signature on a form adds about 9 KB. A character the font does not know is reported **while you type**, rather than quietly turning into a blank.

**Deleting text with the `⌫` tool** drags a rectangle over what has to go and **removes the glyphs from the page content stream**. A black rectangle over text is not deletion: the text stays in the file and comes back out through selection, copying, or any tool that reads PDF — a mistake that has repeatedly published the very thing it was meant to hide. The space the glyphs occupied is made up with an offset in the `TJ` array, so the rest of the line stays exactly where it was.

When it **cannot be guaranteed** that everything was removed — a font without a widths table, Type3 glyphs, text inside a Form XObject — the page is left alone and the reason is stated immediately, while the user is still looking at the spot. A redaction that quietly misses part of the text is worse than none at all.

**Editing existing text** uses the `T✎` tool: click a line and it opens filled with what is written there.

Normally the line is rewritten **in the document's own font**: the instruction that draws it is written again with the codes of the font already on the page, so the letterforms, the size, the colour and the baseline are the ones that were there. Nothing is embedded and nothing is covered. The page is then redrawn from the edited bytes, so what is on screen is what the file holds.

A visible line is rarely one instruction — `€93.89` on an invoice is often the sign in one and the figure in another, and a sentence is frequently a word per instruction. The instructions that share a baseline, a font, a size and a colour, and sit close enough together to read as one line, are gathered into one; the label in the next column of the same row is far enough away to stay a separate thing. A word space is not always a letter either: TeX and others write it as a gap in the `TJ` array, so a line that says `TestDisk Documentation` on the page holds no space at all — and a space typed into such a line is written the same way the document writes its own.

Only what you actually changed is written: the rest keeps its own bytes, its own kerning and its own place. The line then reflows inside itself — what follows the change moves by exactly what it gained or lost — while every instruction still advances the pen by exactly as much as before, so the column beside it and the line below it do not move at all.

What can be written is decided by **what the page already draws**. Every code the reader has drawn there has a glyph behind it by definition, so writing that code again draws the same letter — no map has to be trusted for it, and the font's own `/ToUnicode` read backwards adds whatever else it promises. That is what makes real documents editable: an invoice from a payment processor embeds a subset of its font and often ships no `/ToUnicode` at all, and going by the map alone not one letter of it could be written.

The limit is what remains honest: a `č` typed into a document that never drew one has no glyph to come from. Then — and only then — the old line leaves the content stream and the new one is written with our embedded font on the same baseline, in the same size and colour. For Helvetica and Arial nothing moves; Liberation Sans is metrically identical. For other fonts the letterforms change, and **which characters** forced it is said while you are still typing.

Rotated text, stretched text, an invisible OCR layer and a font without a `/ToUnicode` table are **not offered for rewriting** — each with its own reason, rather than letting a replacement sit crooked or having letters guessed at.

Page operations do not change the document until it is saved — until then there is only a *plan*. Rotating and deleting work on the original without loss; reordering requires re-imposing pages, so the loss of annotations and forms is **reported before saving** instead of happening silently.

**Text in Word can be rewritten** — double-click it. The unit of change is a `w:r`, a piece of text with a single formatting: a paragraph often holds a dozen of them, so rewriting a whole paragraph would require the program to guess which formatting applies to which new letter. A run is rewritten without a single such decision.

The XML is **not re-serialised**; only the byte ranges the user touched are changed, and every other part of the archive — styles, numbering, images, metadata — passes through untouched. The verification measures exactly that: after saving, every other part must be **byte for byte identical**. Runs holding a line break, a tab, a drawing or split text are not offered for editing, because there more than the text would change.

**Cells in a spreadsheet are retyped the same way** — double-click one. A cell holding a formula does not open, and says which formula it holds: the number on screen is a *result*, and overwriting a result with a literal is the quietest way there is to destroy a workbook. When an edited workbook does contain formulas, it is marked for full recalculation, so Excel works the totals out again on opening instead of showing stale ones.

A date typed the way a person writes one — `15.6.2026.` — is stored as a date rather than as those characters, so the cell's own format keeps drawing it the way the sheet already drew it. Excel stores a date as a count of days, and counts a 29 February 1900 that never happened; the offset every library uses is right from 1 March 1900 onward and one day out below it. That is the quietest sort of wrong there is — an archival record dated 1898 simply arrives on the wrong day and nothing looks broken — so the arithmetic follows Excel's, bug included, and a date older than the first one it can store is refused rather than moved a century.

Everything the view does not show — headers, footnotes, comments, charts — is listed in the bar above the document, before anything is saved rather than after.

### OpenDocument, without LibreOffice

`.odt` and `.ods` open with **our own reader**. The plan had them arriving through LibreOffice running headless; that is still the right instrument for `.cdr` and PostScript, which hold drawing models nobody else implements, but it is the wrong one here. An OpenDocument file is a ZIP of XML, exactly like the OOXML alongside it, and requiring a four-hundred-megabyte office suite before a spreadsheet will open is a bigger imposition than the reader is a piece of work.

The format returns the favour in two places. A cell carries **both** the number and the text the writing program drew for it, so the grid shows exactly what LibreOffice showed without a single format code being interpreted here. And empty space is written as a repeat count rather than as cells — which is also the one thing that has to be handled carefully, since a real sheet says its last row repeats a million times and a reader that believes it allocates a million rows to show nothing.

`.ods` is **edited in place**: a save writes the `.ods` it came from, changing only the cells that were retyped, exactly as `.docx` and `.xlsx` are. No conversion, no second file in somebody else's format.

The awkward part is that **a cell there has no address**. A worksheet in OOXML says `<c r="B4">` and can be found by name; in OpenDocument a cell's position is wherever the counting has reached, and the counting is done in repeat attributes — `table:number-columns-repeated="1021"` stands for a thousand cells nobody wrote. Putting a value in one of them means splitting the group: the run before it, the cell itself, the run after, with the counts either side still adding up to what the group stood for. The same again one dimension up for a repeated row. Only rows holding an edit are rebuilt, and inside a rebuilt row every untouched cell is copied across as its original bytes — the verification checks that every other part of the archive comes back byte for byte, and that `mimetype` goes back first and uncompressed, which is what lets any program tell what the file is without unpacking it.

`.odt` opens **read-only** and says so — the Word editor rewrites a run by cutting into the bytes it came from, nothing here has been proven to that standard yet, and an editor that cannot say what it will do to the file it saves is the thing this project refuses to ship.

### The binary formats of 1997

`.doc` and `.xls` open too, with readers of their own. Until they did, a `.doc` produced the worst message in the program — *"this file is probably damaged"* — when it was nothing of the kind. It was written before 2007, which is where a great deal of what people actually keep still lives: contracts, minutes, court filings, everything an office wrote in the decade the format was the default.

Nothing about a `.doc` resembles a `.docx`. There is no XML and no archive of parts, and the text is not stored in reading order at all. It lies scattered through the file in whatever order successive saves left it, and a **piece table** says which run of bytes holds which run of characters. Each piece declares its own width, and this is where a Croatian document gets interesting: a narrow piece is one byte per character in **CP1252**, which has `ž` and `š` but not `č`, `ć` or `đ`. So Word writes the paragraphs that need those wide and the rest narrow, **in the same file** — and a reader that assumes one encoding garbles precisely the documents written here. Both are read, and the fixture holds both on purpose.

Which paragraph is a heading and which words are bold is not stored beside the text either. It lives in a second index of 512-byte pages keyed by **byte position**, so every character has to be converted back from where it is being read to where it sits in the file before its formatting can be looked up. A heading is then recognised two ways, because files do it both ways: by the number Word gives its own styles, and — for a style somebody made — by its name, which in a document written here is `Naslov 1`.

And a table is not an element but **punctuation**: a paragraph ending in a cell mark instead of a paragraph mark means "this was a cell", and a paragraph carrying `sprmPFTtp` means "the row ended here". The grid is inferred rather than read.

Both open **read-only**, and that is a judgement rather than a shortfall. Everything in these formats is positional — the piece table, the property pages and the field boundaries all point at byte offsets — so inserting one character means rewriting every index that points past it. There is no seam to cut along, so no `edit` is claimed: the reader hands the view over without one, which is how this codebase says read-only, and the bar above the document says it in words.

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

pnpm verify:i18n      # the Croatian catalogue keeps up (no browser, instant)
pnpm verify           # runtime check of the shell (needs `pnpm dev` running)
pnpm verify:reading   # reading room, EPUB, Word and Excel viewing
pnpm verify:ocr       # OCR, the panel below, interface language switching
pnpm verify:export    # text export to txt / md / docx / pdf
pnpm verify:pdf       # annotations and page operations (no browser)
pnpm verify:odf       # OpenDocument dates and formulas (no browser)
pnpm verify:doc       # the old binary Word, read off a hand-built file (no browser)
pnpm fidelity         # a folder of real documents, edited and checked byte for byte
pnpm verify:all       # all of the above

pnpm verify:search    # project search, in the REAL desktop application
```

`verify:search` starts the program itself with the WebView2 debug port open and
attaches to it over CDP. Search lives in Rust and is reachable only through a
Tauri command, so checking it in a browser would test the glue instead of the
work.

`verify:ocr` downloads a language model on first run; with no network it reports
as skipped, not as passed.

`fidelity` is the harness the plan called for, built to measure what this
program actually promises rather than what the plan assumed it would. The plan
said: open every document, save it, render both to PDF and compare the pages.
That measures a program which re-lays-out what it opened, and this one does not
— a `.docx`, an `.xlsx` and an `.ods` are edited by byte range, so the question
worth asking is not *does it still look the same* but **did anything else
move**. Point it at a folder and, for each document, it retypes three pieces
spread across the file, writes the result in memory, and checks that every other
part of the archive comes back byte for byte, that the rewritten part differs
only inside the elements it was told to rewrite, that the file reopens, and that
the shape the next save depends on — Word's run ordinals, a spreadsheet's grid
geometry and formula cells — is unchanged. For the read-only formats it checks
that nothing arrived as mojibake. **It never writes to the corpus.**

With no folder named it runs over the fixtures instead and says so: that proves
the harness still works, not that the readers do. Real documents are somebody's
and do not belong in a repository, which is why this is the one check CI cannot
meaningfully run. Its first run over one real Documents folder measured 131
documents and found seven files listed as Word documents that were Word's own
lock files.

`verify:i18n` exists because the i18n design hides its own gaps: the key is the
English source text, so an untranslated string renders as English and nothing
fails. It also compares the placeholders on both sides — a translation that
renames `{n}` still looks like a translation, and reaches the reader as literal
braces.

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
| [packages/i18n/](packages/i18n/) | Interface translations — flat JSON keyed by the English source, see [TRANSLATING.md](docs/TRANSLATING.md) |
| [packages/text-export/](packages/text-export/) | Text → txt / md / docx / pdf, with no external tool |
| [tools/verify-i18n.mjs](tools/verify-i18n.mjs) | The translation catalogue against the source |
| [tools/verify-ui.mjs](tools/verify-ui.mjs) | Runtime check of the shell through Chromium |
| [tools/verify-reading.mjs](tools/verify-reading.mjs) | Runtime check of the reading room and Office viewing |

## Licence

Core and all first-party editors: **Apache-2.0** ([LICENSE](LICENSE)).

Copyleft engines (MuPDF, ONLYOFFICE, HyperFormula) — should they ever be needed — go into `plugins/` as separate opt-in packages under their own licence, never into the core. [deny.toml](deny.toml) enforces that in CI.

## Documentation

- [Analysis and plan](docs/ANALYSIS-AND-PLAN.md) — architecture, library choices, roadmap, risks
- [ADR 0001: choosing the runtime](docs/adr/0001-runtime.md) — phase 0 results and the go/no-go decision
- [Translating](docs/TRANSLATING.md) — adding a language: one JSON file, no programming needed, and a partial translation is welcome
- [Releases](docs/RELEASE.md) — how one tag produces desktop installers and a phone APK
- [Phase 0 prompt](docs/PROMPT-PHASE-0.md)
