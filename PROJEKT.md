# ulEditor — stanje projekta

Izvještaj od 2026-09-23. Zamjenjuje onaj od 2026-09-22 (`e4881f6`).

## Jedna rečenica

Jedan otvoreni editor za sve formate — kod, Markdown, PDF, Word, Excel,
OpenDocument i e-knjige — kao Tauri desktop aplikacija s Rust jezgrom
(`crates/ul-*`) i TypeScript editorima (`packages/editor-*`).

## Verzija i faza

Verzija: **0.5.0** (`Cargo.toml:9`, `package.json:3`, tag `v0.5.0`)
Grana: `main` (jedina lokalna; `origin/main`, `truss/main`)
Kopija: `origin` → github.com/JoskoLatin/ulEditor, `truss` → git.truss:2222/josko/ulEditor.
Oba na `5223a01` (pushano 2026-09-22); **2 commita nisu pushana** — `cddfb16` i ovaj izvještaj.
Zadnji rad: **2026-09-23** — `cddfb16` "The total that follows the column, and
the one that admits it cannot".
Faza: **2 (Office)**, pri kraju — `docs/ANALYSIS-AND-PLAN.md:367`. Faza 3 (Web,
WASM) nije započeta (`docs/ANALYSIS-AND-PLAN.md:686`).

## Radi

- **Pogled na tablicu više ne laže.** Pretipkana ćelija sredi list pod sobom:
  `SUM` nad promijenjenim stupcem crta se s novim zbrojem u vlastitom formatu
  broja, a svaka formula koju program ne zna izračunati označi se kao zastarjela
  s objašnjenjem. 37 provjera, 11 namjerno pokvarenih verzija svaku od njih
  obori; 6,3 µs po formuli po uređivanju (`cddfb16`,
  `tools/verify-sheet-stale.mjs`).
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

- **Formula preko granice lista ne primjećuje promjenu.** `recalculate` dobiva
  jedan list, pa šest formula u korpusu koje drugi list zovu imenom ne
  zastarijevaju kad se taj list uredi (`cddfb16`).
- **`SUMIFS` preko strukturirane reference tablice uvijek se samo označi**, nikad
  izračuna — 35 ih je u jednom radnom listu, pa jedan pritisak tipke označi svih
  35. Izlaz je razriješiti `xl/tables/*.xml` (`docs/ANALYSIS-AND-PLAN.md:671`).
- **Installeri nisu potpisani** za Windows i macOS (`README.md:36`). Android APK
  jest. Ovo je kupnja certifikata, ne kod.
- **Cold start nije izmjeren** — `docs/ANALYSIS-AND-PLAN.md:770` ga zove
  „the last unmeasured budget".
- **Telemetrija nije započeta** (i ostaje opt-in) — `docs/ANALYSIS-AND-PLAN.md:228`.
- **`CLAUDE.md` u korijenu nije u gitu** — `git status` ga prijavljuje kao `??`.
  Ne znam je li to namjerno.

## Kartice

todo | visok | Razriješiti xl/tables/*.xml da se SUMIFS izračuna umjesto da se označi
  » 35 formula u jednom radnom listu, sad ih jedan pritisak tipke sve označi
todo | normalan | Proširiti recalculate na cijelu knjigu zbog formula preko lista
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
- Faza 2 je time zatvorena u kodu: pogled na tablicu više ne pokazuje broj koji
  je prestao biti točan. Ostaje `SUMIFS` preko tablica i formule preko granice
  lista; sve izvan repoa (potpisivanje installera) čeka kupnju certifikata.
