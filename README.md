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

## Updates

The program looks for a new version **once a day, silently**, and says something
only when there is something to say. `Help → Check for updates…` asks
immediately; `Help → Check for updates on start` is a tick beside it and turns
the automatic one off.

**What it sends: one GET for a static file.** No identifier, no telemetry,
nothing about the documents open — not even the version being run, since the
comparison happens on this side, on what came back. Only if you say yes does it
fetch anything else, and that is the installer.

**What makes it safe.** "Download an executable from the internet and run it" is
the shape of the worst thing a program can do to somebody. Every artefact is
signed at build time with a key whose private half never leaves GitHub Secrets,
and the public half is compiled into the application: an update that does not
verify against it is refused before a byte of it is executed. The request is
made by the Rust side rather than by the window, so the page's own sandbox is
not widened by one host for this feature.

The installers are still **not code-signed** for the operating system — that is
the certificate mentioned above, a purchase rather than a piece of work. So an
update installs the way the first download did, warning included, and on macOS a
new copy needs the same right-click → *Open* the first time.

## The thesis

No editor works seriously with code *and* Office documents *and* PDF. VS Code has no Office. LibreOffice has no code editor. Acrobat does PDF only. ulEditor fills that gap — **not by writing its own engines, but as a shell that orchestrates existing mature projects** behind a single UX, a shared search and a cross-format clipboard.

## Format status

| Format | State | Engine |
|---|---|---|
| Code, text (**24 languages**, incl. `.bat`, `.ps1`, shell, YAML, TOML, Go, Ruby, Swift, Lua) | **works** | CodeMirror 6 (+ a batch mode of our own — nothing anywhere had one) |
| Markdown | **works** — source + live preview + reading mode + **diagrams** | CodeMirror 6 + markdown-it (+ mermaid, fetched only when a diagram is there) |
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
| **ODT** (OpenDocument) | **works — viewing + text editing** (headings, formatting, lists, tables, images) | own reader + byte-range editing |
| Images | **works** — viewing, zoom, transparency, **OCR**, and **editing**: turn, mirror, crop, resize, change format | Tesseract (wasm) + `image` in the Rust core |
| **SVG** | **works — viewing** (zoom, fit, and the markup one button away) | own viewer — the drawing is loaded as an image, so it cannot run anything |
| **Illustrator** `.ai` | **works — viewing**, because an `.ai` holds a whole PDF and is detected as one | the PDF viewer |
| **3D models** | **works — viewing** (STL, OBJ, PLY, glTF, GLB, 3MF — turn, zoom, wireframe, triangle count) | three.js *(loaded only when a model is opened)* |
| **RTF** | **works — viewing**, including files named `.doc` that are Rich Text underneath | own reader |
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

**Both are edited in place**: a save writes the file it came from, changing only the cells or the words that were retyped, exactly as `.docx` and `.xlsx` are. No conversion, no second file in somebody else's format.

The awkward part is that **a cell there has no address**. A worksheet in OOXML says `<c r="B4">` and can be found by name; in OpenDocument a cell's position is wherever the counting has reached, and the counting is done in repeat attributes — `table:number-columns-repeated="1021"` stands for a thousand cells nobody wrote. Putting a value in one of them means splitting the group: the run before it, the cell itself, the run after, with the counts either side still adding up to what the group stood for. The same again one dimension up for a repeated row. Only rows holding an edit are rebuilt, and inside a rebuilt row every untouched cell is copied across as its original bytes — the verification checks that every other part of the archive comes back byte for byte, and that `mimetype` goes back first and uncompressed, which is what lets any program tell what the file is without unpacking it.

**Text in an `.odt` is retyped like text in a Word document** — double-click it — and what is rewritten is a different unit, because the format keeps its formatting somewhere else. Word wraps every piece of text in a `w:r` that carries its own bold and italic, so the run is what can be replaced and a run holding a line break or a picture has to be refused. Here the formatting is an *ancestor* — a `text:span` around the text, or the paragraph itself — so what is replaced is the text, and a break or an image beside it simply ends one piece and begins the next. Nothing has to be refused for carrying foreign content, because a piece carries none.

Except spacing, which **is** content here. OpenDocument collapses runs of whitespace exactly as HTML does, so a run of spaces is written as an element — `<text:s text:c="3"/>` — and so is a tab. Those belong to the piece rather than breaking it: they are read into its text and written back out as elements, so two spaces typed after a full stop are still two spaces when LibreOffice opens the file, and the piece that held them is still one piece afterwards. That last part matters more than it sounds: the ordinals the page was built with have to still mean the same text after a save, or the next edit lands in the wrong sentence.

And one question a spreadsheet never has to ask: **is the sentence on the screen the sentence in the file?** The page is built from the parsed tree while the rewrite cuts into the raw bytes, and nothing guarantees on its own that the two are looking at the same words. So they are paired — each piece knows which element holds it, counted the same way on both sides — and then made to agree, letter for letter, before an edit is offered anywhere. Where they disagree, for whatever reason, the text is still read, searched and shown; it is simply not offered for retyping, and the cost is one paragraph rather than the document.

### The binary formats of 1997

`.doc` and `.xls` open too, with readers of their own. Until they did, a `.doc` produced the worst message in the program — *"this file is probably damaged"* — when it was nothing of the kind. It was written before 2007, which is where a great deal of what people actually keep still lives: contracts, minutes, court filings, everything an office wrote in the decade the format was the default.

Nothing about a `.doc` resembles a `.docx`. There is no XML and no archive of parts, and the text is not stored in reading order at all. It lies scattered through the file in whatever order successive saves left it, and a **piece table** says which run of bytes holds which run of characters. Each piece declares its own width, and this is where a Croatian document gets interesting: a narrow piece is one byte per character in **CP1252**, which has `ž` and `š` but not `č`, `ć` or `đ`. So Word writes the paragraphs that need those wide and the rest narrow, **in the same file** — and a reader that assumes one encoding garbles precisely the documents written here. Both are read, and the fixture holds both on purpose.

Which paragraph is a heading and which words are bold is not stored beside the text either. It lives in a second index of 512-byte pages keyed by **byte position**, so every character has to be converted back from where it is being read to where it sits in the file before its formatting can be looked up. A heading is then recognised two ways, because files do it both ways: by the number Word gives its own styles, and — for a style somebody made — by its name, which in a document written here is `Naslov 1`.

And a table is not an element but **punctuation**: a paragraph ending in a cell mark instead of a paragraph mark means "this was a cell", and a paragraph carrying `sprmPFTtp` means "the row ended here". The grid is inferred rather than read.

Both open **read-only**, and that is a judgement rather than a shortfall. Everything in these formats is positional — the piece table, the property pages and the field boundaries all point at byte offsets — so inserting one character means rewriting every index that points past it. There is no seam to cut along, so no `edit` is claimed: the reader hands the view over without one, which is how this codebase says read-only, and the bar above the document says it in words.

### Diagrams in Markdown

A ```` ```mermaid ```` fence is drawn instead of printed — flowcharts, sequence
diagrams, state machines, everything mermaid knows.

**The library is not fetched until a diagram is on the page.** Mermaid is two
thirds of a megabyte gzipped and almost no Markdown holds a diagram, so it is
imported the first time a fence appears and not when the editor mounts; the
check watches the network to make sure that stays true. Nothing is loaded from
anywhere else either — it is bundled, like everything here.

A drawn diagram is **kept**, keyed by its own source and by the theme it was
drawn in, because the colours are baked into the SVG: typing in the paragraph
below redraws nothing, and switching to the dark theme redraws everything. The
labels are written as `<text>` rather than as HTML in a `foreignObject`, which
is what lets the sanitiser keep them and the reading room paginate around them.

And **a diagram that will not parse says so**, in the place the picture would
have taken, with mermaid's own message and the source kept in front of the
person who has to correct it. A preview that swallowed the error would leave a
blank space, which looks exactly like a diagram that drew nothing.

### Editing a picture

Turning, mirroring, cropping, resizing and a change of format — and **nothing is
written until a save**. Until then there is a *plan*: the browser turns the
picture with a CSS transform for nothing, the pending crop is a rectangle drawn
over it, and the bar says what the file will be — `1200 × 800 px · will be saved
as 600 × 400 JPEG · recompressed`. It is the same rule the PDF page operations
follow, for the same reason.

**The pixels are touched once, in Rust.** A photograph out of a phone is forty
megapixels, which is a hundred and sixty megabytes of RGBA — decoding that in
the webview to preview a rotation would be absurd, and every browser's encoder
draws its quality knob differently. So [crates/ul-image/](crates/ul-image/) reads
the file, applies the plan and writes the result; what crosses the boundary is
five numbers and two flags. The same code will serve the phone.

Three details are worth naming:

- **The turn happens before the crop.** A crop arrives as a rectangle somebody
  dragged over what was on their screen, and what was on their screen was
  already turned — so cropping first would mean mapping that rectangle back
  through the preview, which is arithmetic in the one place a mistake is
  invisible: the picture would simply come out cropped somewhere else.
- **A phone photograph is stored sideways**, with an Exif tag saying which way is
  up, and every viewer obeys the tag. Nothing here writes Exif back, so the
  rotation the tag asks for is applied to the pixels instead — otherwise the
  first save would turn every phone photograph on its side. The bar says so
  before it happens.
- **A change of format writes a new file beside the original.** JPEG bytes in a
  file called `.png` is a file that lies about itself, and everything downstream
  believes the name first. The old `.xls` already behaves this way, and the tab
  follows the file it wrote.

Formats that can be written back: PNG, JPEG, WebP, BMP, TIFF. A GIF or an `.avif`
opens, zooms and goes through OCR, and offers to be saved as PNG — saying so in
the format box rather than refusing at the end.

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
pnpm verify:providers # a format says the same thing in both places it is declared
pnpm verify           # runtime check of the shell, the menus and the interface language (needs `pnpm dev` running)
pnpm verify:reading   # reading room, EPUB, Word and Excel viewing
pnpm verify:ocr       # OCR, and the panel below
pnpm verify:export    # text export to txt / md / docx / pdf
pnpm verify:mermaid   # diagrams in Markdown — and that mermaid is not fetched without one
pnpm verify:updates   # the updater: key, endpoint, permissions, manifest (no network)
pnpm verify:pdf       # annotations and page operations (no browser)
pnpm verify:odf       # OpenDocument dates and formulas (no browser)
pnpm verify:odt       # retyping text in an .odt: spacing, refusals, byte ranges (no browser)
pnpm verify:doc       # the old binary Word, read off a hand-built file (no browser)
pnpm fidelity         # a folder of real documents, edited and checked byte for byte
pnpm verify:all       # all of the above

pnpm verify:search           # project search, in the REAL desktop application
pnpm verify:office-editing   # retyping a .docx and an .odt out to disk and back, in the same
pnpm verify:desktop-ocr      # OCR under the application's own CSP
pnpm verify:desktop-diagram  # a Markdown diagram under the same CSP
pnpm verify:desktop-image    # turning, cropping and converting a picture, out to disk and back
pnpm verify:desktop-updates  # the update check, in the program, where the plugin exists
```

Those six start the program itself with the WebView2 debug port open and attach
to it over CDP, because each asks something a browser cannot answer. Search lives
in Rust and is reachable only through a Tauri command, so checking it in a
browser would test the glue instead of the work; a save has to cross the same
boundary before it is a save at all — `verify:office-editing` types into a
document, presses `Ctrl+S`, and then reads the file back off the disk to see what
actually landed in it.

The last two are there for the **CSP**, which the application has and a dev
server does not. That difference has already cost this project once: OCR worked
in the browser and would not have worked in the application, because Tesseract
was fetching its worker off a CDN. Both checks therefore count what leaves the
window — for a feature that is bundled, the answer has to be nothing — and fail
on any console message about a refused request.

`verify:ocr` needs no network, and that is the first thing it checks. The
worker, the wasm core and both language models are served by the application
itself out of `/ocr/`, copied there by `tools/ocr-assets.mjs` on every build —
so a build that skipped that step **fails** this check, where it used to report
a network problem and pass.

`fidelity` is the harness the plan called for, built to measure what this
program actually promises rather than what the plan assumed it would. The plan
said: open every document, save it, render both to PDF and compare the pages.
That measures a program which re-lays-out what it opened, and this one does not
— so the question worth asking is not *does it still look the same* but **did
anything else move**.

For an Office document, which is edited by byte range, it retypes three pieces
spread across the file, writes the result in memory, and checks that every other
part of the archive comes back byte for byte, that the rewritten part differs
only inside the elements it was told to rewrite, that the file reopens, and that
the shape the next save depends on — Word's run ordinals, an OpenDocument
document's pieces and their ranges, a spreadsheet's grid geometry and formula
cells — is unchanged. For the read-only formats it checks that nothing arrived
as mojibake.

For a PDF it performs the four operations the editor offers and compares the
**content stream of every page**, which is a stricter question than comparing
extracted text: it asks whether anything at all on the page moved, including
what text extraction cannot see. Annotating and rotating must leave every page
byte-identical and declare no loss; deleting a page must leave the others
exactly as they were, in their own places; reordering must keep every page
whole in its new place *and* say what it costs, since it rebuilds the document
and bookmarks, forms and attachments do not survive the copy. A save that
quietly lost a page as well would read the same to somebody looking at that
warning.

**It never writes to the corpus.** With no folder named it runs over the
fixtures instead and says so: that proves the harness still works, not that the
readers do. Real documents are somebody's and do not belong in a repository,
which is why this is the one check CI cannot meaningfully run — and it takes
minutes, not seconds. Over one real Documents folder it measures **599
documents, 468 of them PDFs**, and the run that first did so found seven files
listed as Word documents that were Word's own lock files.

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
