# ulEditor

> Jedan open-source editor za sve formate — kod, Markdown, PDF, Word, Excel — na jednom mjestu.

**Status:** faza 0 završena, faza 1 na okupu. Desktop se pokreće, sedam editora radi, e-knjige i Office dokumenti se čitaju.

## Teza

Ne postoji editor koji ozbiljno radi i s kodom i s Office dokumentima i s PDF-om. VS Code nema Office. LibreOffice nema code editor. Acrobat radi samo PDF. ulEditor popunjava tu prazninu — **ne pisanjem vlastitih engine-a, nego kao shell koji orkestrira postojeće zrele projekte** iza jedinstvenog UX-a, zajedničkog searcha i cross-format clipboarda.

## Stanje formata

| Format | Stanje | Engine |
|---|---|---|
| Kod, tekst (13 jezika) | **radi** | CodeMirror 6 |
| Markdown | **radi** — izvor + živi pregled + način čitanja | CodeMirror 6 + markdown-it |
| **EPUB** | **radi** — poglavlja, stranice, sadržaj, pamćenje mjesta | vlastiti čitač (fflate + DOMPurify) |
| PDF | **radi** — pregled, zoom, tekstualni sloj, pretraga, čitanje | pdf.js *(desktop → pdfium, faza 1)* |
| PDF anotacije | **radi** — istaknuća, bilješke, crtanje | pdf-lib |
| PDF stranice | **radi** — rotiranje, brisanje, preslagivanje, spajanje, izdvajanje | pdf-lib |
| **DOCX** | **radi — pregled** (naslovi, formatiranje, liste, tablice, slike) | vlastiti čitač *(uređivanje → ProseMirror, faza 2)* |
| **XLSX** | **radi — pregled** (listovi, formati, formule, spojene ćelije) | vlastiti čitač *(uređivanje → Univer, faza 2)* |
| Slike | **radi** — pregled, zoom, prozirnost | *(uređivanje → image-rs, faza 1)* |
| ODF, konverzije | faza 2 | LibreOffice headless |
| PPTX | faza 5 | Univer Slides |

Formati koji još nemaju editor otvaraju se s **jasnim objašnjenjem što nedostaje i kada stiže**, ne s praznim ekranom.

Anotacije se zapisuju kao **pravi PDF objekti** (`/Highlight`, `/Text`, `/Ink`), ne kao crtež utisnut u stranicu — Acrobat i ostali čitači ih otvaraju, uređuju i brišu kao svoje. Anotacije koje su već u datoteci se učitavaju i prikazuju.

Operacije nad stranicama ne mijenjaju dokument dok se ne spremi — do tada postoji samo *plan*. Rotiranje i brisanje rade na izvorniku bez gubitka; preslagivanje zahtijeva presnimavanje stranica, pa se gubitak oznaka i obrazaca **prijavljuje prije spremanja** umjesto da se tiho dogodi.

Word i Excel se za sada **samo čitaju**, i to piše na samom dokumentu. Uređivanje bez fidelity harnessa znači tiho gubljenje tuđeg formatiranja, pa ovi editori nemaju sposobnost `edit` — umjesto da je imaju i javljaju grešku pri spremanju. Sve što pregled ne prikazuje (zaglavlja, fusnote, komentari, grafikoni) navedeno je u traci iznad dokumenta.

## Način čitanja

`Ctrl+Shift+R` skriva cijeli okvir programa i ostavlja samo tekst.

- **Stranice ili svitak.** Stranice se dobivaju CSS stupcima, pa preglednik sam pazi da ne razdvoji naslov od odlomka. Listanje: razmaknica, strelice, klik uz rub.
- **Tipografija:** serifno/bezserifno pismo, veličina, prored, širina stupca u znakovima.
- **Podloga:** dnevno, sepija, noć — neovisno o temi aplikacije, jer se knjiga čita satima. Kod PDF-a "noć" invertira prikaz stranice.
- **Sadržaj** iz knjige (EPUB nav/NCX), naslova (Markdown, Word) ili oznaka dokumenta (PDF).
- **Napredak i procjena preostalog vremena**, po broju riječi a ne po broju poglavlja.
- **Mjesto na kojem si stao** se pamti po dokumentu i preživi zatvaranje.

Sve to ide kroz `EditorInstance.beginReading()` u plugin ugovoru: editor kaže što je kod njega "stranica" i "poglavlje", a čitaonicu piše shell — jednom, za sve formate.

**Pretraga (`Ctrl+Shift+F`) radi jednako nad svim formatima** — jedna ploča, isti rezultati, bilo da je otvoren kod, Markdown, PDF, e-knjiga, Word ili Excel. To dolazi iz `EditorInstance.find()` u plugin ugovoru, bez ijedne linije koda specifične za pojedini format.

Otvorene kartice i korijeni stabla se pamte i vraćaju pri sljedećem pokretanju (desktop).

## Brzi start

```bash
pnpm install

pnpm dev          # web verzija na http://localhost:5273
pnpm desktop      # Tauri desktop aplikacija

pnpm verify       # runtime provjera shella (traži pokrenut pnpm dev)
pnpm verify:reading   # čitaonica, EPUB, Word i Excel pregled
pnpm verify:pdf       # anotacije i operacije nad stranicama (bez preglednika)
pnpm verify:all       # sve gore
```

Preduvjeti: Node 20+, pnpm 11+, Rust stable, a na Windowsu Visual Studio Build Tools i WebView2.

## Arhitektura

```
shell-ui (React)  →  plugin-sdk  →  editori (code · markdown · book · office · pdf · image)
                          ↓            ↑
                          ↓        reader-core (listanje dugog teksta)
                          ↓
                       ul-ffi
                          ↓
              ul-core / ul-formats  (Rust)
                          ↓
        native lib · WASM · mobile lib
```

Rust jezgra se kompajlira za sva tri targeta. Desktop dobiva VFS sa sandboxom po korijenu radnog prostora i atomarnim spremanjem; web dobiva File System Access API. **Editori razliku ne vide** — ovise samo o `@uleditor/plugin-sdk`.

Dodavanje formata znači napisati provider i registrirati ga u [main.tsx](packages/shell-ui/src/main.tsx). Shell se ne mijenja.

## Struktura

| Putanja | Sadržaj |
|---|---|
| [packages/plugin-sdk/](packages/plugin-sdk/) | Javni ugovor između shella i editora. Semver od v0.1 |
| [packages/shell-ui/](packages/shell-ui/) | Tabovi, explorer, paleta naredbi, teme, host usluge |
| [packages/editor-*/](packages/) | Po jedan editor po formatu |
| [crates/ul-formats/](crates/ul-formats/) | Detekcija formata po sadržaju. Gradi se i za WASM |
| [crates/ul-core/](crates/ul-core/) | VFS sa sandboxom |
| [apps/desktop/](apps/desktop/) | Tauri v2 ljuska |
| [packages/reader-core/](packages/reader-core/) | Zajednički motor listanja i čitaonička tipografija |
| [tools/verify-ui.mjs](tools/verify-ui.mjs) | Runtime provjera shella kroz Chromium |
| [tools/verify-reading.mjs](tools/verify-reading.mjs) | Runtime provjera čitaonice i Office pregleda |

## Licenca

Core i svi prvoklasni editori: **Apache-2.0** ([LICENSE](LICENSE)).

Copyleft engine-i (MuPDF, ONLYOFFICE, HyperFormula) — ako ikad zatrebaju — idu u `plugins/` kao odvojeni opt-in paketi s vlastitom licencom, nikad u core. [deny.toml](deny.toml) to provodi u CI-u.

## Dokumentacija

- [Analiza i plan](docs/ANALIZA-I-PLAN.md) — arhitektura, izbor biblioteka, roadmap, rizici
- [ADR 0001: izbor runtimea](docs/adr/0001-runtime.md) — rezultati faze 0 i go/no-go odluka
- [Prompt za fazu 0](docs/PROMPT-FAZA-0.md)
