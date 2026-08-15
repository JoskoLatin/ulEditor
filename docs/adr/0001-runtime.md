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
| 2 | Tauri v2 Android build | **nije izveden** | Vidi „Otvoreno” — kritični rizik ostaje neriješen |
| 3 | Rust jezgra → WASM | **prošao** | `ul-formats` se gradi za `wasm32-unknown-unknown`, 364 KB nekomprimirano prije `wasm-opt` |
| 4 | Render PDF-a | **prošao**, ali drukčije nego planirano | pdf.js umjesto pdfiuma — vidi ispod |
| 5 | CodeMirror 6 u shellu | **prošao** | Bojanje sintakse, 13 jezika lijeno učitanih |

Umjesto pet throwaway grana napravljen je odmah upotrebljiv shell, jer su prva četiri spike-a prošla bez otpora. To je odstupanje od plana i svjesno je: kod nije bačen.

### Odstupanje kod PDF-a

Plan je tražio `pdfium-render`. Umjesto toga je isporučen pdf.js s vlastitim tekstualnim slojem.

**Razlog:** pdf.js radi na sva tri targeta odmah i bez distribucije nativnog binarija, pa je faza 1 upotrebljiva ranije. pdfium ostaje planiran za desktop kad performanse na velikim dokumentima to zatraže — ugovor `EditorInstance` je isti, pa je zamjena lokalna promjena unutar `editor-pdf`.

**Cijena:** pdf.js je sporiji i troši više memorije na dokumentima od nekoliko stotina stranica. Mjeriti prije faze 4 (mobile), gdje je memorija webviewa realno ograničenje.

Tekstualni sloj je pisan ručno (~40 linija) umjesto korištenjem `TextLayer` klase iz pdf.js-a, jer se taj API mijenjao između većih verzija. Manje ovisnosti o tuđem nestabilnom sučelju.

## Otvoreno — Android spike nije izveden

**Ovo je najvažnija nedovršena stavka faze 0.** Plan ga je označio kao go/no-go za cijeli izbor stacka, a odluka je donesena bez njega.

Odluka je svejedno „go” jer:
- Tauri v2 službeno podržava iOS i Android od stabilnog izdanja
- jezgra se već dokazano gradi za treći target (WASM), što je bio glavni tehnički rizik oko Rust jezgre
- mobile je faza 4, oko 14 mjeseci daleko

Ali rizik je **odgođen, ne uklonjen**. Android build treba pokrenuti prije nego shell naraste, jer je Electron fallback to jeftiniji što se ranije aktivira. Preduvjeti: Android SDK, NDK, `cargo tauri android init`.

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
- jednu jezgru za tri targeta, dokazano barem za dva
- 12,8 MB debug binary naspram ~150 MB koliko bi tražio Electron
- sandbox datotečnog sustava koji provodi Rust, a ne UI

## Sljedeći korak

Pokrenuti Android spike prije nego shell naraste dovoljno da preseljenje postane skupo.
