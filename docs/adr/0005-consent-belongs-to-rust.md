# ADR 0005 — Consent to a folder or file is given in Rust, never by the page

**Status:** proposed 2026-10-06. Waits for Čovik on the three questions at the
end. Nothing here is built yet.
**Date:** 2026-10-06
**Context:** card 470. Decided by the architect on its own model. The full
reasoning is summarised here.

## The problem

`adopt_paths` and `scan_library` grant access when the page asks. Code running
in the webview could call `adopt_paths` on any folder, for example script in a
document that got through a viewer's sanitising. `grant_file` gives write
access where read access was all that was meant. A folder under a library
grant stays readable. `refreshRoot` deliberately leaves an unreadable folder
in the sandbox.

## Decision

Consent is born and recorded only in Rust. It comes from one of two places:

- **A native gesture**, which grants at once:
  - the folder and file dialogs;
  - a drop onto the window (`WindowEvent::DragDrop`);
  - argv and file associations;
  - a second instance;
  - macOS `RunEvent::Opened`.
- **A list Rust made itself**, which only *offers*:
  - the library scan;
  - a language server's answer (F12);
  - a conversion's output.

The page can only **claim** what was offered or **narrow** what was granted,
never add:

- `adopt_paths` claims an offered path, or confirms one already granted;
  anything else is `OutsideWorkspace`.
- `grant_file` is no longer a command.
- `scan_library` grants no folders. It offers the files it found, read-only on
  desktop. On Android they are read-write, because there the system's "All
  files access" is the consent.
- `forget_root(path, keep, remember)` narrows. Each kept file is resolved
  under the root before the root goes.

`Workspace` tells **read** from **read-write** on every grant:

- `write` requires read-write;
- `stat` reports `readonly` from that, so the existing "{name} is open
  read-only." message shows.

Remembered consents live in `consents.json` in the app data folder. Only Rust
writes it, and the folder is `protect`ed, so the page cannot write it even
with a parent open. The list is capped at 128 entries, newest first, and
written on every activation, not at exit.

The pure core, `consent.rs` (offer, claim, remember, load, save), has no Tauri
in it and is tested with `cargo test`.

## Rejected

| Option | Why not |
| --- | --- |
| The page sends consent IDs, not paths | No more secure than paths compared in Rust. The page speaks in paths everywhere, so an ID would be a second identity for the same thing. |
| Tauri capabilities / fs scope | `forbid_*` wins for as long as the program runs and cannot be undone, so forgetting a folder and reopening it would fail. It has no read/write distinction and matches by glob. Keeping it across restarts needs `tauri-plugin-persisted-scope`, a new dependency. It also grows by itself on every drop and from JS dialogs. |
| A native confirmation for the library or for restoring a session | A hostile script ignores the interface, as ADR 0002 step 8 found for the web. It would cost a click per folder at every start. |
| A deferred grant for a removed stick (`refreshRoot`) | Too complex for what it saves. Instead: narrow to the open tabs that still resolve; the folder stays in Recent. |
| Moving Recent and the session to Rust | No security gain. They stay in localStorage for display, and Rust's list is the authority. |

## What changes for the person

- A file dropped onto the window or picked in a dialog no longer brings its
  folder into search and Ctrl+P. A folder is still opened as a folder.
- A document opened from the **library** on desktop opens **read-only**.
  Ctrl+S then says so. To edit it, open it with "Open files" or "Open folder".
  An "Open for editing…" action is its own card. Android is unchanged.
- F12 into a definition outside the open folders, and the PDF from a
  conversion, open read-only.
- A folder "Check for new files" cannot read leaves the sandbox, as "Remove"
  does, but stays in Recent.
- Session restore and Recent work as before, but only for what Rust
  remembered: the newest 128.

## Steps (when accepted)

1. `consent.rs` in ul-core, with its tests.
2. `vfs.rs`: `Access { Read, ReadWrite }`, `resolve_for_write`,
   `grant_future_file` (for "save as"), and `forget_root(path, keep)`.
3. `library.rs`: the scan grants nothing.
4. `lib.rs`:
   - dialogs, drop, launch, second instance and `Opened` grant and remember;
   - `adopt_paths` claims;
   - `grant_file` goes away;
   - `lsp_definition` and conversion offer read-only;
   - `scan_library` offers;
   - `stays_in_app` refuses a `?query`.
5. `capabilities/default.json`: drop `dialog:default`, which no page code
   uses.
6. The shell: no `grantFile`; `forgetRoot(uri, keep, remember)`.
7. `tools/desktop-session.mjs` gains `openFromOutside`, and the 13 desktop
   checks that set up their workspace through `adopt_paths` move to it.
8. A new `tools/verify-desktop-consent.mjs` treats the harness as the XSS: it
   adopts `C:\Windows`, emits `open-paths`, and writes into `consents.json`,
   and every one must be refused. It is proved by a mutation.
9. An independent review.

## Open: Čovik's three answers

1. **Remembered consents are a lasting capability of the installation.** A
   folder opened once stays open to the program across restarts, as the web
   build already decided in ADR 0002 step 8. The alternative is a native
   dialog for each folder at every start. The architect recommends accepting.
2. **Library documents read-only on desktop**, until "Open for editing…"
   exists. Is that acceptable?
3. **A dropped or picked file no longer pulls its folder into search and
   Ctrl+P**, and F12 and converted PDFs open read-only. Is that acceptable?
