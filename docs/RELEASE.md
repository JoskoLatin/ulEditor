# Izdanja

Jedan tag daje jedno izdanje, a u njemu su i instaleri za računalo i APK za
telefon. PC i Android nisu odvojene verzije projekta — isti Rust
([crates/ul-core/](../crates/ul-core/), [crates/ul-formats/](../crates/ul-formats/))
i isti frontend ([packages/shell-ui/](../packages/shell-ui/)) idu na oba, a
[gen/android/](../apps/desktop/src-tauri/gen/android/) je samo omotač koji Tauri
generira iz iste konfiguracije. Razdvajaju se tek na kraju, kao datoteke koje
korisnik skida.

Sve gradi [.github/workflows/release.yml](../.github/workflows/release.yml).

## Što izlazi iz jednog taga

| Datoteka | Za koga |
| --- | --- |
| `ulEditor_0.1.0_x64_en-US.msi`, `ulEditor_0.1.0_x64-setup.exe` | Windows |
| `ulEditor_0.1.0_aarch64.dmg`, `ulEditor_0.1.0_x64.dmg` | macOS |
| `ulEditor_0.1.0_amd64.deb`, `ulEditor_0.1.0_amd64.AppImage` | Linux |
| `ulEditor_0.1.0_android.apk` | Telefon, izravna instalacija |
| `ulEditor_0.1.0_android.aab` | Google Play, ako ikad zatreba |

## Priprema koja se radi jednom: potpisni ključ

Nepotpisan release APK Android odbija instalirati. Ključ se izrađuje jednom i
vrijedi za sva buduća izdanja.

```powershell
keytool -genkey -v -keystore uleditor-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias uleditor
```

Datoteku spremi **izvan repozitorija** i napravi joj sigurnosnu kopiju. Ovo nije
formalnost: izgubiš li ključ, više ne možeš objaviti nadogradnju aplikacije koja
je već na tuđim telefonima — Android nadogradnju potpisanu drugim ključem
odbija. Jedini izlaz je nova aplikacija s novim imenom paketa.

Zatim ključ pretvori u tekst koji GitHub može čuvati:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("uleditor-release.jks")) | Set-Clipboard
```

I upiši četiri vrijednosti u **Settings → Secrets and variables → Actions**:

| Secret | Sadržaj |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | ono što je upravo završilo u međuspremniku |
| `ANDROID_KEYSTORE_PASSWORD` | lozinka keystorea |
| `ANDROID_KEY_ALIAS` | `uleditor` |
| `ANDROID_KEY_PASSWORD` | lozinka ključa (kod `keytool` postupka gore obično ista) |

Bez `ANDROID_KEYSTORE_BASE64` Android posao staje odmah i kaže zašto. Instaleri
za računalo se svejedno izgrade — izdanje ne pada zbog telefona.

## Objava

Verzija se drži na jednom mjestu,
[tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json). Odatle je čitaju i
instaleri i `versionCode` APK-a, pa se PC i Android ne mogu razići.

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Izdanje nastaje kao **draft** — artefakti se skupljaju u njega dok se četiri
buildera vrte, a ti ga objaviš tek kad si ih preuzeo i isprobao. Padne li jedan
builder, ponovno pokretanje se nadovezuje na isti draft umjesto da otvara novi.

## Lokalni Android build

Za razvoj se ništa nije promijenilo — [tools/android-dev.ps1](../tools/android-dev.ps1)
i dalje gradi *debug* APK i ne traži nikakav ključ:

```powershell
pnpm android:build
```

Potpisani *release* APK lokalno nastaje tek ako uz njega postoje
`apps/desktop/src-tauri/gen/android/keystore.properties` i `.jks` na koji
pokazuje. Dok ih nema, gradle taj dio tiho preskače.
