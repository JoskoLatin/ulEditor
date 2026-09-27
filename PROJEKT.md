# ulEditor — stanje projekta

Izvještaj od 2026-09-27. Zamjenjuje onaj od 2026-09-23; dopunjen nakon `9bc2548`.

## Jedna rečenica

Jedan otvoreni editor za sve formate — kod, Markdown, PDF, Word, Excel,
OpenDocument i e-knjige — kao Tauri desktop aplikacija s Rust jezgrom
(`crates/ul-*`) i TypeScript editorima (`packages/editor-*`).

## Verzija i faza

Verzija: **0.6.2** u kodu (`a43c1d7`, 2026-09-27). 0.6.1 nikad nije označen, pa
0.6.2 nosi i nju i ubrzanje preračuna — jedno izdanje umjesto dva. Tag `v0.6.2`
postavlja Joško. Zadnji objavljeni: `v0.6.0`.
Grana: `main` (jedina lokalna; `origin/main`, `truss/main`)
Kopija: `origin` → github.com/JoskoLatin/ulEditor, `truss` → git.truss:2222/josko/ulEditor.
Zadnji rad: **2026-09-27** — cold start izmjeren (474 ms), vremenski testovi
preračuna više ne ovise o brzini CI runnera.
Faza: **2 (Office)**, pri kraju — `docs/ANALYSIS-AND-PLAN.md:367`. Faza 3 (Web,
WASM) nije započeta (`docs/ANALYSIS-AND-PLAN.md:686`).

## Radi

- **Cold start je izmjeren** — zadnji neizmjereni budžet iz plana. Instalirana
  0.6.0, od pokretanja procesa do prvog iscrtavanja ljuske: **474 ms** medijan,
  603–807 ms pri prvom pokretanju s praznim profilom, 1 104 ms na jednoj jezgri;
  budžet je 1,5 s (`pnpm cold-start`, `tools/cold-start.mjs`,
  `docs/ANALYSIS-AND-PLAN.md:799`). Ne mjeri start nakon ponovnog pokretanja
  računala (prazan file cache).
- **Vremenski testovi preračuna više ne padaju na sporom runneru.** Test je
  dvaput srušio CI na kodu koji se nije mijenjao (101 ms naspram praga 100;
  macOS runner 221 ms). Sad se mjeri kako vrijeme raste s veličinom (osmina
  prema cijelom: sadašnji kod 8–13×, stari kvadratni 22–58×), što vrijedi na
  svakom stroju (`d0c2fb1`, `b6517bd`); CI zelen na sva tri runnera.

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

- **`SUMIFS` i `COUNTIFS` se izračunavaju** (2026-09-26, `fb48e6c`) po pravilima
  izmjerenima u samom Excelu (34 slučaja, `pnpm verify:formula-excel`). Na
  stvarnom cashless izvještaju daju 0, isto kao Excel, jer podaci pišu
  `G - gotovina` (crtica), a formule traže `G – gotovina` (duga crtica); s
  istom crticom redak za gotovinu bio bi 36.047,20 € (5416 transakcija).
  To je greška u Excel datoteci, ne u programu.
- **Sigurnosni pregled** (dva kruga, `fc44088`, `2cb6c87`) našao je i
  popravio grešku iz 0.6.0: zbroj koji čita međuzbroj i nešto izračunato iz
  njega prikazivao je krivi broj kao točan. Uz to tri načina da datoteka
  smrzne editor i desetak slučajeva u kojima se promjena ne primijeti.
- **Zbroj je preskakao brojeve s točkom za tisućice** (`1.000,00`) — i to je
  bilo u 0.6.0, popravljeno u `64641e9`.
- Onih „šest formula koje drugi list zovu imenom" zapravo su na `Cashless` i
  zovu **vlastiti** list; pet `SUM`-ova se sad izračunava, sedam `SUBTOTAL`-a
  i sličnih se označi.
- **Installeri nisu potpisani** za Windows i macOS (`README.md:36`). Android APK
  jest. Ovo je kupnja certifikata, ne kod.
- **Telemetrija nije započeta** (i ostaje opt-in) — `docs/ANALYSIS-AND-PLAN.md:228`.
- ~~`CLAUDE.md` u korijenu nije u gitu~~ — riješeno (`af59b5d`): namjerno je
  izvan gita, i `CLAUDE.md` i `AGENTS.md` su u `.gitignore`, jer opisuju wiki i
  lokalnu infrastrukturu, a `origin` je javan.

## Kartice

gotovo | visok | Proširiti recalculate s jednog lista na cijelu radnu knjigu
gotovo | normalan | Izračunati SUMIFS/COUNTIFS nad tablicom (35 u stvarnoj knjizi)
ceka | visok | Izdati 0.6.2 — čeka Joškov tag: `a43c1d7` (0.6.1 + ubrzanje) ili HEAD (uz to faza 3 i nove granice slika, koje diraju i desktop)
gotovo | nizak | Ubrzati preračun nakon masovne promjene — 511 ms → 10 ms, 20k teških formula 62,8 s → 479 ms (`d4e40ba`, ulazi u 0.6.2)
gotovo | normalan | Izmjeriti cold start i zapisati budžet u plan — 474 ms naspram 1,5 s (`d6a0c99`)
ceka | normalan | Kupiti certifikat za potpisivanje Windows i macOS installera
gotovo | nizak | Odlučiti ide li korijenski CLAUDE.md u git ili u .gitignore — u .gitignore
gotovo | normalan | Potvrditi ADR 0002 (faza 3: ul-image/ul-formats u WASM, ne ul-core; backend kasnije) — prihvaćen 2026-09-27
gotovo | normalan | Faza 3, korak 2 — Tauri API samo kroz host/native.ts, web bundle ga više ne učitava (`8e98feb`, `pnpm verify:host`, CI zelen)
gotovo | normalan | Web: bez Library kartice u pregledniku, Ctrl+P lista otvorenu mapu, Quick Open rangira po imenu (`c3bbb80`)
gotovo | normalan | Faza 3, korak 3 — ul-image u WASM, 361 KB gzip, wasm-bindgen-cli 0.2.127 pinan iz Cargo.lock (`261fed8`)
gotovo | visok | Faza 3, korak 4 — uređivanje slika u pregledniku, u workeru (najdulji zastoj 67 ms na 12 MP); tri sigurnosna kruga: NE / NE / PROLAZI (`8e87389`, `e580185`, `9bc2548`)
gotovo | normalan | Faza 3, korak 5 — drukčije od ADR-a: TS i Rust detektor ostaju, CI paritet (70 369 datoteka, 0 razlika; nađen i popravljen off-by-one za WebP)
gotovo | normalan | Granica memorije za slike: 512 MiB, zadano u `image` crateu i koliko je desktop imao prije; TIFF 256 MiB, JPEG/WebP vršno do ~3×
todo | normalan | Faza 3, korak 6 — service worker, rad bez mreže (u repou)
ceka | normalan | Faza 3, korak 7 — deploy na server (compose, Caddy, CSP header) — čeka Joškovo da i cilj na serveru
todo | nizak | Faza 3, korak 8 — otvorena mapa preživi osvježavanje stranice (u repou)

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
  je prestao biti točan, a ne označava ni ono što nije dirano. Računa se cijela
  knjiga, i svi budžeti iz plana su izmjereni i ispunjeni (cold start 474 ms od
  1,5 s). Izvan repoa čekaju tag za 0.6.2 i kupnja certifikata; sljedeće u kodu
  je faza 3 (Web, WASM).
