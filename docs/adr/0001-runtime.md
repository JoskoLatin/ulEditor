# ADR 0001 — Izbor runtimea: Tauri v2

**Status:** prihvaćeno
**Datum:** 2026-08-15
**Kontekst:** faza 0 (spike / go-no-go), vidi [ANALIZA-I-PLAN.md](../ANALIZA-I-PLAN.md)

## Odluka

**Tauri v2 + Rust jezgra + TypeScript UI.** Nastavljamo prema planu; Electron fallback se ne aktivira.

## Zašto je odluka uopće bila otvorena

Cijeli projekt stoji na tvrdnji da jedan codebase može pokriti desktop, web i mobile. Ako to ne vrijedi, arhitektura se raspada na tri odvojene aplikacije i procjena od ~20 mjeseci više ne vrijedi. Faza 0 je postojala da se ta tvrdnja provjeri **prije** nego se na njoj sagradi shell.

## Rezultati spike-ova

Okruženje: Windows 11 Pro 26200, Rust 1.97.1 (MSVC), Node 26.1.0, pnpm 11.21.0, Visual Studio Build Tools 2026, WebView2 prisutan.

| # | Spike | Rezultat | Bilješka |
|---|---|---|---|
| 1 | Tauri v2 desktop build | **prošao** | Debug binary 12,8 MB, prozor se otvara, ~24 MB radne memorije u praznom hodu |
| 2 | Tauri v2 Android build | **prošao** | APK se gradi, instalira i vrti na fizičkom uređaju — vidi ispod |
| 3 | Rust jezgra → WASM | **prošao** | `ul-formats` se gradi za `wasm32-unknown-unknown`, 364 KB nekomprimirano prije `wasm-opt` |
| 4 | Render PDF-a | **prošao**, ali drukčije nego planirano | pdf.js umjesto pdfiuma — vidi ispod |
| 5 | CodeMirror 6 u shellu | **prošao** | Bojanje sintakse, 13 jezika lijeno učitanih |

Umjesto pet throwaway grana napravljen je odmah upotrebljiv shell, jer su prva četiri spike-a prošla bez otpora. To je odstupanje od plana i svjesno je: kod nije bačen.

### Odstupanje kod PDF-a

Plan je tražio `pdfium-render`. Umjesto toga je isporučen pdf.js s vlastitim tekstualnim slojem.

**Razlog:** pdf.js radi na sva tri targeta odmah i bez distribucije nativnog binarija, pa je faza 1 upotrebljiva ranije. pdfium ostaje planiran za desktop kad performanse na velikim dokumentima to zatraže — ugovor `EditorInstance` je isti, pa je zamjena lokalna promjena unutar `editor-pdf`.

**Cijena:** pdf.js je sporiji i troši više memorije na dokumentima od nekoliko stotina stranica. Mjeriti prije faze 4 (mobile), gdje je memorija webviewa realno ograničenje.

Tekstualni sloj je pisan ručno (~40 linija) umjesto korištenjem `TextLayer` klase iz pdf.js-a, jer se taj API mijenjao između većih verzija. Manje ovisnosti o tuđem nestabilnom sučelju.

## Android spike — izveden, prolazi

Kritični go/no-go iz plana je naknadno izveden i **prošao je na fizičkom uređaju**. Electron fallback se time trajno skida sa stola.

Okruženje: NDK 27.2.12479018, Gradle 8.14.3, target `aarch64-linux-android`. Uređaj: Xiaomi 2201117TY (Redmi Note 11), Android 13 / SDK 33, arm64-v8a, MIUI V816.

Što je dokazano:

- APK se gradi (`tauri android build --debug --apk --target aarch64`) i sadrži samo `lib/arm64-v8a`
- aplikacija se pokreće, `libuleditor_lib.so` se učitava, WebView 150.0.7871.181 renderira shell
- **sučelje je ugrađeno u binarij, ne poslužuje se s računala** — APK radi bez dev servera i bez mreže
- logcat je čist: nijedna greška, nijedan odbijen resurs, nijedno CSP kršenje

Time je tvrdnja „jedna jezgra, tri targeta” dokazana na sva tri, ne više na dva.

### Što je usput izašlo na vidjelo

**Windows traži elevaciju za symlink.** Tauri pri sastavljanju APK-a radi symbolic link na `libuleditor_lib.so`, a Windows to bez Developer Modea dopušta samo administratoru. Riješeno kroz [`tools/android-dev.ps1`](../../tools/android-dev.ps1), koji se pokreće elevirano; ništa se u sustavu ne mijenja, elevacija služi samo za taj symlink.

**MIUI blokira `adb install`.** Instalacija preko USB-a pada s `INSTALL_FAILED_USER_RESTRICTED`, a Xiaomi taj prekidač uvjetuje umetnutom SIM karticom. Bitno je da to **nije** Android restrikcija — `dumpsys user` prijavljuje `Effective restrictions: none`, a `install_non_market_apps` je `1`. Poruka dolazi iz Xiaomijevog zakrpanog package managera, pa se ne da isključiti nijednom `adb` postavkom; ni `pm install` izravno na uređaju ne prolazi. Sideload dodirom na APK ide drugim putem i radi bez ičega.

Posljedica za razvoj: dok u telefonu nema SIM-a, `tauri android dev` (automatska instalacija + hot reload) ne radi, a ne radi ni `adb shell input`, pa se provjere ne mogu voziti na uređaju kao na desktopu. Petlja je: sagradi APK → `adb push` → ručna instalacija. Za dokazivanje dovoljno, za svakodnevni rad na fazi 4 nije — tada treba SIM (bilo koji, i neaktivan) ili emulator.

### Raspored na telefonu

Prvo pokretanje je pokazalo shell u čistom desktop rasporedu: statusna traka sustava preko naslovne trake aplikacije, a bočna ploča fiksnih 264 px uz aktivnosnu traku od 48 px na ekranu širokom 392 px — glavnom području je ostalo **0 px** i opis se lomio na jednu riječ po retku.

Popravljeno u istom prolazu, jer je aplikacija inače neupotrebljiva za bilo kakvu daljnju provjeru na uređaju:

- umetci sigurnog područja (`env(safe-area-inset-*)` uz `viewport-fit=cover`); na ovom uređaju su 34 px gore i 48 px dolje
- ispod 720 px bočna ploča prelazi **preko** sadržaja umjesto da ga stišće, a hvatište za širinu nestaje
- s naslovne trake se miču naziv dokumenta i kratice tipkovnice

Dvije zamke koje su usput izašle i vrijedi ih zapamtiti: `position: absolute` i `display: none` vade element iz grid toka, pa auto-raspoređivanje pomakne sve iza njega — mjesta se **moraju** zadati izrijekom. I mjerenje širine nije dovoljno: glavno područje je u međukoraku imalo točnih 345 px, ali je stajalo u drugom redu, ispod aktivnosne trake. Provjera sada uspoređuje i gornje rubove.

Ovo **nije** touch redizajn iz faze 4 — nema gesta ni kontekstnog toolbara, a preklopna ploča se zatvara gumbom na aktivnosnoj traci, ne dodirom izvan nje.

Provjera: `pnpm verify:mobile` ([`tools/verify-mobile-layout.mjs`](../../tools/verify-mobile-layout.mjs)) vozi pravu aplikaciju na uređaju preko `adb forward` na devtools socket WebViewa.

### Dolazak do dokumenata na Androidu

Raspored je bio samo pola problema. Explorer sa stablom mapa je desktop metafora: pretpostavlja da korisnik zna gdje mu datoteka stoji. Na telefonu ne zna i nema razloga znati. Mobilni prikaz zato ne traži otvaranje mape nego sam pregleda uređaj — [`crates/ul-core/src/library.rs`](../../crates/ul-core/src/library.rs).

**Scoped storage to gotovo onemogući, i to tiho.** Izmjereno na uređaju: `adb` u `Download` vidi 60-ak dokumenata, aplikacija sedam mapa i **nijednu datoteku**. Bez dozvole za pohranu `read_dir` propušta samo direktorije i ne javlja grešku — naivna knjižnica bi tvrdila da dokumenata nema.

Odabrano: **`MANAGE_EXTERNAL_STORAGE`**. Time postojeći VFS, pretraga, prepoznavanje formata i OCR rade nad pravim datotekama bez ijedne promjene u jezgri. Cijena je jasna i zapisana ovdje: **Google Play tu dozvolu odobrava uglavnom upraviteljima datoteka**, pa je za Play potreban SAF (`ACTION_OPEN_DOCUMENT_TREE`) — a on daje `content://` URI-je koje `std::fs` ne otvara, dakle traži URI-aware sloj u `ul-core` i dira ugovor o dokumentu. To je posao faze 4, ne usputna izmjena.

Tri stvari koje je mjerenje na uređaju izvuklo, a nagađanje ne bi:

- **Fotografije progutaju popis.** Prvo mjerenje: 2000 stavki, od toga 1956 slika i 41 PDF, uz granicu koja je pukla usred skeniranja — dokumenti u kasnijim mapama nisu ni ušli. Slike sada imaju vlastitu kvotu (400) i režu se po vremenu, pa dokumenti ne mogu ispasti.
- **Uskraćen pristup se mora prijaviti.** `LibraryScan::looks_blocked` razlikuje prazan uređaj od skrivenog sadržaja (mape viđene, datoteke ne) i UI tada nudi uputu umjesto prazne liste.
- **Knjižnica ne smije širiti explorer.** Pregledane mape idu u zaseban `library_roots`: smiju se čitati, ali se ne pojavljuju u stablu — inače bi na desktopu jedan pogled u knjižnicu ubacio Documents, Downloads i Desktop među korisnikove otvorene mape.

Provjera: `pnpm verify:library` ([`tools/verify-mobile-library.mjs`](../../tools/verify-mobile-library.mjs)). Dozvolu namjerno oduzima preko `appops` i traži da aplikacija prizna zapreku umjesto da prikaže prazan popis.

**Dozvola se zasad uključuje ručno** (Postavke → Aplikacije → ulEditor → Dozvole → Pristup svim datotekama). Sustav je ne nudi kroz obični dijalog, a poziv na taj zaslon iz aplikacije traži Kotlin dio kojeg još nema — knjižnica zato prikazuje točnu putanju do postavke.

Veličina debug APK-a je 145 MB, od čega `libuleditor_lib.so` 137,9 MB — gotovo sve su debug simboli i ugrađeni OCR modeli. Release veličinu treba izmjeriti prije faze 4; budžet iz plana (`instaler < 40 MB`) je pisan za desktop i za mobile ga treba postaviti zasebno.

## Prepreka u okruženju: Smart App Control

Release build (`tauri build`) je na ovom stroju pao:

```
error: failed to run custom build command for `serde v1.0.229`
  An Application Control policy has blocked this file. (os error 4551)
```

Windows Smart App Control je u enforcement načinu i blokira nepotpisane build-script binarije koje cargo generira. Debug build prolazi; release ne.

**Posljedica:** veličina instalera i cold start iz plana faze 1 još nisu izmjereni na ovom stroju.

**Opcije:** graditi release u CI-u (GitHub Actions runneri nemaju SAC), na drugom stroju, ili isključiti Smart App Control. Zadnje je jednosmjerno — ponovno uključivanje traži reinstalaciju Windowsa — pa je to korisnikova odluka, ne nešto što se usput napravi.

## Posljedice

**Prihvaćamo:**
- ovisnost o webview-u svake platforme; razlike između WebView2, WKWebView i WebKitGTK moraju biti u CI matrici od početka
- Rust u lancu izgradnje, dakle sporiji cold build i zahtjevniji onboarding doprinositelja
- CodeMirror umjesto Monaca, dakle nema VS Code pariteta

**Dobivamo:**
- jednu jezgru za tri targeta, dokazano na sva tri
- 12,8 MB debug binary naspram ~150 MB koliko bi tražio Electron
- sandbox datotečnog sustava koji provodi Rust, a ne UI

## Sljedeći korak

Faza 0 je zatvorena — sva pet spike-ova su izvedena. Preostaju dvije mjere koje traže tuđe okruženje, ne novu odluku: release build u CI-u (zbog Smart App Controla na ovom stroju) i mjerenje veličine i cold starta mobilnog release builda prije faze 4.
