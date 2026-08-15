# Pokretanje ulEditora na Android uređaju.
#
# Mora ići kroz elevirani proces: Tauri pri sastavljanju APK-a radi symbolic
# link na `libuleditor_lib.so`, a Windows to bez Developer Modea dopušta samo
# administratoru. Alternativa je uključiti Developer Mode i pokretati normalno.
#
# Ništa se ne instalira ni ne mijenja u sustavu — elevacija služi isključivo
# za stvaranje symlinka unutar projekta.
#
#   powershell -ExecutionPolicy Bypass -File tools\android-dev.ps1 [-Build]

param(
    # Umjesto dev petlje sastavi samostalan APK i zaustavi se.
    #
    # Dev petlja učitava sučelje s računala preko LAN-a, pa traži da telefon i
    # računalo budu na istoj podmreži. Samostalan APK nosi sučelje u sebi i radi
    # bez ičega — to je ono što se daje na uređaj kad LAN nije opcija.
    [switch]$Build,

    # Arhitektura uređaja. Gradnja svih ABI-ja traje višestruko dulje, a na
    # konkretnom telefonu ionako radi samo jedna.
    [string]$Abi = 'aarch64'
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'tools\android-dev.log'

$jdk = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
$sdk = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
$ndk = [Environment]::GetEnvironmentVariable('NDK_HOME', 'User')

if (-not $jdk -or -not $sdk -or -not $ndk) {
    "Nedostaju JAVA_HOME / ANDROID_HOME / NDK_HOME." | Tee-Object -FilePath $log
    exit 1
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = $ndk
$env:Path = "$env:USERPROFILE\.cargo\bin;$jdk\bin;$sdk\platform-tools;$env:Path"

Set-Location $root

$command = if ($Build) { "android build --debug --apk --target $Abi" } else { 'android dev' }
"pokrećem: tauri $command" | Tee-Object -FilePath $log

# `pnpm.cmd` umjesto `pnpm`: u eleviranoj sesiji PowerShell modul ne mora biti
# na putanji, a `.cmd` omotač je uvijek uz npm globalne pakete.
& "$env:APPDATA\npm\pnpm.cmd" --filter '@uleditor/desktop' exec tauri $command.Split(' ') 2>&1 |
    Tee-Object -FilePath $log -Append
