# ADR 0009 — The phone gets a shell of its own, with three faces

**Status:** accepted 2026-11-07 — Čovik chose to have all three interfaces in
the application, selectable in the settings, and answered the eleven
questions at the end: Arak first, then Palac, then Četiri boje, and the rest
as recommended.
**Date:** 2026-11-07
**Context:** card 585. Decided by the architect on Opus. Amends ADR 0003
(steps 2–9, below). Step K5 needs an amendment to ADR 0005 of its own, with
an independent review, before it is built.

## Decision

On Android the program starts **a mobile shell of its own**, in
`packages/shell-ui/src/mobile/`. The desktop shell stays as it is, narrow
windows on a computer included.

The three interfaces Čovik chose — **Palac**, **Arak** and **Četiri boje** —
are **thin presentation layers** over two shared things:

- **one shared mobile layer**: a pure core, `packages/mobile-core` (a ulul
  module of the `biblioteka` kind, with a `MODUL.md`), and shared React parts
  in `packages/shell-ui/src/mobile/common/`;
- **one new, optional editor contract for touch**,
  `packages/plugin-sdk/src/touch.ts`.

The interface is changed the way the language is: the session is written
down and the window reloads. A change is allowed only while nothing is
unsaved, so only one interface is ever loaded on the phone.

**The shared layer and Arak are built first, to the end; then Palac; then
Četiri boje.** Before any of it, the keyboard and the Back gesture are
measured on the device (K2).

## Context

On 2026-11-07 Čovik opened ulEditor on a real phone and rejected it: the
desktop squeezed onto a narrow screen. He asked for a mobile design from
nothing, layout and look. Three independent designers, each forbidden to read
the code or the others' work, drew three concepts as clickable prototypes
from one brief. The brief, the concepts, the prototypes and their screenshots
are in `tools/screenshots/mobile-od-nule/`, which `.gitignore` keeps out of
the repository; what this ADR needs of them is summarised here.

The brief's four uses, in Čovik's words:

1. **Read** PDFs and documents: find one, open it, turn pages, find a word.
2. **Fix** a Word or Excel file quickly: one word, one number, one cell, save.
3. **Write notes**: a lot of typing, with the phone's keyboard up.
4. **Photograph paper, then OCR**: a picture of a document into text that can
   be searched, copied and saved.

The phone: a Pixel 8 Pro, GrapheneOS, Android 17, a viewport 448 CSS px wide
(safe areas 51 px at the top and 24 px at the bottom, measured in the
Vanadium browser, not in the app). The second test phone, a Redmi Note 11, is
narrower, so the design has to work from 360 to 450 px. Touch targets are
44 px at least.

The three concepts:

- **Palac** (*thumb*). Everything that is pressed lives in *dlan* (*palm*), a
  violet area across the lower half whose upper edge follows the reach of the
  thumb; the upper half, *vitrina*, is only looked at. *Jagodica*, a yellow
  oval key on the thumb's side, always carries the next step (Traži, Ispravi,
  Upiši, Spremi, Snimi, Otvori). Menus and confirmations come out as
  *lepeza*, a fan from the thumb's edge. The library grows from the bottom,
  cells get the program's own number pad, and a left-hand setting mirrors what
  the hand touches.
- **Arak** (*a sheet of paper*). The document is the whole screen, with no
  bar at all. *Zid* (*wall*) is the library, every document a small page. The
  only fixed element is *ugao*, a folded corner: a tap lifts the sheet and
  shows *stol* (*desk*) under it, with the tools for this document and *hrpa*,
  the pile of the other open ones. Every input — a search, a word, a cell —
  goes into *crta*, a paper strip above the keyboard. First-time hints are
  *ceduljice* (sticky notes).
- **Četiri boje** (*four colours*, after the four-colour ballpoint). The start
  asks „Što ćeš sad?" and offers four intents — *čitati*, *ispraviti*,
  *pisati*, *slikati* — each with its own colour, tools and list of documents.
  Reading and correcting share the document (the same document, the same
  page); writing and photographing are desks of their own. The four intents
  are tabs along the bottom.

## Why

- **The three concepts share one pattern under three skins.** A tap on a word
  or a cell opens a field outside the document with the target's text, a
  label („D4 Plin, studeni") and what will follow („Ukupno 263,24 →
  259,99"), then a commit. They differ in where the field stands and what it
  looks like. So that logic is built once, and the interfaces draw it.
- **What is shared exists already and is not touched.** Opening, saving with
  ADR 0004's questions and closing are in `shell/actions.ts` (`openDocument`,
  `saveTab`, and `closeTab` with `confirmDiscard`); the commands are in
  `shell/commands.ts`, the state in `state/workspace.ts`, the library in
  `shell/library.ts` (`useLibrary`, `blocked`), and the session in
  `shell/session.ts`, which on a handheld already comes back on its own. The
  mobile shell calls them and copies none of them.
- **A reload is the pattern already.** `chooseLocale` in `shell/lifecycle.ts`
  writes the session down and reloads, because the editors build their own DOM
  and cannot be moved, and `EditorSurface.tsx` mounts an editor "exactly
  once". Switching live would mean moving editors' DOM and holding three
  interfaces in a phone's memory.
- **Nothing new is brought in.** React, zustand, Tauri 2 and tesseract.js
  7.0.0 are here already. Kapa's Android standard (Kotlin and Compose) does
  not apply: ulEditor is a Tauri application by ADR 0001. The only new
  third-party files would be typefaces, and each is asked about (O6).

## The boundary

### The layers

| Layer | Where | What |
| --- | --- | --- |
| **The shell's working core** (unchanged) | `shell-ui/src/shell/actions.ts`, `commands.ts`, `library.ts`, `session.ts`, `reading.ts`, `scratch.ts`, `state/workspace.ts`, `host/*` | opening, saving (ADR 0004), closing, commands, the library and its no-permission state, the session; consent stays in Rust (ADR 0005) |
| **`packages/mobile-core`** (new) | pure TypeScript: no React, no DOM, no Tauri; a `MODUL.md` | the rules listed below, tested in Node |
| **`packages/ocr`** (moved) | `editor-image/src/ocr.ts` and `preprocess.ts`, taken out; a `MODUL.md` | a picture to text, and words with their confidence; `editor-image` imports it |
| **`shell-ui/src/mobile/common`** (new) | React, shared | the stage the editors live on, the adapters to the DOM, the hooks listed below |
| **One folder per interface** | `shell-ui/src/mobile/ui/arak/`, `palac/`, `boje/` | layout, navigation, the interface's own controls, `tokens.json`, its CSS, its first-time hints |

The interfaces are not workspace packages of their own. They need
`actions.ts` and the store, and `shell-ui` has to import them to mount them,
which would close a circle. Nor can they be used outside ulEditor, so they
are not modules.

### `packages/mobile-core`

- `layers.ts`: the stack of layers, and what Back does — it closes the top
  one. On a question, Back is the action marked as the cancel, never
  "Discard".
- `keyboard.ts`: the keyboard's inset, from the layout height, the visual
  viewport and — if K2 shows it is needed — the inset the activity reports.
- `documents.ts`: the open documents in the order they were last used, the
  neighbour a swipe goes to, each document's mode (reading or correcting), and
  when each was last saved.
- `memory.ts`: per document, its last position, last intent and last
  opening; capped, newest first, kept through `SettingsService`.
- `prefs.ts`: `mobile.ui`, `mobile.hand`, the first-start flag, the
  first-time hints already seen, and `canSwitch`.
- `edit-session.ts`: one state machine for correcting a target — idle,
  editing, previewing, committing, then done or the next target.
- `scan.ts`: one state machine for paper to text — the picture, the corners,
  recognising, the result, saving — and the corners' limits.
- `notes.ts`: a new note held in memory until its first save, and the name
  proposed from its first line; Rust decides the file's name (K5).
- `fold.ts`: Croatian letters folded for a search — č and ć to c, đ to d, š
  to s, ž to z, in both cases.

Its `MODUL.md`: kind `biblioteka`; data class `privatno` (the names of
documents and positions in them); network: none; licence Apache-2.0; check
`node tools/verify-mobile-core.mjs`; hosts: ulEditor, with ulul a candidate.

`packages/ocr` is `privatno` too, though a photographed paper can hold other
people's data. So no input goes into a log or a crash report, and a picture
is not kept past its processing unless the person saves it.

### `shell-ui/src/mobile/common`

- `MobileApp.tsx` mounts the chosen interface, lazily.
- `DocumentStage.tsx` mounts each editor once, as `EditorSurface.tsx` does.
  `Pane` moves out of `EditorSurface.tsx` into a file of its own: a pure move,
  proved by the existing `verify:all`.
- Adapters to the DOM: `history` for Back; `visualViewport` for
  `--kb-inset`; and `--ul-obscured-top` and `--ul-obscured-bottom` for the
  part of the screen an interface covers, which the editors honour through
  `scroll-padding`, so a revealed hit or cell lands where it can be seen.
- Hooks: `useEditSession` (the edit field, without a look), `useFind`
  (`instance.find`), `useQuestions` (the sticky records of `shell.notify`
  with their actions), and `useLibraryView` (filters over `useLibrary`).
- A tool row that never takes the focus (`pointerdown` with
  `preventDefault`): ADR 0003 step 5.
- A swipe helper that leaves a zone at the screen's edges to Android's own
  Back gesture.
- The OCR result view, which speaks the same edit session as an editor does:
  the result is not a file yet.

One small change to an existing type: `NotificationAction` gets
`cancel?: true`, so that Back is tied to the action that means Cancel and not
to its place in the list. Today Cancel is merely first in `confirmDiscard`,
`askOverwrite` and `fidelityWarning`.

### What an interface holds

- **Palac:** *dlan*, *jagodica*, *lepeza*, *vitrina*, the library growing
  upward, its own number pad (a second source of text for the same edit
  session), the pad that moves a crop corner, and the mirroring by hand.
- **Arak:** *zid*, the sheet, *stol*, *hrpa*, *ugao*, *crta* and
  *ceduljice*.
- **Četiri boje:** the start with the four intents and their memory lines,
  the four tabs, the library's filters per intent, and the colour and mode of
  each intent.

An interface calls `shell.commands.execute(id)` or `actions.ts`, reads the
existing stores and `mobile-core`, and places editors with
`<DocumentStage/>`. It does not call Tauri, does not call an editor directly,
and decides nothing about a save.

## The editors: `touch.ts`

All three interfaces correct through a field outside the document, so the
editors get one optional contract for it. Every member is optional, which
makes it a minor version of `@uleditor/plugin-sdk`. This is a sketch; its
exact shape is the design note of step K0, which is written before K4 starts.

```ts
/** What a tap named: a word in a run, or a cell. */
export interface EditTarget {
  /** The editor's own handle; opaque to the host. */
  id: string;
  kind: 'text' | 'cell';
  /** Only the scopes this editor writes back faithfully, narrowest first. */
  scopes: Array<{ scope: EditScope; text: string }>;
  /** "D4 Plin, studeni": plain text, capped by the host. */
  label?: string;
  inputMode: 'text' | 'decimal';
  hasPrevious: boolean;
  hasNext: boolean;
}

export type EditScope = 'word' | 'sentence' | 'paragraph' | 'cell';

/** What else a commit would change: a total, an average. */
export interface EditPreview {
  changes: Array<{ label: string; before: string; after: string }>;
}

/** A pen is a mode; "bold" is an action. */
export interface EditorTool {
  id: string;
  /** Translated. */
  title: string;
  kind: 'mode' | 'action';
  active?: boolean;
  enabled?: boolean;
}

/* New optional members of EditorInstance: */
setTouchEditing?(on: boolean): void;
readonly onEditTarget?: Event<EditTarget | null>;
previewTarget?(id: string, scope: EditScope, text: string): EditPreview;
applyTarget?(id: string, scope: EditScope, text: string): Promise<boolean>;
stepTarget?(id: string, to: 'previous' | 'next' | 'up' | 'down'): EditTarget | null;
tools?(): EditorTool[];
runTool?(id: string): void;
readonly onToolsChange?: Event<void>;
pages?(): { count: number; current: number } | null;
showPage?(index: number): void;
drawPage?(index: number, canvas: HTMLCanvasElement): Promise<void>;
position?(): string | null;
restorePosition?(token: string): void;
```

Beside them, `FindQuery` gains `foldDiacritics?: boolean`, and `ImageOps`
gains `perspective?` (four corners; a homography in `crates/ul-image`, with a
bounded output size).

- **`setTouchEditing(true)`** makes a tap name a target instead of opening
  text in place. The desktop never calls it, so the double-click and typing
  in place stay as they are. In Četiri boje, *čitati* turns it off.
- **`applyTarget`** goes through the same path the double-click's typing
  ends in (`#record`, `#recordCell` in `editor-office/src/index.ts`), as one
  step of undo.
- **Scopes are the editor's answer.** `docx-edit` rewrites a run, never a
  paragraph of several runs, because a paragraph would make it guess which
  formatting a new letter takes. So a sentence or a paragraph is offered only
  where it lies inside one run; how often that is on real documents is
  measured in K4.
- **`previewTarget`** uses the recalculation the editor already has
  (`#recalc`, `formula.ts`, with its budgets) and writes nothing.
- **`tools`** carries what an editor offers beyond the shell's commands:
  the PDF editor's pen, marker and note (today its own toolbar and
  `setTool`), and the Markdown editor's heading, bold, list and task. No
  editor registers commands with the host today, so this is new.
- **`pages`** serves Palac's and Četiri boje's page strip, drawn by the
  thumbnail code `editor-pdf` already has.
- **`position`** brings a document back where it was: Android ends an app in
  the background whenever it likes.
- **The text is untrusted.** Words, labels and OCR text come from the
  document. The host shows them as text only, caps their length, and shows
  control and bidirectional characters visibly. This is reviewed
  independently (K4).

Which taps, swipes and fields belong to which side, step by step, is the
matrix below.

## Entering the mobile shell

One function in `packages/shell-ui/src/main.tsx` decides:

- `isTauri() && isHandheld()` — Android, a tablet included — starts the
  mobile shell, as a lazy `import('./mobile/MobileApp.js')`;
- everything else starts the existing `App`, imported as it is today.

A narrow window on a computer, a computer with a touch screen and the web
build on a phone all stay on the desktop shell and its narrow CSS. In a
development build (`import.meta.env.DEV`), `?ui=arak`, `?ui=palac` or
`?ui=boje` starts the mobile shell over the web host, so Playwright can drive
it with dropped files, as `tools/verify-ui.mjs` does.

What is shared with the desktop: the host (`createShell`),
`registerCommands`, `useWorkspace`, `actions.ts`, `library.ts` and the
session. The mobile shell imports none of the desktop's components
(`TitleBar`, `Sidebar`, `TabBar`, `Toasts`).

Until Arak passes K6, the mobile shell starts in the debug build only, and the
release build on Android keeps the old narrow layout.

## Look: tokens, themes, typefaces

**Tokens in three levels.**

1. **The contract with the editors** is the names they already use, read out
   of `packages/*/src/style.css`: `--ground`, `--surface`,
   `--surface-raised`, `--chrome`, `--ink`, `--ink-soft`, `--ink-faint`,
   `--ink-ghost`, `--ink-inverse`, `--rule*`, `--accent*`, `--danger`,
   `--warn`, `--warn-wash`, `--shadow-*`, `--sans`, `--serif`, `--mono`,
   `--fs-*`, `--radius` and `--book-*`. To them come the roles all three
   concepts need: `--hit`, `--hit-current`, `--changed`, `--unsaved`,
   `--uncertain`, `--paper` and `--paper-ink`. An editor reads a hit's
   colour as `var(--hit, <today's colour>)`, so the desktop does not change.
2. **Per interface**, `ui/<name>/tokens.json` holds the raw colours for light
   and dark and maps them onto level 1 and onto the interface's own roles
   (`--dlan`, `--jagodica`, `--stol`, `--ugao`, `--namjera-*`). A generator in
   Node, with no dependency, writes the CSS under
   `:root[data-ui="arak"][data-scheme="dark"]` and its siblings.
3. **The theme.** `Themes` resolves the system's scheme once and sets
   `data-scheme`, so the blocks are not written three times over, as they are
   in `tokens.css`. `EXPOSED_TOKENS` are read after `data-ui` is set, so the
   editors that paint on a canvas follow the interface too. In Četiri boje,
   `[data-intent=…]` changes `--accent`, and an editor follows the intent's
   colour by itself.

Kapa's rule that no colour is written into a component holds here as well.
Contrast is computed in Node from the JSON (`tools/verify-mobile-tokens.mjs`),
and the build fails below 4.5:1 for text and 3:1 for everything else.

**Typefaces.** All three concepts propose **Literata** for the text of
documents, so that is one shared face. For the interface they propose
Bricolage Grotesque (Palac), Barlow Semi Condensed (Arak) and Archivo (Četiri
boje); Arak adds Carlito for tables.

| Face | Licence | Where it was read |
| --- | --- | --- |
| Literata | SIL OFL 1.1 (`OFL.txt`) | its repository |
| Bricolage Grotesque | SIL OFL 1.1 (`OFL.txt`) | its repository |
| Barlow | SIL OFL 1.1 (`OFL.txt`) | its repository |
| Archivo | SIL OFL 1.1 (`OFL.txt`) | its repository |
| Carlito | SIL OFL 1.1, with "Carlito" a Reserved Font Name | Font Squirrel and CTAN only, not a file in its repository |

Coverage of č, ć, đ, š and ž was not checked for any of them.

How they come in: the files from the upstream release, beside their
`OFL.txt`, under `shell-ui/src/mobile/fonts/<family>/`, with a SHA-256 the
check pins; an `@font-face` with a relative URL, so Vite bundles the file and
the CSP's `'self'` holds; an interface's display face in its own lazy CSS, so
only the chosen one loads; **no subsetting** until the Reserved Font Names are
read, because under the OFL a subset is a Modified Version.

The first version runs on the system's faces: the look comes last.
Literata comes after K6, the display faces in K9, each after Čovik's yes, and
the Android package budget (50 MB, ADR 0003) is measured again.

## Changing the interface

- **`chooseInterface(shell, next)`**, in `mobile/common`, refuses while a tab,
  the scratch or an edit session holds something unsaved, and lists what to
  save or discard. Otherwise it calls `saveSession`, sets `mobile.ui` and
  reloads.
- **Kept:** the open documents and which is in front (the session comes back
  by itself on a handheld), each document's position (`memory.ts` and
  `restorePosition`), the memory per intent, the hand, the theme, the
  language and the recent files.
- **Not kept:** the open layers and the search being typed. Coming back into
  the middle of *lepeza* in another interface would mean nothing.
- **The default** is the first one built, Arak, until Čovik chooses.
- **The first start asks** once two interfaces exist: one screen with three
  large pictures, changeable in the settings afterwards. An installation that
  updates into the second interface is asked once too.
- **A note's draft** is kept on `visibilitychange: hidden`, in the app's own
  storage, because Android ends an app in the background. An Office document's
  changes have no draft; the interface says plainly that they are unsaved.

## Testing, without paying three times

| Level | What | How often | With |
| --- | --- | --- | --- |
| **A** | the rules of `mobile-core`: the stack and Back (on a question, Cancel), the keyboard's arithmetic, the order of open documents, `canSwitch`, the edit session, the scan | once | `tools/verify-mobile-core.mjs`, in Node through `tools/ts-resolve.mjs`, as `verify-formula` is; no browser |
| **B** | the editors' contract: a target at given coordinates; only faithful scopes offered; apply, save, then `verify-office-readback` and `verify:word` byte for byte; the preview equal to the recalculation after the commit; undo; untrusted text (bidirectional and control characters, a run of 10 000 characters) shown inert and capped | once per editor | `tools/verify-touch-contract.mjs`: Playwright, the web host, the fixtures and at least ten real documents from the corpus |
| **C** | the four uses, a change of interface, and the questions (lost formatting, changed outside, unsaved) | three times, thinly | `tools/mobile-scenarios.mjs` (the steps and the assertions as data, once), `tools/mobile-drivers/arak.mjs`, `palac.mjs`, `boje.mjs` (each step into taps, 250 lines at most each), and `tools/verify-mobile.mjs --ui=… --target=browser` or `--target=device` |

On every screen of level C the same invariants are checked: no horizontal
overflow; touch targets of 44 px or more, with named exceptions (words in a
text, cells); no error in the console; no network request (in the browser
through `page.route`, on the device through the devtools protocol's
`Network` domain); a question shown above the keyboard, with Back meaning
Cancel.

The drivers stay thin because every interface draws shared markers into the
DOM — `data-ul-role="library-row"`, `edit-field`, `save`, `question` and so
on — and the drivers find things by them.

**`verify:mobile` is rewritten.** `tools/verify-mobile-layout.mjs` encodes
the old layout; it is deleted when Arak passes K6, and `verify:mobile` then
runs `tools/verify-mobile.mjs`. On the device it adds only what a browser
cannot show: the insets read out of the WebView, the real keyboard (the edit
field's lower edge at or above the keyboard's top), and a tap that arrives as
a finger. `verify:library` stays; it finds the library's rows through the
driver's marker.

**The device loop** (`tools/device-session.mjs`, the debug build
`org.uleditor.app.debug`). The whole scenario table runs for the interface
being changed; the other two get a short pass — open, correct, save, Back.
Before a tag, the whole table runs for all three. CI runs A, B, and C in the
browser.

**Mutations.** Every exported rule of level A, every behaviour of the contract
in level B and every invariant of level C is broken once, and its check has
to fail: Back on a question calling Discard; `applyTarget` writing into the
wrong run; the tool row's `preventDefault` removed; the keyboard's inset
removed. What each mutation did is written into its commit, as before. The
trap with CRLF that makes a mutation look alive holds here too.

## Scope of the first version

| Capability | In the first version? | What it takes | Strength |
| --- | --- | --- | --- |
| **A camera** | **Yes, through the system's camera app** | `<input type="file" accept="image/*" capture="environment">`. The generated `RustWebChromeClient.onShowFileChooser` (wry 0.55.1) already starts `ACTION_IMAGE_CAPTURE`, and because the manifest does not declare `CAMERA`, it does so without asking for it (`isMediaCaptureSupported`). Android's documentation: a `SecurityException` follows only when an app declares `CAMERA` and has not been granted it. No dependency, no permission. The picture goes to Rust once (`ul-image`: scale down, crop, straighten), then to `packages/ocr`. | **F4**: the picture is left in `getExternalFilesDir(DIRECTORY_PICTURES)` (`createImageFile`) and has to be deleted; `res/xml/file_paths.xml` has `<external-path path=".">`, the whole shared storage, and has to be narrowed |
| A live camera in the app, with the paper's frame found | **No** | the `CAMERA` permission and `getUserMedia`: script in the page could start the camera whenever it liked; the Android WebView's way out to the network is not measured (ADR 0005), and the manifest holds `INTERNET`; finding a paper's edges is a new algorithm | F4, an ADR of its own |
| **Saving a new note or scan on the phone** | **Yes, it has to be** (two of the four uses need it) | On Android `pick_save_target` goes through the system's dialog, which hands back `content://`; `into_path()` then fails (ADR 0003, point 6), so it most likely does nothing — inferred from the code, not seen. An amendment to ADR 0005: on Android, Rust creates new files only in its own folder (`Documents/ulEditor/…`), with `create_new`, a name under the rules of `dialog_offer`, and a pace | **F4** |
| OCR with the confidence of each word | Yes | `blocks: true` in tesseract.js 7 (`Word.confidence` is in its types) | F2 |
| Suggestions for spelling, a wavy line | **No** | a dictionary and an engine: a new dependency and a licence (the Croatian Hunspell dictionary's licence was not read). The first version has the suggestions of the system's keyboard; whether the WebView underlines misspellings is not measured | an ADR of its own |
| "Open with" and "Share" | **No** | `content://` (its prerequisite, card 495, is built: ADR 0006); a source of consent for an intent (ADR 0005); intent filters in the manifest; Kotlin for `ACTION_SEND`. No official Tauri plugin for sharing was found; the unofficial ones (`tauri-plugin-sharekit` 0.3.1, `tauri-plugin-sharesheet`) would be a new dependency | F3 and F4, an ADR of their own |
| Full screen | **Not needed** | the app has no address bar, and `MainActivity` already calls `enableEdgeToEdge()`; the concepts asked for it only for the prototype in a browser | — |
| A search without diacritics | Yes | `foldDiacritics` and `fold.ts`; other forms of a word (Arak's „jamčevinu" from „jamcevina") are not in it | F2 |
| A search through the content of the whole library | In part | by name in the first version (it exists). `project-search.ts` searches folders (60 documents at most, parsed in the page); on the phone it has to be pointed at the library's offered files and its memory measured | F2, after K6 |
| Pictures of each document's page in the library | **No** | a provider-level thumbnail for every format, parsed for every file in the library; the first version shows the format's icon | F2, after K8 |

## The matrix

Every step of the four uses, in each of the three concepts, and where its
behaviour lives. Everything on the screen is drawn by the interface; the tag
says where the behaviour is:

- **S** — shared: an existing action or command of the shell, `mobile-core`,
  `mobile/common`, or Rust. The interface only draws it.
- **E** — the editor, through `touch.ts` or the contract it already has.
- **I** — that interface alone.
- **—** — not in the first version; the cell says where it goes.

The last column names the code. The steps are the concepts' own, from their
`KONCEPT.md` and prototypes; a dash in a concept's column means that concept
has no such step.

### Use 1 — Read a PDF, find a word

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| Say what you want | — (the library is the base) | — (*zid* is the base) | *čitati* on the start, with its line „Nastavi Ugovor o najmu na 3. stranici" **I**; the line's facts **S** | `memory.ts` |
| See the documents | the list grows from the bottom, the newest lowest; *vitrina* shows the lowest row large **I** over **S** | *zid*: pages grouped by Danas, Ovaj tjedan, the month **I** over **S**; each document's page picture **—** (the format's icon; after K8) | the reading library: „Nastavi gdje si stao" with progress; filters PDF, Knjige, Word i Excel, Prezentacije **I** over **S** | `library.ts` (`useLibrary`, newest first); `memory.ts`; a filter is a predicate over the same list |
| Find it among all documents | the search field at the bottom of the library, a snippet in *vitrina* **S** (by name) | *crta* at the bottom, results with a snippet **S** (by name) | „pričuv" through all documents, open at the hit **S** (by name) | by content: `project-search.ts` over the library, after K6 |
| Open it | tap the lowest row **S** | tap the page **S** | tap; it opens where reading stopped **S**, **E** | `openDocument`; `memory.ts` and `restorePosition` |
| First-time hint | — | *ceduljica* by the corner, once per kind of document **I**; "seen" **S** | — | `prefs.ts` |
| Where am I | „str. 1 od 6" in the name bar **I**, from the status **E** | the page number printed on each page in *žig* ink **E** | the counter „3 / 6" **I**, from the status **E** | `onStatusChange`; a page-number option in `editor-pdf` |
| Turn pages | a swipe **E** | a swipe **E** | a swipe **E** | `editor-pdf` by touch (ADR 0003 step 7) |
| Go to a page | „Stranice": pictures of the pages in *dlan*, tap the 3rd **I** over **E** | — | tap the counter: pictures of the pages, tap the 5th **I** over **E** | `pages`, `showPage`, `drawPage` (new), drawn by the editor's thumbnail code |
| Open the search | *jagodica* „Traži" **I**; the field above the keyboard **S** | the corner, then Traži on *stol* **I**; *crta* above the keyboard **S** | the magnifier **I**; the field above the keyboard **S** | `useFind`, `keyboard.ts`, `find.inDocument` |
| Type, see the hits | „kaucij": four hits marked, „Pogodak 1 od 4, stranica 2" **E** | „jamcevina" finds Jamčevina **E** with `foldDiacritics`; jamčevinu and jamčevine **—** (word forms: own research) | „najamnin": seven hits, the current one ringed **E** | `find()`, `FindResult.label`, `--hit`, `--hit-current` |
| Next hit | Enter hides the keyboard; *jagodica* „Sljedeći" puts the hit in the upper third **S**, **E** | arrows, „3 od 6" **S** | the arrow down **S** | `useFind` and `reveal()`; the editor honours `--ul-obscured-bottom` |
| Text fitted to the screen | — | — | „Prilagodi tekst ekranu" **E** | `beginReading`, the reading room that exists |
| Back | closes the search, then the document's view; the document stays open **S** | closes *crta*, then back to *zid* **S** | closes the search, then the document (into the reading library), then the start **S** | `layers.ts`, `documents.ts` |

### Use 2a — Fix one word in Word

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| Get to the document | the library **S** | *zid* **S** | from reading, the tab *ispraviti*: the same document at the same page **S**, **E**; or the correcting library: only what can be changed, unsaved first, and why a book is not there **I** over **S** | `openDocument`; the mode in `documents.ts`; `setTouchEditing`; `hasCapability(…, 'edit')`; `tab.dirty` |
| The hint | — | *ceduljica*: „Dodirni bilo koju riječ…" **I** | „Dodirni riječ koju želiš promijeniti." **I** | `prefs.ts` |
| A misspelt word stands out | a wavy line; „Sumnjivih u dokumentu: 2" **—** | a wavy line **—** | — (a wrong weekday, found by eye) | spelling: an ADR of its own, after the first version |
| Tap the word | a tap **E**; or *jagodica* „Ispravi" jumps to the first suspect word **—** (it needs spelling) | a tap **E** | a tap; the word marked **E** | `onEditTarget` |
| The field | *dlan* becomes the panel: the field with the word **S**, suggestions **—**, arrows to the neighbouring word **I** calling **E** | *crta*: suggestions **—**; Riječ, Rečenica, Odlomak, offered by **E**; the field **S** | above the keyboard: Riječ, Rečenica, Odlomak, offered by **E**; the field, word selected **S**; arrows **I** calling **E** | `useEditSession`; `EditTarget.scopes`; `stepTarget` |
| Type the correction | the system's keyboard **S** | the system's keyboard **S** | „srijedu" **S** | `useEditSession` commits on `submit`, never on `keydown` (keyCode 229) |
| Commit | a suggestion **—**; *jagodica* „Prepiši" **I** | „Zamijeni" **I** | „Ispravi" **I** | `applyTarget`: one step of undo |
| Changed, not saved | the word underlined in violet **E**; *jagodica* turns into „Spremi" **I** | underlined in *žig* ink **E**; a red dot on the corner; Poništi and Spremi appear **I** over **S** | underlined in red **E** with the intent's `--changed`; „1 izmjena nije spremljena" **I** over **S** | `--changed`; `onDirtyChange` into `tab.dirty` |
| Undo | in *lepeza* **S** | Poništi **S** | Poništi, Ponovi **S** | `edit.undo`, `edit.redo` |
| Save | *jagodica* „Spremi" **S** | Spremi under the corner **S** | Spremi **S** | `saveTab`, with ADR 0004's questions through `shell.notify` |
| Saved | a stamp „Spremljeno" with the time, a message with the folder, „spremljeno u 13:15" in the name bar **I** over **S** | a stamp with the date and time, „Spremljeno: Documents/Zapisnik sa sastanka.docx" **I** over **S** | „Spremljeno u …"; the underline turns grey **I** over **S**, **E** | when it was saved: `documents.ts`; the editor drops its marks on a save |

### Use 2b — Fix one number in Excel

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| The table | the table on the page, the sheet's name under it **E** | the table **E** | the table, with its first column fixed **E** | `editor-office`; sticky headers exist (`style.css`), a fixed first column is to be checked |
| Tap a cell | C4 **E** | D4 **E** | D3 **E** | `onEditTarget`, kind `cell`, `inputMode: 'decimal'` |
| What it is | „C4, Plin, listopad" **E** | „D4 Plin, studeni" **E** | „Voda, ožujak (D3), u eurima" **E** | `EditTarget.label`, from the row's and column's headers and the number format |
| Type the number | the program's own number pad in *dlan*, larger keys; ABC opens the system's keyboard **I** | the system's keyboard, numbers **S** | the system's keyboard, numbers, 38,40 selected **S** | `useEditSession` takes text from either; `inputmode="decimal"` (K2 e) |
| Keep it in view | the table moves so all of it, or the cell, is above *dlan* **E**, **S** | the cell above *crta* **E**, **S** | the cell above the field **E**, **S** | `--ul-obscured-bottom`, honoured by the editor |
| What will change | „Ukupno za listopad: 233,05" in *dlan* **E** | while typing: „Mijenja se: Ukupno, studeni 263,24 → 259,99, Prosjek 226,22 → 225,14" **E** | afterwards: „Ukupno za ožujak: 257,09 €, bilo je 260,69 €." **E** | `previewTarget`, over `#recalc` and `formula.ts` |
| Commit | *jagodica* „Upiši"; Ukupno and Razlika flash **E** | Upiši; the total and the average light up **E** | Ispravi; the month's total flashes **E** | `applyTarget`; dependants marked with `--changed` |
| The next cell | arrows up and down **I** calling **E** | — | — | `stepTarget('up' \| 'down')` |
| A formula | ABC, the system's keyboard **I**; whether a formula is taken **E** | — | only numbers change; a tap on a total shows its formula **I** over **E** | the editor answers, as on the desktop |
| Save | *jagodica* „Spremi" **S** | Spremi, the stamp **S** | Spremi; „Formule su preračunate" **S**, **E** | `saveTab`; the editor's status |

### Use 2c — Mark a PDF with a pen

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| Take the pen | the pen in *dlan*, three colours **I** over **E** | under the corner: Olovka — blue, red, *signir*, an eraser, Gotovo **I** over **E** | the tab *ispraviti*: Listaj, Olovka, Marker, Bilješka **I** over **E** | `tools()`, `runTool()` (new), over the PDF editor's existing tools |
| Draw | a finger **E** | a finger **E** | a finger **E** | `editor-pdf`, `touch-action` (ADR 0003 step 7) |
| Not saved yet | **S** | the red dot **S** | „1 izmjena nije spremljena", Poništi, Ponovi, Spremi **S** | `tab.dirty`, `edit.undo` |
| Save | **S** | **S** | „Spremljeno u 13:18" **S** | `saveTab` |

### Use 3 — Write a note

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| Start one | Novo, then Nova bilješka **I** | the first sheet on *zid*, „Piši…" **I** | the tab *pisati*: „Nova bilješka", or „Bilješka uz *the document last read*" **I** | `notes.ts`: an unnamed Markdown document held in memory until it is first saved, as the scratch panel holds OCR text today |
| The field takes the focus, the keyboard comes up | **E**, **S** | the focus in the first line, Enter into the text **E**, **S** | **E**, **S** | `editor-markdown`'s `focus()`; `keyboard.ts` (K2 a) |
| Tools above the keyboard | Poništi, Popis, Zadatak; *jagodica* „Spremi" **I** over **S**, **E** | Naslov, Podebljano, Popis, Kvačica, Poništi, Spremi **I** over **S**, **E** | Naslov, Podebljano, Popis, Kvačica, Pregled, Spremi **I** over **S**, **E** | the tool row that keeps the focus (`mobile/common`); the Markdown actions through `tools()` (new) |
| Type a lot | **E** | **E** | **E** | CodeMirror in `editor-markdown` (typing measured in K1) |
| The name | the first line becomes the name **S** | the first line **S** | the first line is the title and the file's name **S** | `notes.ts` proposes, Rust decides (K5) |
| Save | „Ideje za balkon.md" in Bilješke ulEditora **S** | the stamp; „Documents/Bilješke/Pitanja za majstora.md" **S** | „Spremljeno: Za sastanak stanara.md u Documents/Bilješke" **S** | `saveTab`; a new file only in `Documents/ulEditor/Bilješke` (O5, K5) — none of the concepts' folders |
| Leave with Back | the layer closes **S** | the layer closes **S** | Back saves the note **I** over **S** | the draft is always kept **S**; that Back also saves is Četiri boje's own choice, allowed for a note only and only through `saveTab` |
| Ended in the background | — | — | „ništa napisano se ne gubi" | the draft, on `visibilitychange: hidden`, for all three **S** |
| The preview | „Pregled", with checkboxes **E** | the corner, then Pregled: a diagram and a formula **E** | Pregled **E** | `editor-markdown`'s preview; Mermaid exists (`mermaid.ts`), rendering of formulas was not found in the package and is to be checked |
| Found again | the lowest row of the library **S** | on *zid* under Danas **S** | in *pisati*'s list **I** over **S** | the library adds what was just written |

### Use 4 — Photograph paper, get the text

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| Start | Novo, then Slikaj papir **I** | the sheet „Slikaj papir" on *zid* **I** | the tab *slikati* opens the camera at once **I** | `scan.ts` |
| The camera | a drawn camera, the paper's edge found **—** | a frame, „Papir je pronađen. Drži mirno." **—** | a green frame, the gallery, the shutter, the flash **—**; the gallery **S** | the first version opens the system's camera app (`<input type="file" accept="image/*" capture="environment">`) **S**; a picture from the gallery through the same input without `capture` **S**; a live view: an ADR of its own |
| The shutter | *jagodica* „Snimi" **—** | the shutter **—** | the shutter **—** | the camera app's own shutter |
| Crop | four corners: one chosen on a small map in *dlan*, moved with a pad at half the finger's speed, or its handle dragged **I** over **S** | the four corners dragged **I** over **S** | the four corners dragged; the language, Croatian and English **I** over **S** | the corners and their limits: `scan.ts`; straightening: `ImageOps.perspective` in `ul-image` (new); the first corners are the whole picture (finding the edges comes later) |
| Recognise | „na uređaju, hrvatski i engleski" **S** | a bar sweeps over the sheet: „…na telefonu, bez mreže" **I** over **S** | „Prepoznajem tekst… Sve se radi na telefonu." **I** over **S** | `packages/ocr` (tesseract.js 7); both languages at once (`hrv+eng`) is to be confirmed — `ocr.ts` takes one at a time today |
| The text | two uncertain words dotted **S** | the same **S** | the same **S** | `Word.confidence` (`blocks: true`); the OCR result view in `mobile/common` |
| Correct a word | — | a tap on „0123": the same *crta* as in Word, „0128" **S** | — (after saving, „Ispravi ga" opens it as a Word file) | the result view speaks the edit session |
| Copy | Kopiraj **S** | Kopiraj tekst **S** | Kopiraj **S** | `shell/clipboard.ts`; the clipboard on Android to be measured |
| Save as | *lepeza*: Word, PDF with the picture and the text, Bilješka, plain text **I** over **S** | a name; PDF s tekstom, Word, TXT **S** | a name; Word or a note **S** | `text-export` (txt, md, docx and pdf exist); a PDF with the picture under the text **—** (after the first version); a new file only in `Documents/ulEditor/Skenirano` (O5, K5) |
| Afterwards | *jagodica* „Otvori"; the lowest row of the library **S** | the stamp; on *zid* **S** | a red „Ispravi ga", the saved Word in *ispraviti* **S**, **I** | `openDocument`; the mode in `documents.ts` |
| The picture left behind | — | — | — | deleted once processed **S** (K5); today it stays in `Android/data/<id>/files/Pictures` |
| Back to the start | — | — | Back, Back: the start, its memory lines refreshed **S**, **I** | `layers.ts`, `memory.ts` |

### Around the four uses

| Step | Palac | Arak | Četiri boje | Lives in |
| --- | --- | --- | --- | --- |
| No permission | an honest *vitrina*: what is seen, what is not, three steps; *jagodica* „Uključi pristup" **I** over **S** | a sheet, „Android skriva tvoje dokumente", „Uključi dozvolu" **I** over **S** | „Android ti skriva dokumente", „Otvori postavke" **I** over **S** | `useLibrary.blocked` (exists); opening the system's all-files screen directly is new native code (K5); scanning again on return **S** |
| Open one file without the permission | „Otvori datoteku" **—** | „Otvori jednu datoteku" **—** | — | the system's picker hands over `content://`; not offered in the first version (ADR 0003 step 8) |
| Several documents open | swipe the name bar, dots for the count; a tap opens *lepeza* with the others, Knjižnica, „Zatvori ovaj dokument" **I** over **S** | *hrpa* on *stol*, a tap puts one on top; Odloži, then „Spremi i odloži" or „Odloži bez spremanja" **I** over **S** | the name button „još 2 otvorena", the sheet Otvoreno with each one's intent and state; Odloži, „Spremi i odloži"; a swipe on the name **I** over **S** | `documents.ts` (order and neighbours); `closeTab` with `confirmDiscard`; the swipe helper |
| Back | the top layer **S** | the top layer **S** | the top layer **S** | `layers.ts` |
| A question: formatting would be lost, the file was changed outside, unsaved work | not drawn in the prototype | not drawn | not drawn | `shell.notify`'s sticky records **S**; every interface has to draw them, above the keyboard, with Back on the action marked `cancel` |
| The hand | „Držim desnom rukom" in the settings **S** | the corner on the left **S** | — | `prefs.ts`, `mobile.hand` |
| The interface | — (one) | — | — | `prefs.ts`, `chooseInterface` **S** |
| Theme, language | light and dark by the system; Croatian, English **S** | the same **S** | the same **S** | `Themes`, `chooseLocale` |

### What the matrix added

Drawn step by step, the matrix added six things to the decision as it was
first given to Čovik. All of them sit inside it; none changes one of his
answers.

1. **`touch.ts` grew two parts:** `tools()` and `runTool()`, for the PDF
   pen, marker and note and for the Markdown actions, since no editor
   registers commands with the host; and `pages()`, `showPage()` and
   `drawPage()` for the page strip in Palac and Četiri boje.
2. **The covered part of the screen is a contract.** Palac puts a hit in the
   upper third and keeps a cell above *dlan*; `FindResult.reveal()` takes no
   place. So the shell sets `--ul-obscured-top` and `--ul-obscured-bottom`,
   and an editor's scrolling container honours them through
   `scroll-padding`.
3. **A picture of each document in the library** (Arak's *zid*, Palac's
   *vitrina*) needs every format to draw a thumbnail of every file. Not in
   the first version; the format's icon instead.
4. **None of the prototypes draws ADR 0004's questions** — formatting that
   would be lost, a file changed outside, unsaved work. Every interface has to
   draw them; level C checks it.
5. **Both languages at once.** The concepts recognise Croatian and English
   together; `ocr.ts` takes one language at a time today. `hrv+eng` is to be
   confirmed in `packages/ocr`.
6. **Smaller differences:** „Otvori jednu datoteku", offered by Palac and
   Arak, is not in the first version (`content://`); Četiri boje's „Back saves
   the note" is that interface's choice, allowed for notes only and only
   through `saveTab`; the concepts' folders (`Documents/Bilješke`,
   `Documents/Skenirano`, „Bilješke ulEditora") give way to
   `Documents/ulEditor/…` (O5); every step that needs spelling — Palac's
   „Ispravi" jump, the suggestions — waits for its own ADR.

## Steps

Each ends in a check that runs, as in ADR 0003. The marked ones go through an
independent security review before they are called done.

| Step | What | Strength | Done when |
| --- | --- | --- | --- |
| **K0** | This ADR, the amendment to ADR 0003, and the design note for `touch.ts` (its exact members, before K4) | **F3** | Čovik has answered the eleven questions; the ADR is accepted. *Done 2026-11-07, but for the design note.* |
| **K1** | The baseline of ADR 0003 step 2, on the release APK as it is today: cold start, the WebView's memory over the largest real PDFs, opening the largest real `.docx` and `.xlsx`, typing in Markdown, the APK's size | F2 | the figures are written into ADR 0003 |
| **K2** | Measured on the device, in the debug build, on the Pixel 8 Pro and the Redmi: the six questions in *Measured on the device* below | F0, then F2 | every question has a measured answer on both phones, written below. **If the keyboard (a) cannot be made to work, everything stops**: all three concepts depend on it |
| **K3** | The shared layer: `packages/mobile-core` with its `MODUL.md`, `mobile/common`, `Pane` moved out, the entry in `main.tsx` (debug build only), `cancel` on `NotificationAction` | F2 | level A green, and each rule's mutation red; the desktop's `verify:all` and the desktop session checks unchanged |
| **K6a** | **Arak for reading, before K4** (Čovik, 2026-11-08, O12): *zid*, the sheet, the corner, *stol* with *hrpa*, *crta* for the search; open, read, find a word, several documents, Back, the questions drawn; Arak's tokens, light and dark, on the system's faces; still the debug build only | F2 | level C green for reading in the browser (448 and 360 px, light and dark) and on both phones by touch. A document is edited the way its editor allows today until K4; Arak offers no editing of its own |
| **K4** | `touch.ts`, and the editors that take it: `editor-office` (a word in `.docx` and `.odt`, a cell and its preview in `.xlsx` and `.ods`), `editor-pdf` (ADR 0003 step 7, tools, pages), `editor-markdown` (the note, its tools), and `packages/ocr` moved out of `editor-image` | F2, and **F4** for the contract | level B green over the fixtures and at least ten documents from the corpus, read back byte for byte; `verify-office-editing` (the double-click) unchanged; the review passed |
| **K5** | Writing new files on Android (an amendment to ADR 0005: Rust's own folder, `Documents/ulEditor/`), the camera through the system's app, the picture deleted afterwards, `file_paths.xml` narrowed, the Android WebView's way out to the network measured (`tools/verify-mobile-egress.mjs`), whether the release runs without `INTERNET` (O10), and opening the system's all-files screen | **F4** | a check on the device shows: nothing created outside the folder, nothing overwritten, no picture left behind, the way out measured and written down; the independent review passes |
| **K6** | **Arak, to the end:** the four uses, the library without permission, Back, the questions, a note's draft | F2 | level C green in the browser (448 and 360 px, light and dark) and on both phones; ADR 0003's "How we will know" done by touch over real files; Čovik uses it for about a week. Then the release on Android starts the mobile shell, and `verify-mobile-layout.mjs` is deleted |
| **K7** | **Palac:** the hand, its own number pad as a second source for the same edit session, the choice of interface in the settings, the change by reload | F2 | level C green for both; **the boundary holds**: no line changed in `packages/editor-*` or `plugin-sdk`, at most 10 % of the lines of `mobile-core` and `mobile/common` changed, and `ui/palac/` at most 40 % of the size of the shared mobile code |
| **K8** | **Četiri boje:** the memory per intent in `memory.ts`, the mode through `setTouchEditing`, the question at the first start | F2 | the same measure; level C green for all three |
| **K9** | Typefaces, each after Čovik's yes: Literata, then a display face per interface | F1 | `tools/verify-mobile-fonts.mjs`: the file and its `OFL.txt` present, its SHA-256, coverage of č ć đ š ž Č Ć Đ Š Ž, and the APK within 50 MB |
| **K10** | The independent review of K5, of every change to `AndroidManifest.xml`, `MainActivity.kt` and `file_paths.xml`, and of `touch.ts`; then a tag, asked of Čovik (a tag publishes a release) | **F4** | the review passes |

### What ADR 0003's steps become

| ADR 0003 | Here |
| --- | --- |
| 1. The device loop | done (afcf9d6, 2026-11-07) |
| 2. The baseline, measured | K1, unchanged |
| 3. Editing begins with a tap | replaced: on touch, a tap names an `EditTarget` (K4); the double-click on the desktop stays |
| 4. Enter, Backspace and Delete from `beforeinput` | not needed on the phone in the first version: nothing is typed into `contenteditable` there, and the field commits on `submit` or a button, so keyCode 229 never matters; it stays a card for a desktop with a touch screen |
| 5. A toolbar that keeps the focus | the tool row in `mobile/common`; its design note is K0's |
| 6. The keyboard does not cover the text | measured in K2, built in K3 (`keyboard.ts`, and `MainActivity.kt` if K2 says so) |
| 7. PDF by touch | K4, unchanged in purpose |
| 8. Say what does not work | K6: the mobile shell never offers "Open folder", and "Open files" works through the library or is not shown |
| 9. Independent review, then a tag | K10, over more |

## Measured on the device (K2)

Each answer is written in when it has been measured, with the build and the
date. The Pixel column was measured on 2026-11-07 in the debug build
0.6.6-debug (`org.uleditor.app.debug`) on a Pixel 8 Pro with GrapheneOS,
Android 17, the Vanadium WebView 156 and the AOSP keyboard, by probe elements
put into the running app over the devtools protocol, taps through
`Input.dispatchTouchEvent` and Back through `adb shell input keyevent`. The
Redmi column was measured the same day the same way, in the same debug build
installed by hand (MIUI refuses an install over USB without "Install via
USB"), on a Redmi Note 11 with Android 13, the Google WebView 156 and Gboard.
The Redmi lay on its side, MIUI turned the rotation lock back to automatic
twice, and so its figures are for landscape; its portrait figures for (a) and
(c) are still to be taken with the phone held upright.

| | Question | Why it matters | Pixel 8 Pro | Redmi Note 11 |
| --- | --- | --- | --- | --- |
| a | Do `visualViewport` and `innerHeight` change when the keyboard opens in the Tauri WebView, as it is with `enableEdgeToEdge()`? If not, does padding the WebView by the IME insets in `MainActivity.kt` make them change? Reports from others say the second is needed; it was not seen here. | every field in all three concepts stands above the keyboard | **Yes, with no change to `MainActivity.kt`.** `visualViewport.height` 997 → 632 CSS px with the keyboard up (it covers 365 px, 37 %), back to 997 on blur; `innerHeight` stays 997; `visualViewport` and `window` both fire `resize`. So `keyboard.ts` reads `visualViewport`, and the layout is not resized under it. | In landscape, **yes**: `visualViewport.height` 393 → 192 CSS px with the keyboard up, `innerHeight` stays 392, both `resize` events fire. Portrait not yet measured. |
| b | Does Back, with no listener, take the WebView back through `history.pushState` entries made on a tap (Tauri's `AppPlugin` calls `webView.goBack()` then)? Or is `onBackButtonPress` (`@tauri-apps/api` 2.11.1; `allow-register-listener` is in `core:app`'s default set) the way, and what does Back on the base layer do then? | `layers.ts`; the app must not quit in the middle of work | **Yes, `pushState` is enough.** With an entry pushed, Back keeps the app in front and the page gets `popstate`. With no entry of ours left, Back leaves the app for the launcher. So every open layer holds one entry, and Back on the base layer leaves. | **Yes**, as on the Pixel: with an entry pushed, Back keeps the app in front and the page gets `popstate`; with none, Back leaves for the launcher. MIUI let `adb shell input` through here. |
| c | What do `env(safe-area-inset-*)` hold inside the app's WebView? The brief's 51 and 24 px were measured in the Vanadium browser. | *dlan*, *ugao* and the tabs sit on the bottom edge | top 51 px, right 0, bottom 24 px, left 0: the same as the brief's. | In landscape: top 34 px, right 34 px, bottom 0, left 48 px (the cutout's side). Portrait not yet measured. |
| d | `<input type="file" accept="image/*" capture="environment">`: does the camera app open with no `CAMERA` permission, does the picture come back as a `File`, and where does the file stay? | use 4 | **No: the system's photo picker opens instead of the camera.** The cancel comes back as a `cancel` event. Logcat: `Tauri/FileChooser: Media capture intent could not be launched. Falling back to default file picker.`, though a camera answers `IMAGE_CAPTURE` (`app.grapheneos.camera/.ui.activities.CaptureActivity`). The generated `RustWebChromeClient.kt` asks `resolveActivity` first, and since Android 11 that finds nothing unless the manifest declares the intent in `<queries>`, which ours does not. The fix is a `<queries>` entry for `android.media.action.IMAGE_CAPTURE`: a manifest change, so it is built and reviewed in K5, and the picture's way back and where the file stays are measured then. | **Yes: MIUI's camera opens** (`com.android.camera/.OneShotCamera`), and Back from it comes back as a `cancel` event. Unlike the Pixel, the capture intent resolves here without `<queries>`; why was not looked into. The `<queries>` entry of K5 is needed either way, and the picture's way back is measured then. |
| e | `inputmode="decimal"`: does the system's keyboard offer a comma? | cells in use 2b, Arak and Četiri boje | **Yes**: the AOSP keyboard's number pad shows both `,` and `.`. | **Yes**: Gboard's number pad shows both `,` and `.`. |
| f | Does a tap reach the editor as a tap, with nothing waiting for a `dblclick`? | ADR 0003 point 1 | **Yes**: a tap gives `touchend` and `click` at once. Two taps 120 ms apart give `click`, `click` and then `dblclick` too, so an editor in touch mode must not take that `dblclick` for "type here" (`setTouchEditing`). | **Yes**, as on the Pixel: `click` at once; a double tap adds `dblclick`. |

## Rejected

| Option | Why not |
| --- | --- |
| **Three separate applications** — three APKs, or three React applications each with its own state | Saving with its questions (ADR 0004), consent (ADR 0005), the library and OCR three times over; three security reviews; a fix in one leaks into the others. As three APKs, about three times 45.7 MB. *In part, yes:* each interface has its own folder and its own lazy chunk — separate where it is drawn, and nowhere else. |
| **Only CSS themes over one structure** | The concepts differ in how one moves, not in colour: everything at the bottom with a fan; a sheet and a corner; a question and tabs. CSS cannot make three ways of moving without a DOM that holds all three, hidden — three interfaces again, only worse. *In part, yes:* inside an interface, light and dark and the hand are CSS, and the level of tokens is shared. |
| **One merged interface** | The cheapest, and Čovik declined it on 2026-11-07. *In part, yes:* the shared layer is the merged part, since everything that is not seen is one. If the measure in K7 fails, merging goes back to Čovik as an option. |
| **Changing the interface live, without a reload** | It saves one reload for something done once or twice; it costs three interfaces in a phone's memory, editors' DOM moved between trees, and faults in focus and in the stack of layers. |
| **Native Kotlin and Compose** (Kapa's Android standard) | The editors are TypeScript over the DOM and would be written again. ADR 0001 stands. |
| **The interfaces as workspace packages** (`@uleditor/ui-palac` …) | A circle with `shell-ui`, which has to import them while they need its actions and store; and nothing outside ulEditor would use them. |
| **A camera in the app in the first version** | See *Scope of the first version*. |

## Risks, and how they show early

1. **The keyboard in a Tauri WebView drawn edge to edge.** Others report
   that `visualViewport` does not change unless the activity pads the WebView
   by the IME insets; not checked for Tauri 2 here. It shows in K2 (a), and
   for good in the device check that the field's lower edge is at or above
   the keyboard.
2. **Back.** K2 (b); `onBackButtonPress` is the way back if history is not.
3. **A shared layer shaped by Arak** that Palac and Četiri boje do not fit.
   The matrix above was drawn for all three before any code; the measure in K7
   is the alarm.
4. **Paying three times after all.** Count the files each new capability
   touches; a driver stays within 250 lines; the device run's length is
   measured at each tag.
5. **Untrusted text from a document in the interface** — a word, a cell's
   label, OCR text: bidirectional and control characters, enormous strings.
   Level B and the independent review of K4.
6. **Work lost when Android ends the app.** A note has its draft; an Office
   document's changes do not, and the interface says they are unsaved.
7. **Arak's bet that people find what is hidden under the corner** — the
   concept names it itself. Čovik's week in K6 measures it.
8. **A sentence or a paragraph across several runs** cannot be corrected as
   one. How often, measured on the corpus in K4.
9. **The package budget with typefaces** (K9), and **i18n keys that collide**:
   the key is the English text, with no context, so where two interfaces want
   different Croatian for the same English, the English source differs;
   `verify:i18n` keeps the placeholders.

## Independent review

Through the reviewer who did not write it (`cuvar`), before "done":

- all of K5: the amendment to ADR 0005 for files created in the program's own
  folder on Android; the camera through the system's app and the picture
  deleted afterwards; `file_paths.xml` narrowed; the way out to the network
  measured; `INTERNET` removed, if it is;
- every change to `AndroidManifest.xml`, to `MainActivity.kt` where it touches
  a permission or an intent, and to `res/xml/file_paths.xml`;
- `plugin-sdk/src/touch.ts` as untrusted input into the interface: text only,
  lengths capped, control and bidirectional characters shown, the budget of
  the recalculation in `previewTarget`, bounds in `stepTarget`;
- `packages/ocr` and the straightening in `ul-image`: untrusted pictures and
  dimensions; OCR input never in a log or a crash report;
- a note's draft in the WebView's storage (data class `privatno`);
- after the first version, each with its own ADR: a camera in the app, "Open
  with", "Share", spelling.

## How we will know this was right

1. By K8, the third interface has come in with **no line** changed in
   `packages/editor-*` or `plugin-sdk`, and **at most 10 %** of the lines of
   `mobile-core` and `mobile/common` changed (`git diff --stat`).
2. Each `ui/*` folder, tokens and typefaces aside, is **at most 40 %** of the
   size of the shared mobile code.
3. One scenario table, with one set of assertions, is green for all three
   interfaces on the device, and each driver is within 250 lines.
4. The first five fixes to a shared flow after K8 touch no `ui/*` folder.

If the first already fails at K7, the work stops, and Čovik is offered the
merge.

## Čovik's answers (2026-11-07)

| | Question | Answer |
| --- | --- | --- |
| O1 | Which interface first, and which is the default | **Arak first, then Palac, then Četiri boje.** The default is the first built, until Čovik chooses. Arak has the least of its own, so the shared layer carries most and is proved at once; its one field, *crta*, for Word, Excel, search and OCR tests the editors' contract from the first day. |
| O2 | Ask at the first start | Yes, once two interfaces exist, and once to an installation that updates into the second. |
| O3 | A change of interface reloads, and only with nothing unsaved | Yes. |
| O4 | The camera through the system's camera app, with no live view in the first version | Yes. |
| O5 | Where new files are made on the phone | Yes: `Documents/ulEditor/Bilješke` and `Documents/ulEditor/Skenirano`, one folder under one rule in Rust. |
| O6 | Typefaces | The system's in the first version; Literata after K6; the display faces in K9; each face asked about on its own. |
| O7 | The old shell on Android | It stays until K6, then Android no longer starts it. The narrow CSS stays for narrow windows on a computer. |
| O8 | An Android tablet | It gets the mobile shell too. There is no tablet to test on; the risk is accepted. |
| O9 | Spelling, "Open with", "Share" | After the first version, each with an ADR of its own. |
| O10 | `INTERNET` in the release manifest | Removed, if K5 shows the release runs without it: the strongest closing of the way out on Android. |
| O11 | The hand | One shared setting, left or right. |

On 2026-11-08 Čovik answered one more:

| | Question | Answer |
| --- | --- | --- |
| O12 | The order: Arak at the end of K4 and K5, or Arak for reading first | **Arak for reading first (K6a).** The phone shows the new interface after one step rather than three; reading, the first use, needs nothing from `touch.ts` or from K5. Editing, the note and OCR follow through K4, K5 and the rest of K6. |

## Sources

- `MediaStore.ACTION_IMAGE_CAPTURE` and the `CAMERA` permission:
  <https://developer.android.com/reference/android/provider/MediaStore#ACTION_IMAGE_CAPTURE>
- `interactive-widget`, and "These changes do not affect WebView":
  <https://developer.chrome.com/blog/viewport-resize-behavior>
- The keyboard in a WebView drawn edge to edge, from others' reports, not
  measured here: <https://zenn.dev/tyto/articles/9392558fcb1b7b>,
  <https://margelo.com/blog/deep-dive-in-keyboard-handling>,
  <https://github.com/obbyworld/obby/pull/70.diff>,
  <https://forum.ionicframework.com/t/android-keyboard-edge-to-edge-issue-gray-area-after-keyboard-hide-and-inconsistent-resize-capacitor-8/251049>
- The typefaces' licences: <https://github.com/googlefonts/literata>,
  <https://github.com/ateliertriay/bricolage>,
  <https://github.com/Omnibus-Type/Archivo>, <https://github.com/jpt/barlow>,
  <https://www.fontsquirrel.com/fonts/carlito>,
  <https://ctan.org/tex-archive/fonts/carlito>
- Unofficial plugins for sharing:
  <https://docs.rs/crate/tauri-plugin-sharekit/latest/source/README.md>,
  <https://awesome.ecosyste.ms/projects/github.com%2Fbuildyourwebapp%2Ftauri-plugin-sharesheet>
- Read in the code, 2026-11-07: Tauri's `AppPlugin.kt` (tauri 2.11.5,
  `mobile/android/src/main/java/app/tauri/`) for Back; the default set of
  `core:app` (`permissions/app/autogenerated/reference.md`, the same version);
  `onBackButtonPress` in `@tauri-apps/api` 2.11.1 (`app.d.ts`); `Word` and
  `OutputFormats` in tesseract.js 7.0.0 (`src/index.d.ts`);
  `RustWebChromeClient.kt`, `WryActivity.kt` and `TauriActivity.kt` as
  generated into `gen/android/…/generated/`, which `.gitignore` keeps out and
  which change with wry (0.55.1 here) and Tauri.
