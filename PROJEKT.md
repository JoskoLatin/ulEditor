# ulEditor — stanje projekta

Izvještaj od 2026-09-23. Zamjenjuje onaj od 2026-09-22 (`e4881f6`); dopunjen nakon `be4b50e`.

## Jedna rečenica

Jedan otvoreni editor za sve formate — kod, Markdown, PDF, Word, Excel,
OpenDocument i e-knjige — kao Tauri desktop aplikacija s Rust jezgrom
(`crates/ul-*`) i TypeScript editorima (`packages/editor-*`).

## Verzija i faza

Verzija: **0.5.0** (`Cargo.toml:9`, `package.json:3`, tag `v0.5.0`)
Grana: `main` (jedina lokalna; `origin/main`, `truss/main`)
Kopija: `origin` → github.com/JoskoLatin/ulEditor, `truss` → git.truss:2222/josko/ulEditor.
Oba na `5223a01` (pushano 2026-09-22); **4 commita nisu pushana** — `cddfb16`, `be4b50e` i dva izvještaja.
Zadnji rad: **2026-09-23** — `be4b50e` "What PodaciTable[Iznos] stands for, and
the sheet it turned out to be on".
Faza: **2 (Office)**, pri kraju — `docs/ANALYSIS-AND-PLAN.md:367`. Faza 3 (Web,
WASM) nije započeta (`docs/ANALYSIS-AND-PLAN.md:686`).

## Radi

- **Pogled na tablicu više ne laže.** Pretipkana ćelija sredi list pod sobom:
  `SUM` nad promijenjenim stupcem crta se s novim zbrojem u vlastitom formatu
  broja, a svaka formula koju program ne zna izračunati označi se kao zastarjela
  s objašnjenjem. 37 provjera, 11 namjerno pokvarenih verzija svaku od njih
  obori; 6,3 µs po formuli po uređivanju (`cddfb16`,
  `tools/verify-sheet-stale.mjs`).
- **Strukturirana referenca na tablicu se razrješuje.** `xl/tables/*.xml` se
  čita, pa `PodaciTable[Iznos]` postane pravokutnik. Mjerenje je promijenilo
  zadatak: tablica je na listu `Podaci`, a svih 35 formula koje je čitaju na
  listu `Cashless` — pa se nijedna ne može izračunati, ali se ni ne označava
  krivo. Jedan pritisak tipke ondje je označavao **50 od 51** formule, sad
  nijednu (`be4b50e`).
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

- **`SUMIFS` i `COUNTIFS` se i dalje ne izračunavaju — ali se sad označe.**
  Preračun ide preko cijele radne knjige (`recalculateBook`, 2026-09-26): izmjena
  iznosa u tablici na listu `Podaci` označi kao zastarjele 25 od 51 formule na
  listu `Cashless` (17 izravnih čitača, 0 promašenih); prije nije označila
  nijednu. Izračunati ih je sljedeći korak, a list više nije prepreka.
- Onih „šest formula koje drugi list zovu imenom" zapravo su na `Cashless` i
  zovu **vlastiti** list; pet `SUM`-ova se sad izračunava, sedam `SUBTOTAL`-a
  i sličnih se označi.
- **Installeri nisu potpisani** za Windows i macOS (`README.md:36`). Android APK
  jest. Ovo je kupnja certifikata, ne kod.
- **Cold start nije izmjeren** — `docs/ANALYSIS-AND-PLAN.md:770` ga zove
  „the last unmeasured budget".
- **Telemetrija nije započeta** (i ostaje opt-in) — `docs/ANALYSIS-AND-PLAN.md:228`.
- **`CLAUDE.md` u korijenu nije u gitu** — `git status` ga prijavljuje kao `??`.
  Ne znam je li to namjerno.

## Kartice

gotovo | visok | Proširiti recalculate s jednog lista na cijelu radnu knjigu
todo | normalan | Izračunati SUMIFS/COUNTIFS nad tablicom (35 u stvarnoj knjizi)
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
  je prestao biti točan, a ne označava ni ono što nije dirano. Jedino što još
  stoji je da se računa list po list; sve izvan repoa (potpisivanje installera)
  čeka kupnju certifikata.
