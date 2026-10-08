# ADR 0006 — A save is compared with the reading it continues, found by a token, not by a path

**Status:** proposed, and built (card 495). Čovik asked on 2026-10-08 for
all open work to go ahead without waiting, so it is built on the recommended
answer to the question at the end; his answer can still reverse it. As
built, `image_info` makes a reading only when the tab's scope asks
(`asDocument`), so a look at a picture from anywhere else holds none.
**Date:** 2026-10-08
**Context:** card 495, proposal 3 of the independent re-review of card 485
(ADR 0004). Decided by the architect on Opus. A prerequisite for `content://`
(ADR 0003, answer 2).

## The problem

`Workspace` keeps one record per path (`seen`, keyed by `record_key` — the path
as the page gave it; `vfs.rs:156, 209`). A record is what a save compares with —
which file, its time and length — and the protection the next version gets.
Every write of a path moves that path's record (`vfs.rs:947–956`), and a write
under a name nobody read finds a record by place and moves it under both names
(`vfs.rs:867–879`).

So a record cannot tell a tab's own save from another write through the
program:

1. **A write from elsewhere is taken for the tab's own.** `notes.md` is open and
   unchanged. The scratch panel saves its text over it (`scratch.ts:181, 200`),
   or a converted workbook is saved over a workbook open in another tab
   (`editor-office:2806–2809`), or extracted pages are (`editor-pdf:912–915`).
   That write moves the tab's record, and the tab's next save is not asked
   about: the record now describes what the export wrote, and the export is
   overwritten in silence. The dialog's spelling changes nothing — the same
   name hits the key, another finds the record by place (`pick_save_target`
   returns the path as the dialog spelled it, `lib.rs:279`).
2. **Spellings are a rule, not a construction.** Letters, 8.3 names and links
   are handled by a key, a lookup by place and a record written under two
   names, and a third save back under the other spelling can still ask once
   about its own change (ADR 0004, *Not changed*).
3. **`content://` has no path to key by** (ADR 0003, answer 2).

A path cannot fix 1: it names a file, not who wrote it. Updating every record of
a place after a write would end the false question in 2 and let a stale second
tab overwrite in silence.

## Decision

A record is of a **reading** — one tab's reading of one document — named by a
token Rust makes. A save names the reading it continues, and the record is found
by that token and by nothing else.

**`ul-core::vfs`:**

- `Reading` is a `u64` from a counter in `Workspace`, never reused while the
  program runs and kept below 2^53, so it crosses to the page as a number. Not
  random: readings are stored nowhere, so a counter cannot meet one from
  another run.
- `read_document(path, reading)`. Without a reading it makes a new one. With
  one, it is that reading read again: as now, the content is agreed to, and the
  remembered protection stays unless the file is provably the one it was read
  from. A reading is of the name it was made under (`normalize(path)`, kept in
  the record). Read under another name, or unknown, it is refused.
- `save(path, data, overwrite, reading, begin)`:
  - **With a reading**, the name must be the reading's, checked before anything
    else. Then today's branches unchanged: where the document was read from, the
    change check on one held look; elsewhere, asked, and a yes writes where it
    was (`where_it_was`). The reading is updated and keeps its token.
  - **Without a reading**, it is a file nobody read here — save-as, an export —
    written as `write` writes it, with that file's own security, as today.
    **No reading is looked up for the save by name or by place, and none is
    moved.** With `begin`, what was written becomes a new reading and is
    returned, so the next save of the converted `.xlsx` or of an image saved
    in another format is compared, as it is today.
  - *Amended after the independent review:* where a tab has a reading of the
    document at that very place and the file there is not provably the one it
    read — replaced, or gone — the write takes that reading's protection, not
    the file's: an export written over a document somebody swapped while it was
    open in a tab must not take the planted security (card 485's K2). The
    reading is only lent its protection; it is not found for the save, not
    asked about, and not moved.
- Gone: `record_key`, the lookup by place, the record written under two names.
- An unknown reading, or one used under another name, is `VfsError::NotRead`:
  a failed save, never `Changed`. It is a fault of the page, and the person is
  not asked to write over anything.
- `forget_readings(readings)` when a tab closes, and **every reading is
  forgotten when the page loads** (`on_page_load`, `PageLoadEvent::Started`,
  already used at `lib.rs:1809`). The page holds tokens only in memory, so they
  live exactly as long as the page.
- At most 1024 readings. A read beyond that is refused; none is ever let go to
  make room, so a save never fails for want of its reading.

**Across the boundary (`lib.rs`):** `tauri::ipc::Response` carries a body and
nothing else (`Json(String) | Raw(Vec<u8>)`, tauri 2.11.5 `ipc/mod.rs:99`), so
`read_document` puts the reading in the first 8 bytes of the body,
little-endian, and the file after them. `image_info` returns `reading` beside
the info (a wrapper; `ul-image` unchanged). `write_file` and `image_write` take
`reading` and `begin` and return the reading. New command: `forget_readings`.

**In the page:** the token never reaches an editor, and `plugin-sdk` does not
change. Each tab gets its own view of the host (`host/document-scope.ts`). It is
made where the tab's editor is made (`actions.ts:84`) and let go where the tab
closes (`actions.ts:490–493`). It reads the tab's document as a reading and
keeps the tab's readings by the exact string the tab used. It adds a reading to
a write or an image call only for a string this tab read or wrote; any other
string is written without a reading and with `begin`. A tab's reading is never
lent to another tab, to the scratch panel or to anything else.
`TauriFileSystem`'s own `DocumentHandle.bytes()` becomes a plain read: a reading
is made for a tab and nowhere else.

This holds because the page already names a document by one string from open to
save. A tab's `uri` is the path Rust resolved when it was opened (`stat_of`,
`vfs.rs:2444`; `tauri-fs.ts:132`; `actions.ts:64`), and every editor writes
`this.doc.uri` verbatim (markdown:428, code:381, office:2092/2682/2741,
pdf:2800, image:833 through `targetFor`).

**What the token is and is not.** It names a reading. It is not a consent and
grants nothing: every save still resolves its path through the sandbox
(`resolve_for_write`, `where_it_was`). A token sent with another name is
refused, and a token can only have a save compared with, and written where, its
own document was. It does not protect against the page. Every token is in the
page's memory: script there could use any of them, or none, and write a path it
was granted as a file nobody read — which it can do today. ADR 0005 rejected
IDs for consent as a second name for the same thing; a reading is a different
thing, a moment, that no path can name.

**Web and Android.** Android is the same Tauri host and gets all of this. The
web keeps no records (`BrowserFileSystem.writeBytes` ignores `WriteOptions`,
`browser-fs.ts:305`), so its scope is the host itself, unchanged. ulul, as a
third host, needs nothing.

## Rejected

| Option | Why not |
| --- | --- |
| Path keys with a canonical comparison | A path names a file, not who wrote it, and cannot tell problem 1 apart. Case folding is per folder on NTFS (`vfs.rs:2991`), and 8.3 names and links each need a rule that can change between the check and the write. Updating every record of a place ends the false question and lets a stale tab overwrite in silence. |
| The file ID as the token | Two tabs of one file share it. Every save makes a new file and a new ID. 64-bit IDs are reused (WSL's 9P, FAT; inodes on the Linux runner, `vfs.rs:359–362`). A share answers whatever it likes. `content://` has no ID. |
| A token the page makes (a UUID per tab) | An unknown token could only mean a new reading, and the save would go through as on a file nobody read: fail open. Made by Rust, an unknown one is refused. |
| The token in plugin-sdk (`DocumentHandle.reading`, `WriteOptions.reading`) | Five editors and every future one must pass it, and one that forgets saves without a check. The image editor's write is in Rust (`images.write(source, target, …)`), out of a handle's reach. The shell can do this per tab without the contract. Revisit when `content://` needs a document that is not a path. |
| One `uri → token` map for the whole page | The path key moved into the page: the scratch panel writing an open document's path would carry that tab's token — problem 1 again. |
| Holding the file open from read to close | Locks the person's document against other programs on Windows, does not survive sleep or a share, and still needs a name for the handle. |
| A second command for the token instead of a prefix | A record named and not yet read is a state every path must refuse, and one more round trip per document. The prefix is written in one place and read in one, tested with one vector on both sides. |

## What changes for the person

- A document saved over from elsewhere in the program (the scratch panel, a
  converted workbook, extracted pages) and then saved from its own tab is asked
  about, as any change made outside it. Today it is overwritten without a word.
- The false question once after a save under another spelling is gone.
- A save whose reading was lost, which only a fault can do, says "Save failed"
  and asks nothing.
- Remembered protection lasts as long as the tab. A document closed and opened
  again, or reopened after the window reloads for a change of language, is a new
  reading, as after a restart (question 1).

## Steps

1. *[F4]* `crates/ul-core/src/vfs.rs`: `Reading`, `Opened.name`, `readings`
   with the counter and the limit, `read_document` and `save` as above,
   `forget_readings`, `forget_all_readings`, `VfsError::NotRead`; `record_key`,
   the lookup by place and `moved_from` removed. The tests below. The 25
   `read_document` and 40 `save` calls in the tests take a reading, through a
   test helper.
2. *[F4]* `apps/desktop/src-tauri/src/lib.rs`: `read_document(path, reading)`
   with the prefix (one `framed` function); `write_file` and `image_write` with
   `reading` and `begin`, returning the reading; `image_info` returning
   `reading`; the `forget_readings` command; `forget_all_readings` in
   `on_page_load` on `Started`.
3. *[F2]* `packages/shell-ui/src/host/tauri-fs.ts`: the handle's `bytes()` reads
   plainly; `readDocument(uri, reading?)` strips the prefix;
   `writeDocument(uri, data, options, reading?, begin?)`;
   `forgetReadings(readings)`. `host/tauri-images.ts`: `infoDocument`,
   `writeDocument`. `host/index.ts`: the three, optional, on `ShellFileSystem`.
4. *[F4]* `packages/shell-ui/src/host/document-scope.ts` (new): a tab's view of
   the host as above; where the file system has no `readDocument`, the host
   itself.
5. *[F2]* `shell/actions.ts`: `openDocument` makes the scope and hands its host
   and document to `createInstance`; `closeTab` lets it go.
   `state/workspace.ts`: `tabScopes` beside `tabInstances`.
6. *[F2]* `tools/verify-readings.mjs` (new, no window) and
   `tools/verify-desktop-save.mjs` (new, the built program); `verify:readings`
   and `verify:desktop-save` in `package.json`.
7. *[F1]* ADR 0004, under *Not changed*: the spelling question is settled by
   this ADR.
8. *[F4]* The independent review below.

## Tests that prove it

Each is shown to fail under its mutation before it is trusted.

`cargo test -p ul-core`:

| Test | Mutation it must catch |
| --- | --- |
| `a_save_is_compared_with_its_own_reading` — two readings of one file; the first saves; the second is `Changed` | records kept by name or by place |
| `a_write_nobody_read_moves_no_reading` — a reading; the same path written without one; the reading's save is `Changed` | a write without a reading moves its path's record (today) |
| `a_save_under_another_name_than_its_reading_is_refused` — read as `notes.md`, saved as `NOTES.md` with that reading and `overwrite`: `NotRead`, bytes untouched | the name check dropped |
| `an_unknown_reading_is_refused_and_nothing_is_written` — save and read | unknown taken for none |
| `a_write_that_begins_a_reading_is_compared_on_the_next_save` | `begin` ignored |
| `a_forgotten_reading_is_unknown` — one, and all | forgetting does nothing |
| `readings_past_the_most_are_refused_and_none_is_let_go` — the limit small for the test | the oldest let go |
| The K2 tests, with readings: other letters, folder swapped for a link, read again, the junction half of the swap test | a reading read again taken as new |

`lib.rs`: `a_reading_crosses_in_front_of_its_bytes`, one vector shared with
`verify-readings.mjs` (mutation: width or byte order); and
`a_document_not_read_here_is_a_failure_not_a_question` beside
`a_changed_file_reaches_the_page_as_a_code` (mutation: `NotRead` serialized with
`CHANGED_OUTSIDE`, which would offer Overwrite).

`tools/verify-readings.mjs`, with a fake inner host:

- the tab's document is read once, and its save carries that reading;
- a new target is written with `begin`, and its next write carries the reading
  it got;
- a second scope writing the first tab's path sends none;
- a path differing only in letter case gets none;
- `info` after a save carries the reading;
- closing forgets exactly the tab's readings;
- on the web the host is unchanged.

Mutations: the scope sends nothing, shares one map, folds case, forgets nothing.

`tools/verify-desktop-save.mjs`, through the built program:

1. One fixture per editing editor (`.md`, `.ts`, `.docx`, `.xlsx`, `.ods`,
   `.pdf`, `.png`): opened, replaced on disk by a file renamed over it, Ctrl+S.
   The Overwrite question appears; Cancel leaves the replacement untouched.
   *Mutation: the scope adds no reading.*
2. `notes.md` open and unchanged; its path written without a reading, as the
   scratch panel writes; the tab edited and saved — asked. *Mutation: a write
   without a reading moves the record.*
3. `write_file` with a reading nobody made: refused, not the changed code, file
   untouched. *Mutation: unknown taken for none.*
4. A reading taken, the page reloaded, `write_file` with it: refused.
   *Mutation: nothing forgotten on page load.*

## Independent review (F4)

Before "done":

- a reading is looked up only by itself;
- a write without one neither finds nor moves a reading;
- `NotRead` can never reach `saveTab` as `ChangedOutsideError`;
- the scope never lends a reading across tabs or to the shell;
- `Workspace::write` and the no-reading branch did not widen;
- the prefix is stripped before any editor sees the bytes;
- removing `record_key` lost none of the K2 cases;
- the narrowing in question 1 is acceptable.

## Question for Čovik

1. **Remembered protection lasts as long as the tab.** Today it lasts the run,
   per path: a document closed and opened again, or reopened after the window
   reloads for a change of language, keeps the protection it first had if the
   file was replaced in between. With readings that is a new reading, which
   takes the security of the file that is there — as after any restart. Keeping
   today's behaviour needs a rule by place on every new reading, the kind this
   ADR removes. *Recommendation: as long as the tab.*

## How we will know it was right

- The four desktop checks pass, and each fails under its mutation.
- The change touches nothing in `packages/plugin-sdk` or `packages/editor-*`.
- `vfs.rs` finds a record for a save only by its reading: `record_key` is
  gone, and `at == resolved` is left only where a write with no reading
  borrows a protection (amended after the review).
- A unit test opens and forgets readings, and none is left.
