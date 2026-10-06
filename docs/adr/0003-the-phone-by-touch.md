# ADR 0003 — The next large piece: the phone, by touch, for what the desktop already edits

**Status:** proposed 2026-10-06. Waits for Čovik on the five questions at the
end. Nothing here is built yet.
**Date:** 2026-10-06
**Context:** card 444. The candidates were phase 4 (444, 466), the conversion
service (447), opt-in telemetry (446), the Office engines (104, 105, 106),
OpenDocument text to Word's level (459) and the save record by token (495).
Decided by the architect on Opus.

## Decision

The next large piece is **phase 4, narrowed: Android only, and touch only for
what the desktop already does.** No new formats, no iOS, no second way into
files.

- **Android, sideloaded.** The signed APK every tag already carries is the
  product. There is no Google Play, so `MANAGE_EXTERNAL_STORAGE` stays and no
  `content://` layer is built in this phase.
- **The device loop comes first, as a step of its own.** Nothing on the phone
  has been checked since phase 0 (card 466). Work that cannot be driven on a
  device cannot be called done here.
- **Touch is fixed where the gesture lives.** An editor's gestures are fixed in
  its own package, through `EditorHost` alone, so that ulul on a phone has them
  too. The shell fixes only its own chrome.
- **Two figures the plan owes to this phase are measured, not assumed:** pdf.js
  memory on the device, and the Android package budget.
- **ADR 0005 is not reopened.** It decides file access on Android ("All files
  access is the consent"). This phase changes nothing about consent, and no step
  that touches file access starts before ADR 0005 is accepted.

## Context

What is there:

- a signed release APK for aarch64 and armv7, built, signed and published by
  every tag ([release.yml](../../.github/workflows/release.yml)): 45.7 MB at
  v0.5.0;
- the narrow layout below 720 px, the safe-area insets and a panel that drops
  from the top ([app.css](../../packages/shell-ui/src/styles/app.css), from
  line 2335), which says of itself that it "is **not** the touch redesign from
  phase 4";
- the library over `MANAGE_EXTERNAL_STORAGE`
  ([library.rs](../../crates/ul-core/src/library.rs), ADR 0001);
- `isHandheld()` ([host/index.ts:61](../../packages/shell-ui/src/host/index.ts));
- two device checks, `verify:mobile` and `verify:library`, which drive the
  WebView's devtools socket over `adb forward`.

What is missing, read from the code. None of it has been seen on a device yet.

1. **Editing starts with a double-click only** — the document
   ([editor-office/src/index.ts:518](../../packages/editor-office/src/index.ts))
   and the grid (`:2431`). Whether an Android WebView turns a double tap into
   `dblclick` has not been measured.
2. **Enter, Backspace and Delete are read from `keydown`** (`index.ts:621–651`).
   Android's on-screen keyboards report most keys as `key: "Unidentified"`,
   `keyCode 229`, and `preventDefault()` on such an event does not hold. Split
   and join, the last month of phase 2, may not be reachable on a phone at all.
   Nothing here reads `beforeinput`.
3. **Nothing follows the keyboard.** There is no `visualViewport` and no
   `interactive-widget` in the viewport meta, so the run being typed into can
   sit under the keyboard.
4. **The PDF editor's pointer handlers have no `touch-action`**
   ([editor-pdf/src/index.ts:766, 1500](../../packages/editor-pdf/src/index.ts)).
   Dragging a note and scrolling the page compete for the same finger. Only the
   Markdown divider sets it.
5. **The structural edits are commands** (`edit.insertParagraph`,
   `edit.removeParagraph`, `edit.mergeCells`,
   [shell/commands.ts:233–265](../../packages/shell-ui/src/shell/commands.ts)),
   over methods the contract already has
   ([plugin-sdk/src/editor.ts:196–221](../../packages/plugin-sdk/src/editor.ts)).
   The palette reaches them, but reaching the palette ends the typing (`blur`
   runs `finish`), so "the paragraph the cursor is in" may no longer exist. The
   contract does not need to change. What is needed is a toolbar that does not
   take the focus.
6. **"Open files" on Android probably opens nothing, without a word.** The
   system picker hands back a `content://` URI.
   [lib.rs:141](../../apps/desktop/src-tauri/src/lib.rs) calls `into_path()`,
   which goes through `Url::to_file_path` and fails for a URL with a host, and
   the `continue` after it drops the file silently. This is inferred from the
   code and from the `url` documentation, not seen. `RunEvent::Opened` is
   handled on macOS only (`lib.rs:1454`).
7. **The device loop does not run.** Card 466: no device on `adb` on either
   machine. A debug build has the release's application ID (`org.uleditor.app`,
   [build.gradle.kts:38](../../apps/desktop/src-tauri/gen/android/app/build.gradle.kts),
   [device-session.mjs:22](../../tools/device-session.mjs)), so installing it
   means uninstalling the release and its data. Without a SIM, MIUI blocks
   `adb install` and `adb shell input` (ADR 0001). `device-session.mjs` looks
   for `adb.exe` (`:28`), and the phones are on the server.

## Why this

- **It is the only candidate about work already done.** Split, join, a new row
  and a merge took a month to get right in phase 2. On a phone they exist today
  as a layout that may not answer a finger. Phase 4 is the plan's declared
  target, ADR 0001 proved the stack for it, and CI already ships it.
- **It needs nothing new.** No dependency, no service, no account and no money.
  Playwright already drives the device.
- **It has the shape of a ulul module.** The editors are `urednik` modules
  (Kapa `standardi/ULUL-MODUL.md`), and a mobile interface is something ulul
  gives its modules for free. Touch fixed inside `editor-office` and
  `editor-pdf` through `EditorHost` alone works for ulul on a phone without a
  line of ulul's own.
- **The others measured small or wrong** (below).

## Rejected

| Option | Why not |
| --- | --- |
| **Conversion service** (447): LibreOffice in Docker on server.truss | Counted by extension and first bytes over `Documents`, `Downloads` and `Desktop` on the workstation, 2026-10-06. Of 129 `.ai`, 126 begin with `%PDF` and already open everywhere. What needs LibreOffice is 3 PostScript `.ai`, 15 `.eps` and 1 `.cdr`: 19 files, all openable on the desktop, where LibreOffice is installed. The service would serve the web instance and the phone for those 19, at the price ADR 0002 named: the largest new attack surface, untrusted files fed to an office suite on the server. When a second host needs it (ulul), it comes as a ULUL-MODUL `servis` with its own ADR and an independent review. |
| **Opt-in telemetry** (446) | There is one user, and he can say what he uses. Kapa's `SIGURNOST.md` §5 allows no analytics or telemetry in any project, and `verify:crash` already fails the build if the crash code grows a `fetch`. Closed rather than deferred, and ANALYSIS line 228 amended. |
| **Office engines** (104: DOCX through ProseMirror, 105: XLSX through Univer, 106: PPTX through Univer Slides) | Superseded by measurement (ANALYSIS, "Why neither engine was taken"). Byte-range editing gives back every byte it did not touch, which a re-serialising editor cannot, and 604 real documents hold it. Univer's XLSX and DOCX import and export are `@univerjs-pro/*` packages that need a conversion backend; unlicensed they are watermarked and limited; new Pro purchases are paused. Univer is not in Kapa's `STACK.md`. ProseMirror is (MIT), but it has no DOCX reader or writer, so the writer would stay ours and lose its promise. The corpus holds no PPTX, PPT or ODP. |
| **OpenDocument text to Word's level** (459) | One `.odt` in the corpus, against 60 `.docx` and 52 `.doc`, for some 2 000 lines in the shape of `docx-edit.ts`. It stays on the board, not next. |
| **The save record by token** (495) | Right, and independent of this, but small: a change to what `read_document` returns, with an F3 of its own and an independent review. It is not the large piece, and it can go before this one or beside it. It becomes a prerequisite only for `content://` (question 2). |
| **iOS** | 99 USD a year for the Apple Developer account, the same account card 445 defers "while only Čovik uses the installers". Nothing says there is an iPhone to test on. |
| **The touch redesign as the plan writes it** (gestures, share sheet, Files/iCloud/Drive) | Sharing and "open with" hand over `content://`, which needs a document identity that is not a path (495) and a consent source ADR 0005 does not have. Drive and iCloud are accounts and network. A signature in the PAdES sense is phase 5; a drawn one is `ink`, which exists and is covered in step 7. |
| **Hardening only** (0005, 495 and 488, then stop) | Not an alternative to this but its front. 0005 and 469 wait for Čovik and come first by the project's own order, security before function. Steps 1–7 do not touch file access and can go on meanwhile. |

## Steps

Each ends in a check in the style of `tools/verify-*.mjs` that runs on the
device. The marked ones go through an independent security review before they
are called done.

1. **The device loop.** *[F4]* One of the options in question 1. If the release
   is to stay on the phone: `applicationIdSuffix ".debug"` on the debug build
   type, `device-session.mjs` told which package it drives, and `adb` found
   under either name. Touch goes through the devtools protocol
   (`Input.dispatchTouchEvent`), not `adb shell input`, and it is shown working
   on the device before any other step. `verify:mobile` and `verify:library`
   green on the device close card 466. Reviewed: the Gradle and manifest
   change, and a debuggable build with all-files access on a phone with real
   data.
2. **The baseline, measured.** *[F2]* On the device, with the release APK:
   - cold start to the first frame;
   - the first page of the largest real PDFs, and the WebView's memory over
     them (`dumpsys meminfo`), the figure ADR 0001 left for this phase;
   - open time of the largest real `.docx` and `.xlsx`;
   - typing in Markdown through CodeMirror.

   The Android package budget is set here: **50 MB** for the release APK
   (45.7 MB at v0.5.0). The other figures become budgets only once they have
   been measured.
3. **Editing begins with a tap.** *[F2]* In `editor-office`, a touch opens a run
   or a cell for typing, without waiting for a `dblclick` that may never come.
   With a mouse, a single click still selects text. A device check taps a run
   and types.
4. **Enter, Backspace and Delete from `beforeinput`.** *[F2]* `insertParagraph`,
   `deleteContentBackward` and `deleteContentForward` decide split and join
   where `keydown` cannot. On the desktop, `verify-docx-lines` and
   `verify-office-editing` keep passing. The device check does by touch what
   they do by key, and `pnpm readback` and `pnpm verify:word` open the saved
   file with exactly the expected paragraphs. Each fix is proved by a mutation,
   on two keyboards.
5. **A toolbar that keeps the focus.** *[F3 → F2]* On a narrow screen, the
   active editor's commands that need a chord today (new paragraph, remove
   paragraph, merge, undo, redo, save) become buttons that leave the caret where
   it was. The contract does not change: the commands and the `can*` methods
   exist. A short design note comes first, because every editor's touch passes
   through this one shell piece.
6. **The keyboard does not cover the text.** *[F2]* `visualViewport`, and the
   viewport meta, measured on the device. The run being typed stays visible.
7. **PDF by touch.** *[F2]* `touch-action` on notes and pages, so a drag and a
   scroll do not fight. Pinch zoom measured. A highlight, a note and an `ink`
   stroke made by finger and saved, and the file checked in another reader, as
   on the desktop.
8. **Say what does not work.** *[F2, after ADR 0005 is accepted]* On Android,
   "Open files" opens what the library can reach or says it cannot, never
   nothing. The welcome screen does not offer "Open folder" on a phone.
   `content://` itself waits (question 2).
9. **Independent review of steps 1 and 8, and of any change to
   `AndroidManifest.xml`.** *[F4]* Then a tag.

## How we will know this was right

On the phone, by touch only, with no keyboard but the one on the screen: open a
real `.docx` from the library, retype a run, press Enter in the middle of a
sentence and Backspace at the start of a line, and save. `pnpm verify:word` and
`pnpm readback` then open the saved file with exactly one paragraph divided and
one joined, and everything else byte for byte. The same holds for a cell in a
real `.xlsx` and a highlight in a real PDF.

The phase stops if step 1 cannot make the device loop run. This ADR is then
reopened, rather than building touch nobody can check.

## Open: Čovik's five answers

1. **The device loop.**
   - (a) a SIM in the test phone, so that `adb install` works and the loop is
     automatic;
   - (b) a debug build beside the release on the phone you use (application ID
     with `.debug`), installed by hand once per build;
   - (c) an emulator for the daily loop and the real phone for the final check.
     It needs an `x86_64` Android target CI does not build, and its speed here
     is unmeasured.

   *Recommendation: (b), with (a) if a spare SIM exists; (c) only if neither.*
2. **Sideloading only, with no Play and no `content://` in this phase.** "Open
   with" from another app and the system picker both hand over `content://`.
   Reading and saving those safely needs the document token (495) and a
   fingerprint that is not an inode: an ADR and a review of its own.
   *Recommendation: yes. If `content://` is ever wanted, 495 goes first.*
3. **ADR 0005 is accepted before anything on Android touches file access.**
   *Recommendation: yes. Answer 0005's three questions first. Steps 1–7 here do
   not touch it, and step 8 waits for it.*
4. **Close 446; close 104 and 105 as superseded; retitle 106** to "PPTX: none in
   the corpus, not planned"; amend ANALYSIS (line 228, and the library table in
   section 3). *Recommendation: yes.*
5. **iOS stays out of phase 4.** It comes back with card 445 when ulEditor goes
   to other people. *Recommendation: yes.*

## Sources

- Univer README (Apache-2.0; import and export, printing and collaboration are
  in Pro): <https://github.com/dream-num/univer>
- Univer import/export (`@univerjs-pro/sheets-exchange-client`, "need a
  conversion backend"):
  <https://docs.univer.ai/guides/sheets/features/import-export>
- Paused Pro purchases: <https://pro.univer.ai/license>
- Limits without a licence (watermark, import up to 1 MB, export up to 10k
  cells): from a search summary only; the page itself answered 404.
- ProseMirror (MIT): <https://github.com/ProseMirror/prosemirror>
- Tauri, files on mobile (`androidIntentActionFilters`):
  <https://v2.tauri.app/learn/mobile-file-associations/>
- `FilePath` ("file:// URIs or Android content:// URIs"):
  <https://docs.rs/tauri-plugin-fs/latest/tauri_plugin_fs/enum.FilePath.html>
- `Url::to_file_path` (an error when the host is neither empty nor
  `localhost`): <https://docs.rs/url/latest/url/struct.Url.html#method.to_file_path>
- Android keyboards, keyCode 229 / "Unidentified":
  <https://clark.engineering/input-on-android-229-unidentified-1d92105b9a04>
