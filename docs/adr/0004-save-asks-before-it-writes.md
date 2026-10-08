# ADR 0004 — A save asks before it writes

**Status:** accepted 2026-10-06
**Date:** 2026-10-06
**Context:** card 471 (a save that loses something asks only after the file is
written) and card 485 (a save over a document somebody replaced while it was
open). Decided by the architect on its own model; Čovik's choice for 485 was
"ask, as VS Code does".

## Decision

A save is two steps, and the shell decides between them.

```ts
interface SavePlan {
  /** What this save cannot reproduce, as sentences for the person. */
  lost: string[];
  /** Writes. Records the prepared state as saved only once the write succeeded. */
  commit(options?: WriteOptions): Promise<SaveResult>;
}

interface EditorInstance {
  prepareSave?(target?: SaveTarget): Promise<SavePlan>;
  save(target?: SaveTarget, options?: WriteOptions): Promise<SaveResult>;
}
```

`saveTab` in the shell is the one place that writes:

1. **Prepare.** `prepareSave` computes what will be written and what is lost,
   and writes nothing. An editor that never loses anything may leave it out;
   the shell then wraps its `save` in a plan with nothing lost.
2. **Ask.** If `lost` is not empty, the existing "Save anyway / Cancel"
   question. Cancel ends the save: nothing written, the tab still dirty.
3. **Commit.** `commit()` writes.
4. **Changed outside.** If the write is refused because the file was changed
   or replaced outside ulEditor since it was opened (485), the shell asks
   "{name} was changed outside ulEditor since it was opened." — Overwrite or
   Cancel — and on Overwrite calls `commit({ overwriteChanged: true })` once.
   Any further refusal is reported as a failed save, never retried.

The consent to overwrite travels with the one call that needs it, in
`WriteOptions`. It is never stored in the shell, in `AppState` or in Rust.

Rust decides what "changed" is (`Workspace`): the file's identity — volume and
file ID on Windows, device and inode on Unix — its modification time and its
length, recorded when the file is read and after each write ulEditor makes. A
write that finds them different is refused with an error the shell recognises
by a fixed code, not by its wording. A write that was consented to over a file
whose **identity** changed does not take that file's security, attributes or
streams: they belong to whoever put it there. It gets the protection the
document had when it was opened (see *Amended after the independent review*).

## Why

- **One place decides.** The header of `shell/actions.ts` already promised it.
  With a plan, an editor cannot write before the question, because the shell
  does not call `commit` before the answer.
- **The image editor writes in Rust.** `images.write` reads, transforms and
  writes in one call, and the pixels never enter the page. So "the shell writes
  the bytes" cannot be the contract; a plan with `commit` can.
- **It was always meant this way.** `scratch.ts` already does export → losses →
  question → write. The PDF editor's `saveDocument` already returns the bytes and
  the losses before writing them; the `.xls` reader already works out the losses
  when the file is read, "so the warning can name it before anything is
  written".
- **The two questions do not contradict each other.** Losses are about the
  content and are answered without touching the disk; the replaced file is
  about the destination and is asked by the write itself — the check and the
  write are one Rust operation. On Windows the document is held from the check
  until the new version replaces it; on Unix, which has no such hold, the
  moment between the two stays.

## Rejected

| Option | Why not |
| --- | --- |
| `save({ acceptLoss })` — a first call that writes nothing, a second that does | The check stays in every editor, and one that forgets it writes silently — today's bug. The bytes are computed twice. `SaveResult` would need `written: false`. |
| The editor asks, through `fidelityWarning` | That is the contract written in `host.ts` today, and no editor follows it. With 485 there would be two places asking. |
| The shell writes the bytes | The image editor cannot hand bytes over. |
| Write, then restore a `.bak` on Cancel | Still writes first: the time changes, the file's ID changes (which 485 compares), sync clients and watchers wake. |
| Ask when the file is opened | Nothing can be decided then; what a PDF loses depends on what is done to it. |

## Rules for an editor

1. `prepareSave` writes nothing and records nothing as saved. It may finish an
   edit in progress; if the save is cancelled, the document simply stays dirty.
2. `commit` records as saved **what was prepared**, not what the editor holds
   when the write returns — the question is not modal, and the person may have
   typed while it was showing.
3. `commit` may be called again after a refused write, with the same bytes and
   the same chosen path.
4. `lost` holds finished, translated sentences.
5. An editor that can return a non-empty `lostFidelity` implements
   `prepareSave`. `save()` on such an editor is `prepareSave` then `commit`, so
   a host without the question still hears what was lost.

## Steps

1. Rust: the fingerprint in `Workspace`, the `Changed` refusal, `overwrite` on
   `write_file` and `image_write`, no carrying-over over a replaced file.
   *(security)*
2. plugin-sdk: `SavePlan`, `prepareSave`, `save(target, options)`,
   `WriteOptions.overwriteChanged`, `ImageService.write(…, options)`; the
   `fidelityWarning` comment; `SDK_VERSION` 0.2.0.
3. Shell: `saveTab` as above, one pending save per tab, `closeTab` waits for it;
   the old `save()` with losses reported without a Cancel that cannot undo
   anything; `tools/verify-save.mjs`. *(security)*
4. Editors: PDF and Office implement `prepareSave`; code, Markdown and image
   pass `options` through.
5. `verify-desktop-pdf-notes`: the file's bytes are the same until the answer,
   and after Cancel.

## Amended after the independent review (2026-10-06)

The F4 review of steps 1–5 did not pass it. What `Workspace` does now, each
rule with its test in `vfs.rs`:

- **Which record.** A document's record is kept under the path exactly as the
  page gave it, never under what the file system resolves it to: on NTFS that is
  spelled as the file on disk, and a replacement named `NOTES.md` for
  `notes.md` found no record and was saved over without a question. The record
  also keeps where the document was read from. A save whose name leads elsewhere
  now — other letters, a link put in its place, its folder swapped for a link —
  asks; with a yes it writes where the document was, replacing what has its name
  rather than writing through it, and is refused if that folder is gone. A save
  under another spelling of the same place finds that place's record.
- **One look.** The document is opened once for a save: whether it changed,
  which file it is and its security all come from that open file, which on
  Windows is held — nobody may write to it, rename it or delete it — until the
  new version replaces it. The record of the new version is asked of the new
  version before it is let go, and kept as the document only if the file under
  the name after the rename has its ID.
- **Whose protection.** The next version takes the document's own security only
  from a file provably the one it was read from: the same whole ID of a volume
  on this machine, and the same birth. Otherwise — a replacement, a 64-bit ID
  (WSL's 9P, FAT), any file on another machine — it gets the protection
  remembered from when the document was opened. Reading the document again
  agrees to its content, not to the security of whatever file is there: the
  remembered protection stays, and only what of the new file is stricter is
  added — a mark of the internet, encryption or being hidden, and on Unix only
  what both modes allow.
- **Made closed.** Where a DACL is to be set, the new version is made with one
  that lets its owner alone in, and a stream nobody wrote fails the save.

What that costs, chosen knowingly:

- Two DACLs cannot be intersected. A document replaced by a more closed one,
  read again and saved, gets the DACL it had when it was first opened.
- On a network share, a change of a document's security made while it is open
  is not kept by the next save there.
- A document another program holds open for writing — Word — is "changed
  outside" rather than "in use" when saved.
- On a volume with no file IDs, a file put in the document's place with the same
  times and length is saved over without a question; its security is still never
  taken.

Not changed: a save over a file nobody read here (Save As) still takes that
file's security, as decided above; and the first save of a file made seconds
before on WSL's 9P can be asked about once, its "birth" being a time 9P makes
up. Keeping the record by a token `read_document` hands the page, rather than by
the path, would end the question of spellings altogether; it changes the
contract between page and host and has a card of its own (495).

**Settled by ADR 0006 (2026-10-08):** a record is now a reading, found by the
token Rust gave it and by nothing else, so the spellings, the lookup by place
and the record under two names are gone — and a write that names no reading
(an export, the scratch panel) no longer moves a tab's record, so that tab's
next save is asked about it.
