# ulEditor — analiza, arhitektura i plan

Cilj: jedan open-source editor koji na jednom mjestu otvara i **uređuje** kod, Markdown, PDF, Word (DOCX), Excel (XLSX) i kasnije PowerPoint — prvo desktop, zatim web, pa mobile.

## Temeljne odluke

| Odluka | Izbor | Zašto |
|---|---|---|
| Runtime | **Tauri v2** + Rust core + TypeScript UI | Jedini stack koji pokriva desktop + web + mobile iz jednog codebasea. Build ~10–15 MB naspram ~150 MB Electrona |
| Office strategija | **Hibrid**: Univer / ProseMirror native + LibreOffice headless kao fidelity sloj | Licencno čisto, radi svugdje, s definiranim fallbackom kad fidelity nije dovoljna |
| Licenca | **Apache-2.0** core, copyleft engine-i kao opt-in plugini | Maksimalna fleksibilnost, ne odbija korporativne doprinositelje |
| MVP | **Kod + Markdown + PDF** | Upotrebljivo za 4 mjeseca; dokazuje arhitekturu prije ulaska u OOXML |

---

## 1. Što je ovdje stvarno teško

Razlog zašto ovakav editor ne postoji nije nedostatak ideje, nego to što je **svaki format zaseban engine od 5–15 godina rada**:

- **OOXML** (ECMA-376) je specifikacija od ~6000 stranica. LibreOffice na njoj radi 25 godina i još uvijek gubi formatiranje na složenim dokumentima.
- **PDF nema reflow.** Tekst je skup pozicioniranih glifova, ne rečenica. "Uredi tekst u PDF-u" je fundamentalno drukčiji problem od uređivanja Worda i nikad ne radi savršeno.
- **Formule i proračunski graf** u Excelu su vlastiti interpreter s ~500 funkcija, ovisnostima, iterativnim izračunom i array formulama.

**Zaključak koji oblikuje cijelu arhitekturu:** ulEditor **ne smije pisati engine-e**. On je **shell koji ih orkestrira** — jedinstveni UX, jedinstveni file model, jedinstveni clipboard, jedinstveni search — dok teško dizanje rade postojeći zreli projekti. Vrijednost proizvoda je u *integraciji i konzistentnom iskustvu*, ne u parsiranju XML-a.

Iz toga slijedi da je **plugin contract najvažniji artefakt projekta**, važniji od bilo kojeg pojedinog editora. Ako je ugovor dobar, formati se dodaju paralelno i od strane doprinositelja. Ako je loš, projekt se guši na trećem formatu.

### Konkurencija i praznina

| Rješenje | Što mu fali |
|---|---|
| VS Code | Nema Office ni pravo PDF uređivanje |
| LibreOffice | Nema ozbiljan code editor, zastario UX, nema web/mobile |
| ONLYOFFICE | Office da, kod ne, AGPL, težak runtime |
| Obsidian / Typora | Samo Markdown |
| Adobe Acrobat | Samo PDF, zatvoren, skup |

Prazan prostor: **jedan konzistentan, brz, open-source shell preko svih formata, s cross-format clipboardom i zajedničkim searchom.**

---

## 2. Arhitektura

```
┌───────────────────────────────────────────────────────┐
│  SHELL UI  (TypeScript + React + Vite)                │
│  tabovi · split view · explorer · command palette      │
│  teme · postavke · sesija · notifikacije               │
└───────────────────────────────────────────────────────┘
                          ▲
                 plugin-sdk (javni ugovor)
                          ▼
┌───────────────────────────────────────────────────────┐
│  EDITOR PLUGINI  (svaki implementira EditorProvider)  │
│  code · markdown · pdf · sheet · doc · image           │
└───────────────────────────────────────────────────────┘
                          ▲
                 ul-ffi (Tauri commands / wasm-bindgen)
                          ▼
┌───────────────────────────────────────────────────────┐
│  CORE  (Rust)                                          │
│  VFS · format detekcija · plugin host · index (tantivy)│
│  konverzija (LibreOffice headless) · FFI: pdfium, qpdf │
└───────────────────────────────────────────────────────┘
        │                    │                    │
   native lib            WASM build          mobile lib
   (desktop)             (web)               (iOS/Android)
```

**Zašto Rust core:** isti kod se kompajlira u tri targeta. Bez toga svaki target zahtijeva reimplementaciju VFS-a, detekcije formata i indeksiranja. To je jedini razlog zbog kojeg je Tauri izabran umjesto Electrona.

### Plugin contract

Skica; finalizira se u fazi 1 i od tada ide pod semver.

```ts
interface EditorProvider {
  id: string;                       // "org.uleditor.pdf"
  displayName: string;
  matches: {
    extensions: string[];
    mimeTypes?: string[];
    magic?: Uint8Array[];           // detekcija po sadržaju, ne samo ekstenziji
  };
  capabilities: Capability[];       // 'view'|'edit'|'annotate'|'export'|'search'|'collab'
  priority: number;                 // više providera na isti format → korisnik bira
  createInstance(host: EditorHost, doc: DocumentHandle): Promise<EditorInstance>;
}

interface EditorInstance {
  mount(el: HTMLElement): void;
  unmount(): void;
  isDirty(): boolean;
  save(target?: SaveTarget): Promise<SaveResult>;
  undo(): void;  redo(): void;
  find(q: FindQuery): Promise<FindResult[]>;
  copySelection(): Promise<ClipboardPayload>;   // ← cross-format most
  paste(payload: ClipboardPayload): Promise<boolean>;
  onDirtyChange: Event<boolean>;
}

interface EditorHost {
  fs: VirtualFileSystem;            // preko Rust corea, isti API na sva 3 targeta
  commands: CommandRegistry;        // registracija u command palette
  convert: ConversionService;       // LibreOffice headless
  theme: ThemeService;
  settings: SettingsService;
  notify: NotificationService;
}
```

**`ClipboardPayload` s više reprezentacija** (`text/plain`, `text/html`, `application/x-uleditor-table`, `image/png`) omogućuje da kopiraš raspon iz Excela i zalijepiš ga kao pravu tablicu u Word dokument — funkcionalnost koju nitko od konkurencije nema preko formata.

---

## 3. Izbor biblioteka

Sve provjeravati `cargo-deny` / `license-checker` u CI-u — licence se mijenjaju.

| Format | Render | I/O + edit | Licenca | Faza |
|---|---|---|---|---|
| Kod / tekst | CodeMirror 6 | CodeMirror 6 + tree-sitter + LSP klijent | MIT | 1 |
| Markdown | CodeMirror 6 + preview | isto | MIT | 1 |
| PDF | `pdfium-render` (desktop/mobile), PDF.js (web) | `lopdf`, qpdf, pdf-lib | BSD-3 / Apache-2.0 / MIT | 1 |
| Slike | `image-rs` | crop / rotate / basic | MIT | 1 |
| XLSX | **Univer** | Univer + `calamine` (read) / `rust_xlsxwriter` (write) | Apache-2.0 / MIT | 2 |
| DOCX | ProseMirror | `docx-rs`, mapiranje na OOXML podskup | MIT | 2 |
| ODF / konverzije | LibreOffice `--headless` | `soffice` CLI orkestracija iz Rusta | MPL-2.0 | 2 |
| PPTX | Univer Slides | — | Apache-2.0 | 5 |
| OCR | — | OCRmyPDF / Tesseract | MPL-2.0 / Apache-2.0 | 5 |

**CodeMirror 6 umjesto Monaca** je namjeran trade-off: gubi se dio VS Code pariteta, ali dobiva pristojan rad na mobilnom webview-u. Monaco na mobilnom praktički ne radi, a mobile je deklarirani target.

**Namjerno izbjegnuto zbog licence:** MuPDF (AGPL), ONLYOFFICE (AGPL), HyperFormula (GPL-3.0), Handsontable (komercijalna). Ako zatrebaju — idu u `plugins/` kao opt-in paketi s vlastitom licencom, ne u core.

---

## 4. Struktura repozitorija

pnpm workspaces + cargo workspace u istom monorepou.

```
ulEditor/
├─ apps/
│  ├─ desktop/              # Tauri v2 — Windows/macOS/Linux
│  ├─ web/                  # Vite SPA, core-rs kao WASM       (faza 3)
│  └─ mobile/               # Tauri v2 iOS/Android             (faza 4)
├─ crates/
│  ├─ ul-core/              # VFS, dokument registry, plugin host, event bus
│  ├─ ul-formats/           # FormatCodec trait + detekcija po magic bytes
│  ├─ ul-convert/           # LibreOffice headless orkestracija (faza 2)
│  ├─ ul-index/             # full-text search (tantivy)
│  └─ ul-ffi/               # Tauri commands + wasm-bindgen export
├─ packages/
│  ├─ plugin-sdk/           # TS tipovi + host API — JAVNI UGOVOR, semver
│  ├─ shell-ui/             # tabovi, explorer, command palette, teme
│  ├─ editor-code/
│  ├─ editor-markdown/
│  ├─ editor-pdf/
│  ├─ editor-image/
│  ├─ editor-sheet/         # Univer                            (faza 2)
│  └─ editor-doc/           # ProseMirror                       (faza 2)
├─ plugins/                 # opcionalni, druge licence, opt-in
├─ tools/
│  └─ fidelity-harness/     # korpus dokumenata + round-trip pixel diff
└─ docs/
   ├─ ARCHITECTURE.md
   ├─ PLUGIN-API.md
   └─ adr/                  # jedan ADR po značajnoj odluci
```

---

## 5. Roadmap

### Faza 0 — Spike / go-no-go (3–4 tjedna)

Ne piše se arhitektura dok se ne dokažu rizične pretpostavke. Pet spike-ova, svaki throwaway:

1. Tauri v2 desktop build prolazi na Windows + macOS + Linux
2. **Tauri v2 Android build se pokreće na uređaju** ← kritični go/no-go za cijeli izbor stacka
3. `ul-core` skeleton se kompajlira u WASM i poziva iz browsera
4. `pdfium-render` renderira PDF stranicu u Tauri prozoru
5. CodeMirror 6 montiran u shellu, otvara i sprema datoteku preko Rust VFS-a

**Ako #2 padne:** fallback na Electron za desktop + zasebna React Native mobilna aplikacija koja dijeli samo `plugin-sdk` tipove. Odluku donijeti u fazi 0, ne u fazi 4.

Izlaz: `docs/adr/0001-runtime.md` s go/no-go odlukom.

### Faza 1 — MVP desktop (mjeseci 1–4)

Stanje na dan 15. 8. 2026.

| Stavka | Stanje |
|---|---|
| Shell: tabovi, explorer, paleta (`Ctrl+Shift+P`), postavke, teme | **gotovo** |
| Obnova sesije (kartice + korijeni stabla) | **gotovo** (desktop) |
| `plugin-sdk` v0.1 + registry + lijeno učitavanje editora | **gotovo** |
| `editor-code`: CodeMirror 6, bojanje sintakse, find/replace | **gotovo** |
| `editor-markdown`: izvor + živi pregled | **gotovo** |
| `editor-pdf`: render, tekstualni sloj, anotacije, stranice (rotate / delete / reorder / merge / split) | **gotovo** |
| **Read-only pregled DOCX i XLSX** | **gotovo** |
| **EPUB čitač + način čitanja** (nije bio u izvornom planu) | **gotovo** |
| Split view | odgođeno — dvije kartice jedna uz drugu, bez novih ugovora |
| `editor-code`: tree-sitter, LSP klijent | odgođeno u fazu 1.1 |
| `editor-markdown`: mermaid | odgođeno u fazu 1.1 |
| Globalni search preko `tantivy` | odgođeno u fazu 1.1 |
| Auto-update, crash reporting, opt-in telemetrija | traži potpisivanje i backend; ide uz sam release |
| `editor-pdf` na pdfiumu umjesto pdf.js-a | odgođeno — pdf.js zadovoljava, zamjena je optimizacija |

**Način čitanja nije bio u planu, a ušao je u ugovor.** Pokazao se kao stavka koja
najbolje brani cijelu tezu projekta: `EditorInstance.beginReading()` znači da
jedna čitaonica u shellu opslužuje EPUB, PDF, Markdown i Word, a svaki od njih
sam definira što je kod njega "stranica" i "poglavlje". Isto što je pretraga
dokazala za `find()`.

**Zašto su LSP i tantivy odgođeni:** oboje su velika, zasebna infrastruktura
(vanjski procesi, indeks na disku, invalidacija) koja ne mijenja tezu projekta.
Pregled Office dokumenata je mijenja, pa je imao prednost.

Izlaz: **v0.1** — potpisani instaleri za Windows, macOS, Linux. Javni release radi privlačenja doprinositelja.

### Faza 2 — Office (mjeseci 4–10)

Najveći rizik projekta, zato ide tek kad shell stoji i kad postoje doprinositelji.

- `editor-sheet`: Univer integracija, XLSX I/O, formule, formatiranje ćelija, osnovni grafikoni, virtualizacija na 100k+ redaka
- `editor-doc`: ProseMirror shema mapirana na OOXML podskup — paragrafi, stilovi, liste, tablice, slike, header/footer, komentari
- `ul-convert`: LibreOffice headless — DOCX ↔ PDF ↔ ODF ↔ HTML, batch konverzija
- **Fidelity harness (kritično, gradi se prvi dan faze 2):** korpus od 500+ realnih dokumenata; svaki se otvori → spremi → renderira u PDF → pixel-diff s originalom. Bez ovoga nemaš pojma gubiš li formatiranje.
- **"Fidelity mode":** ako dokument koristi nepodržanu značajku, otvara se **read-only preko LibreOffice rendera uz jasno upozorenje** — nikad se ne sprema tiho pokvarena verzija. Ovo je najvažnije pravilo cijelog projekta; tiho gubljenje korisnikovog formatiranja trajno ubija povjerenje.
- Cross-format clipboard

Izlaz: **v0.5**

### Faza 3 — Web (mjeseci 10–14)

- `ul-core` → WASM; File System Access API + drag & drop; OPFS za lokalni cache
- PDF.js umjesto pdfiuma na webu
- Opcionalni self-hosted backend (Docker) za teške konverzije — LibreOffice ne ide u WASM
- PWA, offline rad

Izlaz: hostana instanca + `docker-compose` za self-host

### Faza 4 — Mobile (mjeseci 14–20)

- Tauri v2 iOS/Android
- **Touch-first UI, ne port desktopa:** gesture navigacija, kontekstni toolbar umjesto menija, upravljanje virtualnom tipkovnicom
- Namjerno reduciran scope: kod, Markdown, PDF (pregled + anotacije + potpis), XLSX pregled + osnovni edit, DOCX pregled
- Share sheet, integracija s Files / iCloud / Drive

### Faza 5 — Ekosistem (20+)

Plugin marketplace sa WASM sandboxom · realtime kolaboracija (Loro CRDT, Rust-native, MIT) · AI sloj kao plugin, nikad u coreu (lokalni Ollama + API) · PPTX · track changes · PAdES potpisi · OCR

---

## 6. Rizici

| Rizik | Ozbiljnost | Mitigacija |
|---|---|---|
| OOXML fidelity — tiho kvarenje dokumenata | Kritična | Fidelity harness od prvog dana faze 2; read-only fallback; nikad tiho spremanje uz gubitak |
| Scope explosion | Kritična | Sve iznad faze 1 je plugin, ne core. Strogi `plugin-sdk` semver |
| Tauri Android build ne radi | Visoka | Dokazuje se u fazi 0, ne u fazi 4. Definiran Electron fallback |
| WebKitGTK (Linux) se ponaša drukčije | Srednja | CI matrica sa sva tri webview-a od faze 0 |
| Memorija mobilnog webview-a na velikim PDF-ovima | Srednja | Streaming render iz Rusta; nikad cijeli dokument u JS heapu |
| Solo dev burnout | Visoka | Upotrebljiv v0.1 za 4 mjeseca; rani javni release radi doprinositelja |
| Licenca ovisnosti se promijeni | Niska | `cargo-deny` + `license-checker` blokiraju CI; ADR po ovisnosti |

---

## 7. Verifikacija

**CI na svaki PR:**

```
cargo test && cargo clippy -- -D warnings && cargo deny check
pnpm test          # vitest — unit
pnpm e2e           # Playwright preko Tauri WebDriver
pnpm fidelity      # round-trip pixel diff, prag < 2% razlike  (od faze 2)
```

**Matrica:** Windows / macOS / Linux × (desktop, web). Android + iOS build od faze 0.

**Perf budžeti** (mjere se u CI-u, PR pada ako se prekorače):

- cold start < 1.5 s
- otvaranje PDF-a od 10 MB < 800 ms do prve stranice
- scroll kroz XLSX od 100k redaka na 60 fps
- desktop instaler < 40 MB

**Ručna verifikacija na kraju faze 1:**

1. `pnpm tauri dev` — aplikacija se digne
2. Otvori repo direktorij → explorer prikazuje stablo
3. Otvori `.ts` datoteku → highlight, autocomplete, go-to-definition rade
4. Otvori PDF → scroll, selekcija teksta, dodaj highlight, obriši stranicu, spremi, provjeri u drugom čitaču
5. Otvori `.md` → live preview prati tipkanje
6. Otvori `.docx` i `.xlsx` → read-only preview se prikazuje
7. `Ctrl+Shift+P` → command palette pronalazi naredbe iz svih učitanih plugina
8. Zatvori i ponovo otvori → sesija obnovljena
9. Zapakiraj instaler, instaliraj na čist stroj, ponovi 1–8
