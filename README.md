# ulEditor

> Jedan open-source editor za sve formate — kod, Markdown, PDF, Word, Excel — na jednom mjestu.

**Status:** faza 0 završena, faza 1 u tijeku. Desktop se pokreće, tri editora rade.

## Teza

Ne postoji editor koji ozbiljno radi i s kodom i s Office dokumentima i s PDF-om. VS Code nema Office. LibreOffice nema code editor. Acrobat radi samo PDF. ulEditor popunjava tu prazninu — **ne pisanjem vlastitih engine-a, nego kao shell koji orkestrira postojeće zrele projekte** iza jedinstvenog UX-a, zajedničkog searcha i cross-format clipboarda.

## Stanje formata

| Format | Stanje | Engine |
|---|---|---|
| Kod, tekst (13 jezika) | **radi** | CodeMirror 6 |
| Markdown | **radi** — izvor + živi pregled | CodeMirror 6 + markdown-it |
| PDF | **radi** — pregled, zoom, tekstualni sloj, pretraga | pdf.js *(desktop → pdfium, faza 1)* |
| PDF anotacije, stranice | faza 1 | lopdf, qpdf |
| Slike | faza 1 | image-rs |
| XLSX | faza 2 | Univer |
| DOCX | faza 2 | ProseMirror + docx-rs |
| ODF, konverzije | faza 2 | LibreOffice headless |
| PPTX | faza 5 | Univer Slides |

Formati koji još nemaju editor otvaraju se s **jasnim objašnjenjem što nedostaje i kada stiže**, ne s praznim ekranom.

## Brzi start

```bash
pnpm install

pnpm dev          # web verzija na http://localhost:5273
pnpm desktop      # Tauri desktop aplikacija

pnpm verify       # runtime provjera pravim preglednikom (traži pokrenut pnpm dev)
```

Preduvjeti: Node 20+, pnpm 11+, Rust stable, a na Windowsu Visual Studio Build Tools i WebView2.

## Arhitektura

```
shell-ui (React)  →  plugin-sdk  →  editori (code · markdown · pdf)
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
| [tools/verify-ui.mjs](tools/verify-ui.mjs) | Runtime provjera kroz Chromium |

## Licenca

Core i svi prvoklasni editori: **Apache-2.0** ([LICENSE](LICENSE)).

Copyleft engine-i (MuPDF, ONLYOFFICE, HyperFormula) — ako ikad zatrebaju — idu u `plugins/` kao odvojeni opt-in paketi s vlastitom licencom, nikad u core. [deny.toml](deny.toml) to provodi u CI-u.

## Dokumentacija

- [Analiza i plan](docs/ANALIZA-I-PLAN.md) — arhitektura, izbor biblioteka, roadmap, rizici
- [ADR 0001: izbor runtimea](docs/adr/0001-runtime.md) — rezultati faze 0 i go/no-go odluka
- [Prompt za fazu 0](docs/PROMPT-FAZA-0.md)
