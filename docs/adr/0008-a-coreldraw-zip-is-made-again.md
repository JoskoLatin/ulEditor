# ADR 0008 — A CorelDRAW ZIP is made again of the parts libcdr reads before LibreOffice sees it

**Status:** accepted and built (card 510, point 2).
**Date:** 2026-10-13
**Context:** card 510. Designed by the architect on Opus on 2026-10-12, with
measurements on this workstation's LibreOffice; Čovik accepted the
recommendation on 2026-10-13 ("po preporuci može"), with the new direct
dependency `zip`.

## The problem

CorelDRAW X6 and later save a drawing as a ZIP. The one `.cdr` among Čovik's
files is one: 115 890 bytes, 13 members — `content/root.dat` (a RIFF `CDRG`,
version X6), `content/dataFileList.dat` (three names, one a line),
`content/data/*.dat`, thumbnails, colour and style XML, metadata. No
`mimetype`, no `[Content_Types].xml`, no `META-INF`.

`ul-convert`'s gate (`admit`) let LibreOffice see only a RIFF CorelDRAW or
PostScript, and refused every ZIP, because LibreOffice decides what a file is
by its content: a ZIP named `.cdr` holding OpenDocument members was imported
as a Writer document (measured 2026-10-12), and a document LibreOffice opens
as something else can reach the network as it loads (card 505). So the one
real drawing could not be shown, and the detectors called it an archive.

Measured on the way: the gate also let through a bare RIFF whose form type
was `CDT` (a template) or whose version byte libcdr does not know (`0x05`) —
libcdr turns those away, and LibreOffice then tried its other imports; one
took such a file for Writer text.

## Decision

1. **The ZIP is made again (`rebuild_coreldraw`).** `ul-convert` reads the
   page's ZIP with the `zip` crate and writes a new one, stored, holding only
   what libcdr asks for by name (`CDRDocument.cpp`, `parse`):
   `content/root.dat`, `content/dataFileList.dat`, and
   `content/data/<name>` for each name in the list. LibreOffice is given that
   file, named `<stem>.cdr`, and never the page's ZIP, which is removed from
   the staging folder first. There is then one reading of the archive — this
   one — and nothing in it but the parts of a drawing.
2. **Every part is checked and bounded.** `content/root.dat` must itself be a
   CorelDRAW RIFF libcdr takes. The list is split as libcdr splits it (at
   every `\n`, a last name with none after it); every name must be a plain
   file name (letters, digits, `.`, `_`, `-`, not starting with a dot, at
   most 128 bytes), at most 1024 of them, the list at most 64 KiB. A part
   the list names must be there. Each part is read to its end, so its
   checksum is checked, and all of them together are held to `MOST_BYTES`
   (512 MiB), as the copy of any source is. Anything else is refused with
   `ConvertError::CorelLayout`, saying why.
3. **The RIFF gate is narrowed to libcdr's own predicate (`getCDRVersion`):**
   `RIFF`, then `CDR` in either case, then a version byte of `0x20`, `1`–`9`,
   or `A` and above. A template (`CDT`) and an unknown version are refused.
4. **Detection routes the ZIP to the drawing viewer.** In `ul-formats` and in
   `detect.ts`, a ZIP that is none of the known formats (OpenDocument, OOXML,
   EPUB) and is named `.cdr` is `vector`; a known document wearing the name is
   still that document. The viewer offers the conversion; the gate decides.
5. **Dependencies.** `zip = { version = "4.6", default-features = false,
   features = ["deflate-flate2"] }`, and `flate2 = { version = "1.1",
   default-features = false, features = ["rust_backend"] }` — named only to
   pick the pure-Rust backend, without which `ul-convert` does not build on
   its own (the desktop build already picks it through other crates). Both,
   and `miniz_oxide` and `crc32fast` under them, were already in
   `Cargo.lock`: no package was added (540 before and after), only three
   edges.

6. **Bounded in time and size before LibreOffice is (the review of
   d561273).** The ZIP is read as one that starts at the file's first byte
   (`ArchiveOffset::Known(0)`, which a CorelDRAW ZIP is): asked to find where
   an archive starts, `zip` tried every end-of-directory record against the
   whole file, and 2 MB of them took 64 s, four times as long for twice the
   size — now 0.24 s. A ZIP is taken only under a `.cdr` name and only up to
   64 MiB (`MOST_ZIP_BYTES`; the real one is 113 KiB), its parts made again
   up to 256 MiB, and the conversion's one time limit (120 s) covers the copy,
   the rebuild and LibreOffice together, the rebuild checking it as it reads.
   The desktop runs the whole conversion off the threads its commands run on
   (`spawn_blocking`).

## Rejected

| Alternative | Why not |
|---|---|
| (a) A better message only | The drawing still cannot be shown, and it is the only `.cdr` there is. |
| (b) Let the original ZIP through after checking for the CorelDRAW members | It depends on the order in which LibreOffice's detection tries its filters, and on two ZIP readers (ours and LibreOffice's) agreeing about what one holds — duplicate names, a central directory that disagrees with the local headers. |
| (c) Extract only the RIFF from `content/root.dat` | Does not draw: measured, a ZIP of `root.dat` alone, or the bare RIFF from it, is "could not be loaded" — the drawing is in the data parts. |
| (d) A thumbnail instead of the drawing | Kept for the web and the phone, later; on the desktop the drawing itself can be had. |
| (e) A ZIP reader of our own, about 200 lines over `flate2` | The reserve if `zip` ever has to go; more code of our own over untrusted input than a crate already in the tree. |

## What was measured

- 2026-10-12 (the architect): the original through LibreOffice draws the
  whole vector drawing, not its thumbnail; a ZIP made again of root, list
  and data draws a byte-identical PNG; a ZIP of `root.dat` alone, or its bare
  RIFF, does not load; a ZIP named `.cdr` holding OpenDocument members opens
  as a Writer document.
- 2026-10-13 (this build): `a_real_coreldraw_zip_made_again_draws_what_the_original_draws`
  (ignored, needs LibreOffice and `UL_CDR_SAMPLE`) — the PNG LibreOffice draws
  from the ZIP made again is byte for byte the one it draws from the original;
  with the data parts left out the test fails. `verify-desktop-convert` with
  `UL_CDR_SAMPLE`: the drawing opens in the vector viewer, converts, and its
  page is drawn, with nothing written beside it (15/15).
  `verify-formats-parity` over the 70 605 files in Documents: the two
  detectors disagree on none.

## Not done here

- `content/riffData.cdr`, the other layout libcdr reads, is refused: there is
  no sample to measure it on.
- libcdr also opens `color/profiles/*`; they are left out, and the measured
  drawing does not need them.
- The conversion service of ADR 0007 is still not built (its dated note).

## How we will know this was right

- The real drawing draws on the desktop, and the live test stays green.
- A ZIP built to make the reader search for its start is turned away at
  once: `a_zip_full_of_directory_ends_is_turned_away_at_once` takes 0.24 s,
  and 354 s with the archive's start left to be found.
- No ZIP that is not this layout reaches LibreOffice: the unit tests refuse
  an OpenDocument, a template, an unknown version, a climbing name, a CRLF
  list, a gap in the list, a missing part, and a file that is not a ZIP.
