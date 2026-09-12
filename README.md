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

**Status:** phases 0 and 1 complete, phase 2 well under way. The desktop app runs, thirteen editors work, e-books and Office documents open — Word, Excel and OpenDocument alike, back to the binary formats of 1997 — and the window splits in two. Since v0.4.0 a Word document is no longer only retyped but restructured: **a paragraph can be added or taken away, Enter splits one in two, Backspace joins them back, and a row is added to a table** — each of them written into the bytes the file already had rather than a file we serialise afresh, and each answered by asking Word itself what it writes there. A spreadsheet of a hundred thousand rows scrolls, and a window that goes white now leaves a report saying so instead of nothing. The interface is in English; Croatian can be selected in settings.

What phase 1 asked for and still has not got: **the installers are not code-signed**, so Windows and macOS both warn on first launch — see [below](#the-warning-you-will-see-and-why). That is a certificate to buy, not code to write; the Android build is signed, and the update signature is ours rather than an operating system's, so that part needed no purchase.

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
| Code, text (**24 languages**, incl. `.bat`, `.ps1`, shell, YAML, TOML, Go, Ruby, Swift, Lua) | **works**, and where a language server is installed: **diagnostics, hover, completion and go-to-definition** | CodeMirror 6 (+ a batch mode of our own — nothing anywhere had one) + `crates/ul-lsp` |
| Markdown | **works** — source + live preview + reading mode + **diagrams** | CodeMirror 6 + markdown-it (+ mermaid, fetched only when a diagram is there) |
| **EPUB** | **works** — chapters, pages, table of contents, remembered position | own reader (fflate + DOMPurify) |
| PDF | **works** — viewing, zoom, text layer, search, reading | pdf.js. The planned swap to pdfium is **not taken**: measured over 457 real documents, the first page is on the screen in half a second |
| PDF annotations | **works** — highlights, notes, ink | pdf-lib |
| **PDF text** | **works** — typing text, font, size, colour, moving | pdf-lib + Liberation Sans |
| **PDF redaction** | **works** — text leaves the content stream, it is not covered up | own content-stream reader |
| **PDF text editing** | **works** — click an existing line and rewrite it, in the document's own font | the same + pdf-lib |
| PDF pages | **works** — rotate, delete, reorder, merge, extract | pdf-lib |
| **DOCX** | **works — viewing + text editing** (headings, formatting, lists, tables, images), and paragraphs split with Enter, joined with Backspace and Delete, added and removed | own reader *(full editing → ProseMirror, phase 2)* |
| **DOC** (Word 97–2003) | **works — viewing** (headings, bold, lists, tables, fields) | own OLE2/FIB reader |
| **XLSX** | **works — viewing + cell editing** (sheets, formats, formulas, merged cells), every row kept and scrolled as a window — measured at 100 000 rows | own reader + byte-range editing *(formulas → Univer, phase 2)* |
| **XLS** (Excel 97–2003) | **works — viewing + cell editing**; a save writes a new `.xlsx` beside the original | own OLE2/BIFF8 reader |
| **ODS** (OpenDocument) | **works — viewing + cell editing**, written back into the `.ods` itself | own reader + byte-range editing |
| **ODT** (OpenDocument) | **works — viewing + text editing** (headings, formatting, lists, tables, images) | own reader + byte-range editing |
| Images | **works** — viewing, zoom, transparency, **OCR**, and **editing**: turn, mirror, crop, resize, change format | Tesseract (wasm) + `image` in the Rust core |
| **SVG** | **works — viewing** (zoom, fit, and the markup one button away) | own viewer — the drawing is loaded as an image, so it cannot run anything |
| **Illustrator** `.ai` | **works — viewing**, because an `.ai` holds a whole PDF and is detected as one | the PDF viewer |
| **3D models** | **works — viewing** (STL, OBJ, PLY, glTF, GLB, 3MF — turn, zoom, wireframe, triangle count) | three.js *(loaded only when a model is opened)* |
| **RTF** | **works — viewing**, including files named `.doc` that are Rich Text underneath | own reader |
| Corel `.cdr`, EPS, PostScript, PostScript-only `.ai` | **works — viewing**, as the PDF LibreOffice makes of them; without it installed, the page says which formats that costs | LibreOffice headless (libcdr), through `crates/ul-convert` |
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

**And a paragraph can be added** — `Ctrl+Enter`, or *Edit ▸ Insert paragraph below*. It is the first change here that is not a substitution: until now something was replaced by something else the same shape, and now something exists that did not before. Three things follow from that, and not one of them was reasoned out in advance — each is what was left after a design had been written and refuted. Four were, in the end.

*It is a plan, not a write.* Nothing is applied until a save, and a save applies the whole plan to the file **as it was opened** — which is the shape the PDF editor already settled on for pages. So saving twice writes the same bytes, no ordinal ever shifts under a paragraph you are pointing at, and a paragraph added ten minutes and two saves ago can still be taken back. An editor that applied the insertion and then built on the result would have had to renumber everything after it, clear the history to stay consistent, and leave the person with a paragraph only Word could remove.

*The properties are resolved, not copied.* A heading is not a heading because of the bytes in its `w:pPr` — it is a heading because its `w:pStyle` names a style, and that style says in `w:next` what the paragraph after it should be. Copying the bytes gives a second heading, complete with a new entry in the contents panel; reading `w:next` gives what Word gives, which is body text. Of the 49 real documents this was measured on, nine declare `w:next` at all — 90 declarations, and every heading style among them hands on to body text (`Naslov1 → Normal`, `Heading → Tijeloteksta`). The indentation, the alignment, the spacing and the list membership *are* copied byte for byte, because they are what continuing a paragraph means. A section break and a tracked-change mark are never copied — one would split the document where nobody asked, the other would sign somebody else's name to your edit. And the text takes the formatting of the run it follows rather than the document default, because a title whose size is direct formatting on its runs would otherwise hand the new line a 12pt sentence to sit under a 48pt heading.

*Where it may not go, it says so.* A paragraph inside a table cell is refused out loud, because the grid around it declares row and column counts this program does not maintain. That is not a rare corner: across those 49 documents 999 of 2235 paragraphs are inside a `w:tc`, and five of them are schedules with nowhere at all to put a new paragraph — `pnpm verify:insert` names those five rather than counting them as passes. A command that appeared to do nothing there would teach people the program is unreliable, rather than that a table is a different problem.

An OpenDocument text opened in the very same editor is offered none of this, and not by a check on the file's extension: the capability lives on the seam the editor writes through, so a format with nothing to say about structure offers nothing, and the editor above never learns which format it is holding.

**And a paragraph the file already had can be taken away** — `Ctrl+Shift+Backspace`, or *Edit ▸ Remove this paragraph*. It is the same plan in the other direction: nothing happens to the file until a save, the paragraph stays in the view but hidden, `Ctrl+Z` brings it back even after a save, and every save applies the whole plan to the file as it was opened. It starts from the paragraph the cursor is in rather than from a piece of text, because the paragraphs people most want gone are blank lines with no text to start from — 397 of the 1263 body paragraphs in those 49 documents are empty spacers.

It is the harder half, and not by a little. A rewrite moves no ranges and an insertion consumes none; a removal consumes a range that other parts of the file may be half inside. Every rule below was bought by asking Word what it did with the result, and `pnpm verify:word` asks it again on every run — cutting each refused case by hand, bypassing the writer, so that the day Word stops doing one of these, the rule that refuses it will be seen to be refusing for nothing:

- **The paragraph between two tables is what keeps them two.** Remove it and Word's `Tables.Count` goes from 2 to 1 — adjacent tables are one table to Word — while the preview here would go on showing two. Twelve real paragraphs sit in that sandwich, three in one form and nine in one schedule.
- **A document cannot end on a table.** Remove the last paragraph behind one and Word puts a paragraph back: the count comes back unchanged. The file written would not be the file anybody reads.
- **Half a protected range is somebody's permission gone.** In a protected document whose editable stretch runs into the paragraph being removed, Word discards the orphaned start and with it the permission on a paragraph nobody touched — `Range.Editors.Count` goes `1,0,0 → 0,0`. The same rule refuses half a comment range and half a tracked move. A bookmark is **not** refused, and that was measured too: Word opens an orphaned bookmark half cleanly, and the corpus is full of Word's own `_GoBack`.
- **Not a section marker, and not half a field.** Over those 1263 body paragraphs no field crosses a paragraph boundary, so that rule defends a rare case — a reason to keep it, not a reason to trust it.
- **Not the last paragraph standing — counted against what the plan keeps, not what the file had.** Judged only against the original, every removal in a three-paragraph document passes on its own, and all three together leave a body with nothing in it: Word opens that by quietly inventing a paragraph, and ulEditor reopens it with no editable text at all, locked out of its own output. So each removal is judged against the survivors of the ones before it, in the view and again in the writer, which does not trust that it was asked first.

The design was attacked by four critics before a line of it was written, and they came back with two fatal findings and eight real ones. The permission case above was one of the fatal two. The other was in the gesture people will use most: add a paragraph, change your mind, remove it. The blur that finishes the typing had already dropped the empty paragraph from the plan, the removal then looked for it, got `-1`, and `splice(-1, 1)` removes the **last** element of a list — somebody else's paragraph, anywhere in the document, gone without an undo. The step is now looked up again after the blur, and one that is already gone is simply gone.

One finding was the implementation's rather than the design's, and the instrument found it. 1187 of the 1214 consecutive body paragraphs in the corpus touch with not a byte between them, so inserting after one paragraph and removing the next puts both operations at the same offset, and the removal has to be applied first — over the 45 real files that have such a pair, removal first is byte-exact in all 45 and the other order is wrong in all 45. The first build had the right order for the wrong reason: the removals happened to be pushed ahead of the insertions and a stable sort kept them there, so taking the stated rule out changed nothing — which is to say nothing depended on it. They are pushed last now, the rule is the only thing putting them first, and taking it out fails the check.

A numbered list is one counter in Word however many times it is interrupted, so removing its first item renumbers a group pages away. The browser numbers every group from one; the preview now carries each counter across its interruptions, so what it shows is what the reopened file will. Five lists in four real files are split that way, one of them into thirteen groups.

**And Enter splits a paragraph where the caret stands**, the way it does everywhere else a person types. It used to mean "done typing" here; finishing is clicking away now, and Enter in the middle of a sentence puts the rest of it on a line of its own, the caret at its start and the typing carrying on. At the end of what is written it begins a new paragraph with the style `w:next` hands on — which is the difference Word makes too: a heading split mid-sentence is two headings, a heading finished with Enter is followed by body text. With text selected, which is how every piece opens, Enter still means "done", so a double-click and Enter changes nothing, as it never did; so does it in a table cell and in an OpenDocument text.

It is the same plan again — nothing applied until a save, `Ctrl+Z` joining the pieces back even after one — and it carries more than a new paragraph does. The run the caret was in is divided, its formatting going with both halves, and every run that followed it in the paragraph moves into the new one byte for byte, unread. That is not a corner: the body paragraphs of those 49 documents hold 2.9 editable runs each on average, and only 362 of 1263 hold a single one, so a split that could not carry the rest would have refused most of the places a person presses Enter. `pnpm verify:split` asserts the whole of it as an exact identity — the output is the original with a paragraph boundary put inside one run and nothing else changed — on every real document with anything that may be split, 43 of 49, and fourteen deliberately broken builds of the writer each fail it. Word opens every split document with exactly one paragraph more, the line it showed once now two lines divided where the cut fell; LibreOffice reads 38 of them the same way, in the same save as rewrites, new paragraphs and removals.

Three things are refused, and the two that could be were bought from Word by cutting them by hand: a run inside a link — divided anyway, the link opens in one paragraph and closes in the next, and **Word will not open the file**; a paragraph that ends a section — divided with its properties, Word counts **one section more** than the document had; and a complex field's result run, whose `begin` is behind it and whose `end` is ahead. Of the 3628 editable runs in the corpus's body paragraphs, 13 sit inside a link or another such element; none in a field result, none in a section-ending paragraph.

Building it turned up two older bugs no check had asked about, both measured against the code as it stood before:

- **A save while the caret was still in the text wrote the text as it was before the typing.** The shell asks for a save without asking the caret to leave, and typing is written down when it leaves — hidden until now only because Enter wrote it down and people pressed Enter. A cell typed into and saved the same way lost its value too. Both editors now finish the typing before they write.
- **Any undo drew every bold and italic run in the document plain.** Undo put the text back with `textContent`, which replaces the elements the formatting is drawn with — on the fixture, `<strong>` 1 → 0 and `<em>` 1 → 0 after undoing a retype of an unrelated plain sentence. The file was never touched; the view was. The text now goes into the text node inside them.

**And Backspace joins them back.** At the very start of a line it joins the line onto the one above; Delete at the very end of one joins the next onto it — the same boundary taken away either way. Whose properties the joined paragraph keeps is a question the file cannot answer, so Word was asked, over COM, on documents Word made itself: **the first one's** — a heading with body text after it, joined, is a heading; body text with a heading after it is body text; centred and left is centred; a list item and body text is a list item; both keys, every time — **unless the first shows nothing**, where Word deletes it and the paragraph below keeps its own: an empty line before a heading, joined, is the heading. What counts as nothing was asked as well. A paragraph holding only a bookmark, a proofing mark, an empty text element, a run with nothing but formatting, or the page break Word remembers from its last layout is empty to it — the bookmark goes with it; a tab or a single space is not. So Backspace after an empty line removes the line, which is the plan's removal, and after anything else joins. A bookmark end standing between the two paragraphs is carried into the joined one, at the join, which is where Word puts it.

One key at a line's edge means four different things, and the editor tells them apart. Two lines Enter made of one paragraph are joined by taking the division back; two lines added here become one text; a line added here after one of the file goes onto the end of the piece it took its formatting from; and two paragraphs of the file are joined in the plan, written on save as the boundary between them and nothing else — the first one's closing tag, what stood between, the next one's opening tag and properties. `pnpm verify:join` asserts that as an exact identity on 43 of the 49 real documents, whose body paragraphs may be joined with the next in 1189 cases of 1214 (340 of those are empty, and are removals); 25 deliberately broken builds of the writer each fail it. Word opens every joined document it is given — 11 of 11 — with one paragraph fewer and one line where two stood, and then it is asked what the rest of this project only ever asks of us: it joins the same two paragraphs itself, with `Selection.TypeBackspace`, and the paragraph it makes has the same style, alignment, list, indents and spacing as the one it reads from ours, in 11 of 11 — four of them pairs whose properties differ, which are the ones that could tell the rule wrong. LibreOffice shows 23 real documents with the two lines as one, in the same save as rewrites, new paragraphs, removals and splits. `pnpm verify:lines` presses the keys in the editor a person types into — 50 checks, every save compared with the page line for line — and 24 broken builds of the editor each fail it.

Refused, each with its reason on the status line: a table between the two lines; a section's end on either side (joined by hand, Word counts one section fewer); a tracked change recorded on either paragraph's mark; a paragraph of the file joined onto a line added here; and a join in front of lines Enter made, where the two paragraphs' properties differ — the plan holds what was done, not in what order, and those lines would take the properties Word would have left them without.

**And in a table, the same key adds a row.** `Ctrl+Enter` means "a new paragraph after the one the cursor is in" everywhere else; with the cursor in a cell it means the same thing one unit up. What the new row looks like is again a question the file cannot answer, so Word was asked, over COM, on tables Word made itself — and Word's answer is **the row above, emptied**: the table property exceptions, the row properties, every cell's properties and every cell's *first* paragraph's properties, each byte for byte, with no content, no bookmarks and no vertical merge. A heading row that repeats on every page gives a row that repeats on every page; a row with a fixed height that may not break across pages gives one too; a cell shaded, widened, merged across columns, centred, bulleted or styled `Heading 1` gives a cell exactly like it. The style is **not** resolved through `w:next` the way a new paragraph's is, which is the difference between copying a row and beginning a paragraph. Text typed into a new cell takes the paragraph mark's own formatting, which is what Word gives it: a row added under a bold heading row is typed into bold.

One more answer was a surprise. A row asked for below a cell merged downwards arrives below the **last** row that merge reaches, not inside it — a merged cell stands in every row it spans — and the view draws it there, so the page shows where the file will hold it. `pnpm verify:rows` puts Word's own rows back through the writer and gets Word's own result in 10 of 10, the tenth differing only by the `xml:space="preserve"` this program always writes; 50 checks in all, and 26 deliberately broken builds of the writer each fail them. Over the real corpus, 10 of 53 documents hold a table — 35 tables, 228 rows, every one of them able to take a new row, 14 of those below a merge and 101 with a cell spanning columns — and each document comes back byte for byte identical outside the row that was added. Word opens every file a row was added to with one row more in that table and the same tables as before, and then it adds the same row itself: its cells have the same style, alignment, list, declared width, shading and weight as ours, in 4 of 4. LibreOffice shows the new row in 4 real documents, in the same save as 45 new paragraphs, 44 removals, 41 splits and 23 joins. `pnpm verify:table` presses the key in the editor a person types into — 33 checks, every save compared with the page row by row — and 21 of 22 broken builds of the editor fail it. Refused with a reason: a table inside a text box or a content control, which is a grid this view does not maintain; a row a reviewer is recorded as having inserted, which a copy would claim they made too; and a row with no cells to copy. A row nobody typed a single character into is not written at all, the rule a new paragraph keeps — an added row of empty cells would be a row nobody could ever put a cursor in again.

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

## One clipboard across the formats

Copy a range in a spreadsheet, paste it into a Markdown document, and it arrives
as **a table** — pipes, header rule and all — rather than as the tab-separated
line the operating system's clipboard carries. That is the part of the thesis
that only works if the whole program is one program.

**Copying is not intercepted.** The browser's own copy does what it always did,
and the system clipboard stays its business — so nothing here can break Ctrl+C.
What the shell does instead is *remember* the structure that went with the text:
the editor is asked for its payload, and it is held until something matching is
pasted. The plain text is the key, and it matches by construction, since both
sides serialise the same selection.

**Pasting is taken over only when an editor asks for it, synchronously.** A
`paste` event cannot be answered later — by the time a promise resolves the
browser has already pasted, or not — so the question is `acceptsPaste`, and an
editor that does not implement it is never interfered with. Markdown answers yes
to a table and to nothing else: for plain text the native paste is already
exactly right, and taking the event over would mean reimplementing it, undo
grouping included.

Two details are the difference between a feature and a nuisance. **A paste that
does not match what was copied here is left alone**, so a table copied an hour
ago cannot land in place of the sentence somebody copied out of their browser a
moment ago. And **the table is built from the cells rather than from the string**
— `td[data-ref]` is a cell of the sheet and the row-number gutter is not one —
while the plain text stays exactly what the browser produced, because that is
the key the two halves are matched by.

Whether the first row is a heading is a guess, and it is made out of what the
cells *are*: text across the whole first row with something that is not text
below it is the shape of `Month | Amount` over `January | 1.234,50`. Markdown has
no headerless table — the delimiter row is part of the syntax — so the
alternative to guessing is a blank strip above every pasted table.

### The three formats that need LibreOffice

`.cdr` is CorelDRAW's own and libcdr is the only thing that reads it. `.eps` and
`.ps` are PostScript — a programming language rather than a drawing, so showing
one means running an interpreter. An `.ai` saved without PDF compatibility is
PostScript inside. All three open here as **the PDF LibreOffice makes of them**,
through [crates/ul-convert/](crates/ul-convert/).

**This is the one place a four-hundred-megabyte office suite is the right
instrument**, and the contrast with `.odt` is the whole argument: an OpenDocument
file is a ZIP of XML, so requiring an installation before a spreadsheet would
open was a bigger imposition than writing the reader. These three hold drawing
models nobody has reimplemented, and there is no honest way to show one without
the code that understands it.

So LibreOffice is **optional and asked for by name**. Where it is installed, the
page offers a button; where it is not, it says which formats that costs and links
to the download. Nothing is bundled, nothing is downloaded, and no other format
is affected.

The conversion writes **into the temporary folder, never beside the original** —
the folder a `.cdr` lives in is usually somebody's work — and the notice says
that the PDF on screen is a copy.

Three things about driving LibreOffice from a command line are not obvious, and
each one is a conversion that silently does nothing:

- **a running LibreOffice takes the job and drops it.** The command talks to
  whichever instance already owns the user profile, and that one is busy showing
  somebody a document — so it exits 0 having produced no file. A profile of its
  own per run is the fix;
- **on Windows `soffice.exe` returns immediately.** It is a launcher; the process
  that does the work is another one. `soffice.com` is the console wrapper that
  waits, so it is preferred when present;
- **the exit code is not the answer.** It is 0 for a file it could not read, for
  a filter it does not have, and for the case above. So the output file is what
  is waited for, and a process that ends without one is the refusal it is.

### What the compiler says, in the margin

Where a language server is installed, a mistake is underlined with the
compiler's own words and counted in the status bar — `Line 12, column 8 · 2 ✕`.
Rust through rust-analyzer, TypeScript and JavaScript through
`typescript-language-server`, Python through pyright.

And three things it is asked rather than told:

- **What is this?** The pointer resting on a name brings up its signature and
  its doc comment.
- **What could this word become?** The completion list, while typing.
- **Where was it defined?** `F12`, `Ctrl+Click`, or **Edit → Go to definition**
  — and it opens the file it lands in, even when that file is somewhere nobody
  opened: the standard library, a crate under `~/.cargo`, a package inside
  `node_modules`.

**Nothing is bundled and nothing is downloaded.** A language server is somebody
else's program, often a large one, and installing it is a decision about the
machine rather than about this editor:

```
rustup component add rust-analyzer
npm install -g typescript-language-server typescript
pip install pyright
```

Where one is not installed the editor colours the code as it always did and
says nothing further — a person who has not installed rust-analyzer has not
asked for it, and an editor that complained about that on every file would be
telling them off for their own choice.

**A server is started for the project, not for the file**, and which directory
that is matters: point rust-analyzer at a folder holding fifty crates and it
indexes fifty crates. So the search walks up from the file to the folder that
was opened, and the choice between what it finds is per language — Rust takes
the **topmost** `Cargo.toml`, because a cargo workspace is one project and a
server started inside `crates/ul-core` would call every reference to the crate
next door an error; TypeScript takes the **nearest** `tsconfig.json`, because
the packages of a monorepo genuinely are separate compilations.

**The plumbing was the work**, and it was written for diagnostics first —
three separate silences, each of which is written down where it happened:

- **stderr sent to nowhere.** `rust-analyzer` on the PATH turned out to be a
  rustup shim with the component not installed: it printed one line and exited,
  and the client could only report that the output had closed;
- **a change the server threw away.** A `didChange` with no range means "replace
  everything" and may only be sent to a server that declared it accepts that.
  rust-analyzer declares incremental sync, so it discarded every change —
  silently, and no diagnostic ever arrived again for that file;
- **a question nobody answered.** A server also asks: rust-analyzer sends
  `workspace/diagnostic/refresh` with an id, and an unanswered request left it
  waiting and publishing nothing at all.

`UL_LSP_TRACE=1` prints the conversation in both directions, which is how two of
the three were found.

**Then asking turned out to need one thing publishing does not**: a way to know
which answer belongs to which question. A notification is finished when it has
been written; a request is finished when a message with the same id comes back,
on a thread that is not the one waiting for it. So a question leaves a channel
behind under its id, the thread that reads posts the answer into whichever
channel matches, and the question takes itself out of the register when it is
dropped — answered or not. Without that last part, every question a server never
got round to would leave a channel behind, one per keystroke.

**And two more silences, both of which needed a real server to show.**

The first was `\\?\`. Every path in this program goes through the workspace's
`resolve`, which canonicalises — and `fs::canonicalize` on Windows returns
`\\?\C:\dev\x`. Left on, that made the URL `file:////?/C:/dev/x`, which no
language server can parse. **And the underlines went on appearing**, because
rust-analyzer walks the project itself and publishes about files nobody opened:
the `didOpen` was ignored without a word, every question was about a document
the server had never heard of, and every answer came back empty — which looks
exactly like a server with nothing to say. It was found by asking the question
in the real application after it had passed against the same server in a test,
where the paths had never been canonicalised. There is a test for it now, and
what it asserts is that the two spellings of one path are one document.

The second was `content modified` — error `-32801`, and not a failure at all: it
is the server saying the document changed while it was thinking, so the answer
would have been about the previous keystroke. It is the *ordinary* case, since
every one of these questions is asked while somebody is typing, and a client
that read it as a refusal would have a tooltip that stops working for exactly as
long as anybody is working. So it has a name of its own in `LspError`, and the
question is asked once more against the document as it now is.

Three smaller decisions, each of which is a promise being kept rather than a
preference:

- **`snippetSupport: false`, and it is not a shortcut.** A snippet is
  `${1:name}` with tab stops, and claiming it means being able to expand one.
  Told no, rust-analyzer offers `push` where it would have offered
  `push(${1:value})` — a completion that compiles. Anything that arrives as a
  snippet anyway is flagged and refused, because a client that trusted its own
  capability declaration would write `println!("$1")` into somebody's file.
- **`linkSupport: true`, because it changes where the cursor lands.** It makes a
  server answer with the *name* of a function beside the whole body of it.
  Jumping to the first puts the cursor on the declaration; jumping to the second
  selects forty lines and scrolls the top of them off the screen.
- **The tooltip is built, not parsed.** The text is a doc comment out of
  somebody's dependencies, and `innerHTML` would mean a Markdown library and a
  sanitiser beside it. Every node is created and every string goes in as
  `textContent`, so there is no parser to get wrong — and `markdown-it` stays in
  the Markdown editor, which depends on this one and could not lend it back.

**`F12` used to open the developer tools**, and now it follows a name where an
editor can follow one. Those are the two things F12 means — the second in a
browser, the first in every code editor — and this is a code editor that happens
to be drawn in a browser. `Ctrl+Shift+I` is the developer tools either way, so
nothing was lost; over a PDF or a picture, where there is no name to follow, F12
does what it always did. **`Ctrl+Click` follows a name too, and multiple cursors
move to `Alt+Click`** — CodeMirror's own default puts them on the same modifier,
so one of the two had to move, and that is the same swap VS Code made for the
same reason.

## When it breaks

Two questions, and only one of them is about reporting.

**Does one broken editor take the whole window?** It used to. Measured against
the real shell, a render that throws with nothing catching it takes `#root`
from twelve thousand characters to **zero** — no tab bar, no title bar, no
menus, no status bar, and `Ctrl+Shift+P` opens nothing. A uniform grey
rectangle. Two real faults produced exactly that: a tab whose format was not in
the registry, because `TabBar` was the one of eight `FORMATS[...]` sites that
did not guard, and an editor whose `focus()` threw inside an effect. The first
is now guarded and the second is caught: a boundary wraps **the whole group** —
the tabs, the find bar and the surface — so what breaks is one document, and
the way back is closing its tab.

It wraps the group and not the surface for a reason worth stating, because it
is the kind of mistake that ships looking finished: the failure that produced
the blank page was in `TabBar`, which is the surface's *sibling*. A boundary
around the surface alone is not in its ancestry and would never have run.

**And when it does break, what is written down?** A text file, in the
application's own log folder, and **nothing else happens**. There is no
endpoint, no key, no queue and no consent dialog to get wrong, because there is
nothing to consent to. If you want somebody to see it, you send it — the way
you would send any other file. `pnpm verify:crash` reads the two crash modules
and fails the run if either grows a `fetch`, a URL or a client library, which
makes adding telemetry a deliberate act rather than a quiet one.

The reports are handed over **at the next start**, not when they are written,
and that is forced rather than chosen: a React error unmounts the root the
notifications live in, and a Rust panic ends the process outright, because this
program is built with `panic = "abort"`. A message can only be given to a
window that still exists, which means the next one. The report opens as a tab —
this is a text editor, and walking somebody out to Explorer to find a `.txt`
the program wrote would be an odd thing for it to do.

The panic hook takes **no lock**, lists no folder and asks Tauri nothing. That
is not caution, it is the difference between ending and hanging: the hook runs
on the thread that panicked, and this program has threads that panic while
holding a lock. A hook that waited for one would freeze the window instead of
closing it, which is strictly worse than the crash. It is installed before the
plugins, the context and the builder, so that "it will not start at all" — the
report every desktop program gets most — has a file behind it too.

There is no backtrace in a report, and that is deliberate: the release build is
stripped and ships no symbols, so every frame would read `<unknown>`. The file,
the line and the message are what a fix is made from.

Two crashes still write nothing at all — a stack overflow and an out-of-memory
abort never call the hook. An empty folder after a crash is therefore a real
state, not a claim that nothing went wrong.

**Telemetry is not started and stays opt-in.** There is nothing here to opt
into yet.

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
pnpm verify:clipboard # a spreadsheet range pasted into Markdown, as a table
pnpm verify:crash     # a broken editor does not take the window, and no report leaves the disk
pnpm verify:pdf       # annotations and page operations (no browser)
pnpm verify:odf       # OpenDocument dates and formulas (no browser)
pnpm verify:odt       # retyping text in an .odt: spacing, refusals, byte ranges (no browser)
pnpm verify:insert    # a new paragraph in a .docx: what it inherits, and what stays untouched
pnpm verify:delete    # a paragraph taken away: what is refused, and the exact bytes that are left
pnpm verify:split     # Enter mid-sentence: one run divided, the rest carried, every real .docx byte-exact
pnpm verify:join      # Backspace and Delete: two paragraphs joined, the first one's properties kept, byte-exact
pnpm verify:rows      # Ctrl+Enter in a cell: a row added, against the rows Word writes itself
pnpm verify:lines     # Enter, Backspace and Delete in the editor itself, every save compared with the page
pnpm verify:table     # Ctrl+Enter in a cell in the editor itself, every save compared with the page
pnpm verify:doc       # the old binary Word, read off a hand-built file (no browser)
pnpm verify:sheets    # a 100k-row .xlsx: every row read, the grid windowed, 60 fps
pnpm fidelity         # a folder of real documents, edited and checked byte for byte
pnpm readback         # …and then opened by LibreOffice, which shares no code with us
pnpm verify:word      # …and by Word itself, which is the reader that refuses (Windows)
pnpm verify:updater-key # the private update key signs what the application's public key accepts
pnpm verify:all       # all of the above

pnpm verify:search           # project search, in the REAL desktop application
pnpm verify:office-editing   # retyping a .docx, adding, removing, splitting and joining paragraphs, out to disk and back
pnpm verify:desktop-ocr      # OCR under the application's own CSP
pnpm verify:desktop-diagram  # a Markdown diagram under the same CSP
pnpm verify:desktop-image    # turning, cropping and converting a picture, out to disk and back
pnpm verify:desktop-updates  # the update check, in the program, where the plugin exists
pnpm verify:desktop-convert  # an .eps through LibreOffice and onto the screen
pnpm verify:desktop-lsp      # rust-analyzer: a mistake underlined and unmarked, then hover, completion and F12
```

**Close ulEditor before running any of those.** The application uses
`tauri-plugin-single-instance`, so a second copy hands its arguments to the first
and exits — the check then waits four minutes for a debugging port that will
never open. Each of them now says that in one line instead.

Those eight start the program itself with the WebView2 debug port open and attach
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

### The one reader that is not ours

`pnpm fidelity` proves a great deal about a save — that no other part of the
archive moved, that nothing outside the rewritten ranges changed, that the
ordinals still mean the same text. It proves all of it with **the same
namespace-blind tag scanners that wrote the file**, and a writer and a reader
that share a mistake agree with each other perfectly. The run reports `ok`.

So `pnpm readback` asks a program that shares nothing with this one. LibreOffice
is a real OOXML and ODF implementation, it is already a dependency of the
conversion feature, and it can answer the two questions no scanner of ours can:

- **does the file open at all** — which is to say, is the XML well-formed, is
  every namespace prefix declared, does the schema hold, is the ZIP container
  acceptable. Nothing here checked that before: not one harness ran an XML
  parser over a written part.
- **is the text we typed the text a reader shows** — bytes in the right place
  prove the write landed; a word in the converted output proves it landed
  *where somebody looks*.

The marker it types carries **Croatian diacritics on purpose**: `č` is two bytes
and one character, and our writer, the ZIP, LibreOffice's parser and its
exporter all have to agree about that. Nothing else here checks a round trip
through a foreign reader, and mojibake is the failure that looks like success
from the inside.

**The original is converted too**, and that control is not a formality. A real
folder holds files that were already broken before this program saw them — the
first run of this found one, and without the control it would have been reported
as damage we did. A file is held against us only when LibreOffice opened what we
read and refused what we wrote.

It **refuses to pass without LibreOffice** rather than skipping quietly, for the
same reason the live language-server test is `#[ignore]` rather than
self-skipping: a check whose only failure mode is a pass is a check that lies.

And for one question LibreOffice is the wrong instrument, because it is
**lenient**. Handed a document with a child the body may not have, it opens the
file, drops the part it did not understand, and the conversion comes back looking
like a success. Word is the reader that refuses. Adding a paragraph is the first
change this program makes that can produce that kind of mistake — everything
before it was a substitution inside an element that already existed — so
`pnpm verify:word` drives Word itself over COM and asks three things per
document: that Word opens what we wrote, that it holds **exactly one paragraph
more** than the original it also opened (a silent repair announces itself by
throwing content away), and that our text is in it. The same three are asked from
the other side of a paragraph taken away — it opens, it holds exactly one fewer,
and a line Word showed in the original is nowhere in it — and the three removals
this program refuses are cut by hand and handed to Word, so the reason for each
refusal is measured on every run rather than remembered. Windows and Word only,
and it says so and fails rather than skipping where there is neither.

The first thing it found was **our own fixture**. `makeDocx()` had no
`_rels/.rels` and no content type naming the main part, so it was not a package
Word would open at all — and every check built on it had passed, because every
check was ours. Our readers find `word/document.xml` by its path; Word finds it
by following the package relationship. The fixture is a real package now.

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
