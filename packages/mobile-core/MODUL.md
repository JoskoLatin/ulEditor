# @uleditor/mobile-core

The manifest of a ulul module, after Kapa's `standardi/ULUL-MODUL.md`. The keys
and their values (`biblioteka`, `privatno`, `bez izlaza`) are the standard's
own words, kept as it writes them so the catalogue (`portfelj/MODULI.md`) reads
every module the same way; what follows each is in English.

vrsta: biblioteka

svrha: the rules every mobile interface of ulEditor shares (Back and the stack
of layers, the keyboard's inset, the open documents, where each was left, the
phone's settings, correcting one target, paper to text, a note's name, Croatian
letters folded for a search), as pure functions and state machines.

ulaz / izlaz: TypeScript types, exported from `src/index.ts`; numbers, strings
and plain objects in, the same out. State goes in and comes out again, never
held. Anything remembered goes through a `KeyValueStore` (`get`, `set`) the
host hands in: in ulEditor that is `shell.settings`, in a check a `Map`.

klasa podataka: privatno. The names of documents (`uri`), positions in them,
the text typed into a correction, the text recognised from a photographed
paper. The last can hold other people's data, so nothing here writes to a log,
and of a picture only its size is held; its pixels stay with the host.

mreža: bez izlaza. No request, no import of anything that makes one.

resursi: CPU, a little. Nothing grows with a document but the first 4 KB a
note's name is looked for in.

licenca: Apache-2.0. No dependencies at all; TypeScript only to check it.

provjera: `node tools/verify-mobile-core.mjs` (`pnpm verify:mobile-core`),
in Node through `tools/ts-resolve.mjs`, no browser. Measured against: the
Pixel 8 Pro's own figures from ADR 0009, K2 (`innerHeight` 997 and
`visualViewport.height` 632 with the keyboard up; one `history` entry per
layer, and Back with none left leaving the app). The rest are the rules as the
ADR states them. Each exported rule was broken once and the check went red.
`pnpm typecheck` keeps the DOM out: the package's `lib` is `ES2023` alone.

domaćini: ulEditor (`packages/shell-ui/src/mobile/`, ADR 0009). ulul is a
candidate: `fold`, `proposeNoteName` and the stack of layers have nothing of
ulEditor in them.
