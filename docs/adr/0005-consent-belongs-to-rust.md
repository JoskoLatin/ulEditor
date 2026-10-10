# ADR 0005 — Consent to a folder or file is given in Rust, never by the page

**Status:** accepted 2026-10-06 — Čovik answered yes to all three questions at
the end, as recommended. Being built (card 470).
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

## Čovik's three answers (2026-10-06: yes to each)

1. **Remembered consents are a lasting capability of the installation.** A
   folder opened once stays open to the program across restarts, as the web
   build already decided in ADR 0002 step 8. The alternative is a native
   dialog for each folder at every start. The architect recommends accepting.
2. **Library documents read-only on desktop**, until "Open for editing…"
   exists. Is that acceptable?
3. **A dropped or picked file no longer pulls its folder into search and
   Ctrl+P**, and F12 and converted PDFs open read-only. Is that acceptable?

## Amended after the independent review (2026-10-06)

Built in 9b24a10, c62491b, 6f989cd and 39e0855; the F4 review and the
re-checks after it changed it in 63f3655 … 7de2922. What differs from the
decision above:

- **The library asks once on desktop.** The table above rejected a native
  confirmation for the library, reasoning that a hostile script ignores the
  interface. That holds for the page's own interface, not for a dialog the
  system draws, which the script cannot answer — and without one, script in
  the page could start a scan, claim every document it offered and read them
  all. So the first scan asks, in the three buttons of the trust question,
  and a yes is remembered as *the library may look*, not as the folders: the
  page may still claim only the documents a scan offers. A no lasts the
  session. The page's `limit` is capped by the core.
- **F12 offers a library's own sources only.** The page writes the documents
  a language server reads, so a document can make it name any file. A
  definition is offered only if, resolved, it is a source of that language
  where its libraries are kept (`.rustup`/`.cargo`, a `node_modules`,
  `site-packages`); one inside the open folders needs no offer.
- **A protected folder is absolute.** Nothing granted, offered or claimed
  opens one; the crash reports, which the program writes there and shows in
  a tab, go through a list of its own files only Rust fills.
- **Claimed offers are kept apart** from what gestures gave (64 against 128),
  so a page that claims everything pushes out none of the person's consents.
  A claim takes the widest, then the nearest, consent that covers a path.
- **Forgetting is what the person means.** "Forget recently opened files"
  forgets every consent and the library's yes; a folder taken out of Recent
  takes what is under it with it, and is found by its shown name when its
  drive is gone.

Two ways out of the program the review named, decided afterwards by Čovik on
the recommendation:

- **A link asks before it opens.** `open_external` opened any `https` address
  the page named, and an address is a message to the site it names: script in
  the page could write into one whatever it had read, and the browser would
  carry it out with no gesture at all. Now the core asks first, in the same
  three buttons, naming the site — in the title too — as the browser will
  look it up, and then the address, decoded only as far as printable ASCII.
  Only the program's own links open without asking — the repository, its
  issues, the LibreOffice download page — compared whole, and at most one a
  second. An address with a name before its host
  (`https://example.com@elsewhere.net/`) or longer than 2048 characters is
  refused outright. After a no the page may not ask for half a minute, and
  after three not again this session.
- **One question at a time.** The language server's, the library's and a
  link's questions share one lock, so two are never on the screen together;
  a link asked for while any is open is not opened.
- **Google Fonts stays in the CSP.** What the page can send there reaches
  Google and nobody else: a redirect to any other host is held by the same
  `connect-src` as the first request. The button ADR 0002 gates the fetch on
  is in the page, so script there could fetch without it — to Google, with
  the person's address, and to nobody else.

The review of that change found a third way out of the same kind: the
updater plugin's `check` took a proxy from the page, and Rust would send its
request through it — the proxy's name and password carrying whatever the page
had read, past the CSP. The page now has no updater permission at all; it
asks through two commands of the core, `check_update` and `install_update`,
which take nothing from it but the channel progress is reported on.

## Measured after (2026-10-08, card 505)

Left open above: whether the page reaches the network past the CSP, and
whether LibreOffice fetches while converting a document the page wrote. Both
did.

- **WebView2, past the CSP.** In the program as it ships (under `tauri dev`
  no CSP is sent at all), script in the page could make the resolver look up
  any name — `dns-prefetch`, `preconnect`, both in a `srcdoc` frame too, an
  iframe or a form the CSP refuses (Chromium connects before it checks), a
  STUN or TURN server's name — open TCP to any address the same ways, and
  hold a WebRTC connection to any address in both directions, writing the
  other side's description itself. WebView2 154 does not know
  `webrtc 'block'`. Two switches in `additionalBrowserArgs` close all of it:
  `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE
  fonts.googleapis.com, EXCLUDE fonts.gstatic.com"` and
  `--webrtc-ip-handling-policy=disable_non_proxied_udp`; each was shown
  necessary by taking it away. `tools/verify-desktop-egress.mjs` builds the
  program and checks every way above, IPv4, IPv6 and by name, with a
  positive control for names and one for addresses. **Windows only**: the
  switches are WebView2's. WKWebView (macOS), WebKitGTK (Linux) and Android's
  WebView were not measured.
- **LibreOffice.** It fetched a linked image from HTML wearing a drawing's
  name: 0d32887 hands it only the four formats' first bytes, of a private
  copy (33cbdc1). And its EPS import runs whichever of `pstoedit.exe`,
  ImageMagick's `convert.exe` and Ghostscript's `gswin64c.exe` or
  `gswin32c.exe` is on the PATH, handing each the file — only Ghostscript
  with `-dPARANOIDSAFER`. On Windows it is now given the system's folders
  only, and runs none of those three — System32's own `convert.exe`, the
  FAT-to-NTFS converter, is still found, and fails on arguments that name no
  volume. On Unix no PATH keeps them out — see the next point. Linked bitmaps
  in a real `.cdr` were not measured: there is no such file to measure with.
- **PostScript outside Windows (card 512, 2026-10-10).** The independent
  review of 505 found Linux and macOS still open: LibreOffice runs
  `pstoedit`, then `gs`, then `convert` over any PostScript with no preview of
  its own (`vcl/source/filter/ieps/ieps.cxx`, read 2026-10-10), which is what a
  page writes, and `convert_to_pdf` asks for no gesture. No PATH closes it
  there: Ghostscript is in `/usr/bin` beside what LibreOffice's start script
  needs, `convert` and `pstoedit` reach it by paths of their own, and a snap's
  or flatpak's LibreOffice looks inside its sandbox. So outside Windows
  `ul_convert::to_pdf` refuses PostScript — plain or DOS EPS, by content,
  whatever the name — before LibreOffice is started, and the page says why in
  place of the button. `.cdr` still converts there. Rejected: refusing only
  when a helper is on the PATH (blind to a snap or flatpak, and to Ghostscript
  reached through the other two), and a question the system draws before
  converting (a yes does not make Ghostscript safe from a crafted file, and
  nobody can judge a program by looking at it). What it costs, by ADR 0007's
  count: on a Linux machine with Ghostscript, the 5 preview-less PostScript
  files would have been drawn and are not; the 13 DOS EPS show the preview
  they carry, as before. **Not measured:** a LibreOffice on Linux or macOS at
  all — the refusal is before it starts, so nothing about it is relied on.
## Questions paced (2026-10-08, cards 501 and 488)

Script in the page can bring up any of the core's questions as often as it
likes, and a question asked again the moment it is answered "no" ends with
the yes pressed to make it stop. So each is paced, by what a refusal costs:

- **A link** (since ff65cb4): nothing for half a minute after a no, nothing
  after three this session.
- **"Open for editing…"** (41c6413): the same. Nothing is chosen in its
  dialog beforehand — with the name filled in, Enter alone was Open, and the
  page sees every key.
- **"Run this project's code?"** (46418d0): the same, whatever the project
  — a page that can write a `Cargo.toml` into every folder it holds would
  otherwise make each one a new question. The person is told when the
  question was held back, and that a restart asks again. "Forget trusted
  projects" forgets the yeses only; a "Not now" lasts the session.
- **"Save as" and "Open folder"** (46418d0): half a minute after a Cancel,
  with no limit per session — people cancel those and try again all day.
  "Save as" is offered the page's suggestion as a plain name only, never a
  path or a character that does not read as what it is.

Every file dialog shares the one-question lock with the core's other
questions. A gesture in one of the program's own folders — now including
the folder it runs from on Windows, where a DLL written would load next
start — grants and remembers nothing.

- **The independent review (PROLAZI)** added what is left: a proxy the
  system names would get the names the rules hold back (closed with
  `--no-proxy-server`), a crash of the renderer can send a dump to Microsoft
  through Windows' own reporting, and `localhost` stays reachable on an
  installed copy — a connection to a local port, which leaves no machine.
