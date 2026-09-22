# ulEditor — stanje projekta

Izvještaj od 2026-09-22. Prvi u ovom repou (`PROJEKT.md` dosad nije postojao).

## Jedna rečenica

Jedan otvoreni editor za sve formate — kod, Markdown, PDF, Word, Excel,
OpenDocument i e-knjige — kao Tauri desktop aplikacija s Rust jezgrom
(`crates/ul-*`) i TypeScript editorima (`packages/editor-*`).

## Verzija i faza

Verzija: **0.5.0** (`Cargo.toml:9`, `package.json:3`, tag `v0.5.0`)
Grana: `main` (jedina lokalna; `origin/main`, `truss/main`)
Kopija: `origin` → github.com/JoskoLatin/ulEditor, `truss` → git.truss:2222/josko/ulEditor.
Oba na `5223a01` (pushano 2026-09-22); nepushan je samo ovaj izvještaj.
Zadnji rad: **2026-09-15** — `5223a01` "The window that stayed down, and the
select-all that took the whole program".
Faza: **2 (Office)**, pri kraju — `docs/ANALYSIS-AND-PLAN.md:367`. Faza 3 (Web,
WASM) nije započeta (`docs/ANALYSIS-AND-PLAN.md:686`).

## Radi

- **Release lanac je dostižan.** `pnpm verify:release-live` prolazi 14/14:
  `latest.json` odgovara odjavljenom zahtjevu HTTP 200, servira 0.5.0, potpis i
  artefakt postoje za sva četiri cilja (windows-x86_64, darwin-aarch64,
  darwin-x86_64, linux-x86_64). Time je v0.5.0 objavljen, a ne više draft; jesu
  li v0.3.3 i v0.4.0 objavljeni, **ne znam** — provjera pita samo `/latest`.
- **Spajanje ćelija u Wordu** — `Ctrl+M`, mjereno protiv Wordovog vlastitog
  spajanja (`a16086e`, `91ebd25`, `tools/verify-docx-merge.mjs`).
- **Cenzus formula nad stvarnim dokumentima** — 372 formule, `SUM` 79.8%
  (`b054c85`, `tools/formula-census.mjs`, `docs/ANALYSIS-AND-PLAN.md:645`).
- **Evaluator formula** — `SUM` i aritmetika, 296 od 344 formule (86%), a svaka
  od 48 odbijenih pogledana pojedinačno (`6ef397a`, `packages/editor-office/src/formula.ts`).
- **Prepoznavanje zastarjelih brojeva** — `recalculate` odgovara koja se
  vrijednost više ne smije prikazivati kao točna, kroz tri puta u zastarjelost
  (`9a2ce0c`, `formula.ts:442`).
- **Fidelity harness** — 604 stvarna dokumenta, nijedan ne pada
  (`docs/ANALYSIS-AND-PLAN.md:379`, `tools/fidelity.mjs`).

## Nije gotovo

- **`recalculate` nitko ne zove.** Izvezen je iz `formula.ts:442`, a jedini
  poziv u repou je `tools/verify-formula.mjs`. Pretraga po
  `packages/` i `apps/` ne nalazi poziv iz UI-ja. Commit `6ef397a` to i kaže:
  „Nothing calls it yet." Pogled na tablicu i dalje pokazuje spremljeni rezultat.
- **Plan zaostaje za kodom.** `docs/ANALYSIS-AND-PLAN.md:684` još piše „what is
  missing is that the view stops lying in the meantime" i „Output: v0.5", iako
  je v0.5.0 tagiran, a čisti dio posla napisan.
- **Installeri nisu potpisani** za Windows i macOS (`README.md:36`). Android APK
  jest. Ovo je kupnja certifikata, ne kod.
- **Cold start nije izmjeren** — `docs/ANALYSIS-AND-PLAN.md:770` ga zove
  „the last unmeasured budget".
- **Telemetrija nije započeta** (i ostaje opt-in) — `docs/ANALYSIS-AND-PLAN.md:228`.
- **`CLAUDE.md` u korijenu nije u gitu** — `git status` ga prijavljuje kao `??`.
  Ne znam je li to namjerno.

## Kartice

todo | visok | Pozvati recalculate iz prikaza tablice u editor-office
  » označiti zastarjele ćelije u gridu
  » pokriti to u verify:formula ili novom verifieru
todo | normalan | Uskladiti ANALYSIS-AND-PLAN.md s napisanim evaluatorom formula
todo | normalan | Izmjeriti cold start i zapisati budžet u plan
ceka | normalan | Kupiti certifikat za potpisivanje Windows i macOS installera
todo | nizak | Odlučiti ide li korijenski CLAUDE.md u git ili u .gitignore
todo | nizak | Započeti fazu 3 — prevesti ul-core u WASM

## Blokada

Potpisivanje installera čeka Joškovu odluku o kupnji certifikata (99 USD/god za
Apple, nekoliko stotina za Windows); sve ostalo je posao u repou i nije blokirano.

## Stranica u wikiju

Naslov: ulEditor — stanje

- Faza 2 (Office) je pri kraju: čita i mijenja `.docx`, `.xlsx`, `.odt`, `.doc`,
  `.xls` i RTF byte-range uređivanjem — što se ne dira, ne prepisuje se.
- Zadnji posao su formule: cenzus nad stvarnim dokumentima odredio je oblik
  (79.8% je `SUM`), evaluator pokriva 86%, a ostalo se pošteno prijavljuje kao
  zastarjelo umjesto da prikazuje broj koji više nije istinit.
- Jedino što stoji između faze 2 i kraja je poziv `recalculate` iz prikaza
  tablice; sve izvan repoa (potpisivanje installera) čeka kupnju certifikata.
