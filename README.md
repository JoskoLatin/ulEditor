# ulEditor

> Jedan open-source editor za sve formate — kod, Markdown, PDF, Word, Excel — na jednom mjestu.

**Status:** faza 0 završena, faza 1 na okupu. Desktop se pokreće, sedam editora radi, e-knjige i Office dokumenti se čitaju. Sučelje je na engleskom, hrvatski se bira u postavkama.

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
| Slike | **radi** — pregled, zoom, prozirnost, **OCR** | Tesseract (wasm) *(uređivanje → image-rs, faza 1)* |
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

## Pretraga po projektu

`Ctrl+Shift+H` traži kroz cijeli radni prostor. Skeniranje se odvija u Rustu —
sadržaj datoteka ne prelazi preko IPC-a, gore ide upit, natrag samo pogoci.

Uz kvačicu **„Traži i unutar PDF-a, Worda, Excela i e-knjiga"** ide drugi
prolaz: dokumenti se otvaraju **istim parserima koje editori koriste za
prikaz**, pa rečenica iz ugovora u PDF-u stigne u istu listu kao pogodak iz
koda. Pogodak u tablici nosi adresu ćelije (`Promet!B4`), u PDF-u broj
stranice, u knjizi naslov poglavlja. To je razlika prema `grep`-u i prema
svakom editoru koda.

Drugi prolaz je skuplji, pa se bira, ne pretpostavlja.

**Zašto skeniranje, a ne `tantivy`.** Indeks se isplati kad je korpus velik i
upiti česti, ali donosi problem bez rješenja na pola puta: invalidaciju.
`git checkout` koji promijeni tisuću datoteka, izmjena izvan programa, mapa
dodana pa maknuta — svaki od tih slučajeva mora ažurirati indeks, inače
pretraga tiho laže. Skeniranje ne može zastarjeti jer stanja ni nema. Indeks
postaje opravdan tek kad odgovor prestane biti trenutan.

`Ctrl+P` otvara datoteku po imenu. Popis dolazi iz Rusta, ne iz stabla: stablo
se učitava lijeno, pa bi datoteka u nerazgranatoj mapi bila nevidljiva — a
upravo se nju najčešće traži.

**Pretraga u dokumentu (`Ctrl+Shift+F`) radi jednako nad svim formatima** — jedna ploča, isti rezultati, bilo da je otvoren kod, Markdown, PDF, e-knjiga, Word ili Excel. To dolazi iz `EditorInstance.find()` u plugin ugovoru, bez ijedne linije koda specifične za pojedini format.

Otvorene kartice i korijeni stabla se pamte i vraćaju pri sljedećem pokretanju (desktop).

## Prepoznavanje teksta sa slike (OCR)

Gumb **OCR** u pregledniku slika pročita tekst i otvori ga u **ploči ispod** —
vodoravnom splitu koji ostaje uz sliku, pa se prepoznato može odmah usporediti
s originalom.

Ploča nije obična kartica: taj tekst nema datoteku na disku, pa u njezinoj traci
stoji **izbor formata u koji se sprema** — `.txt`, `.md`, `.docx` ili `.pdf`.
DOCX i PDF se sastavljaju u programu, bez vanjskog alata. PDF koristi ugrađeni
font bez hrvatskih dijakritika, pa se to prijavljuje **prije** spremanja, po
istom pravilu po kojem se prijavljuje svaki drugi gubitak.

Jezik prepoznavanja (hrvatski / engleski) bira se uz gumb, jer ista slika zna
imati oba. Bez hrvatskog modela `č ć ž š đ` završe kao `c z s`.

**OCR radi bez mreže.** Tesseract po zadanom vuče worker, wasm jezgru i jezične
modele s CDN-a; ovdje se sve poslužuje iz same aplikacije (`tools/ocr-assets.mjs`
ih kopira iz `node_modules`, ~11 MB). Razlog nije udobnost nego dvije stvari
koje projekt namjerno ima: CSP desktop verzije dopušta samo `'self'`, a editor
koji traži internet da bi pročitao tekst sa slike nije alat nego demo.

## Jezik sučelja

Zadano je **engleski**, hrvatski se bira u postavkama (`Ctrl+,`). Promjena
ponovno učita prozor: PDF, knjiga i Office pregled grade DOM izravno, pa bi
zamjena nizova u letu tražila demontažu svakog otvorenog dokumenta — a sesija
se ionako vraća pri pokretanju.

Prijevodi su ključevani **engleskim izvornim tekstom**, ne apstraktnim
oznakama. Neprevedeni niz zato pada natrag na čitljiv engleski umjesto na
`shell.tab.close.tooltip`.

## Brzi start

```bash
pnpm install

pnpm dev          # web verzija na http://localhost:5273
pnpm desktop      # Tauri desktop aplikacija

pnpm verify           # runtime provjera shella (traži pokrenut pnpm dev)
pnpm verify:reading   # čitaonica, EPUB, Word i Excel pregled
pnpm verify:ocr       # OCR, ploča ispod, promjena jezika sučelja
pnpm verify:export    # izvoz teksta u txt / md / docx / pdf
pnpm verify:pdf       # anotacije i operacije nad stranicama (bez preglednika)
pnpm verify:all       # sve gore — 180 provjera

pnpm verify:search    # pretraga po projektu, u PRAVOJ desktop aplikaciji
```

`verify:search` diže sam program s otvorenim WebView2 debug portom i spaja se
na njega preko CDP-a. Pretraga živi u Rustu i dostupna je samo kroz Tauri
naredbu, pa bi provjera u pregledniku testirala ljepilo umjesto posla.

`verify:ocr` pri prvom pokretanju preuzima jezični model; bez mreže se
prijavljuje kao preskočen, ne kao prolaz.

Preduvjeti: Node 20+, pnpm 11+, Rust stable, a na Windowsu Visual Studio Build Tools i WebView2.

## Arhitektura

```
shell-ui (React)  →  plugin-sdk  →  editori (code · markdown · book · office · pdf · image)
                          ↓            ↑
                          ↓        reader-core · i18n · text-export
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
| [crates/ul-core/](crates/ul-core/) | VFS sa sandboxom i pretraga po radnom prostoru |
| [apps/desktop/](apps/desktop/) | Tauri v2 ljuska |
| [packages/reader-core/](packages/reader-core/) | Zajednički motor listanja i čitaonička tipografija |
| [packages/i18n/](packages/i18n/) | Prijevodi sučelja; ključ je engleski izvornik |
| [packages/text-export/](packages/text-export/) | Tekst → txt / md / docx / pdf, bez vanjskog alata |
| [tools/verify-ui.mjs](tools/verify-ui.mjs) | Runtime provjera shella kroz Chromium |
| [tools/verify-reading.mjs](tools/verify-reading.mjs) | Runtime provjera čitaonice i Office pregleda |

## Licenca

Core i svi prvoklasni editori: **Apache-2.0** ([LICENSE](LICENSE)).

Copyleft engine-i (MuPDF, ONLYOFFICE, HyperFormula) — ako ikad zatrebaju — idu u `plugins/` kao odvojeni opt-in paketi s vlastitom licencom, nikad u core. [deny.toml](deny.toml) to provodi u CI-u.

## Dokumentacija

- [Analiza i plan](docs/ANALIZA-I-PLAN.md) — arhitektura, izbor biblioteka, roadmap, rizici
- [ADR 0001: izbor runtimea](docs/adr/0001-runtime.md) — rezultati faze 0 i go/no-go odluka
- [Prompt za fazu 0](docs/PROMPT-FAZA-0.md)
