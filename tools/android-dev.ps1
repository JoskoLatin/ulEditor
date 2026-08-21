# Running ulEditor on an Android device.
#
# It has to go through an elevated process: while assembling the APK, Tauri makes
# a symbolic link to `libuleditor_lib.so`, and without Developer Mode Windows
# allows that only to an administrator. The alternative is to turn Developer Mode
# on and run normally.
#
# Nothing is installed or changed on the system — the elevation serves solely to
# create a symlink inside the project.
#
#   powershell -ExecutionPolicy Bypass -File tools\android-dev.ps1 [-Build]

param(
    # Assemble a standalone APK and stop, instead of the dev loop.
    #
    # The dev loop loads the interface off the computer over the LAN, so it needs
    # the phone and the computer on the same subnet. A standalone APK carries the
    # interface inside it and works with nothing else — that is what goes onto the
    # device when the LAN is not an option.
    [switch]$Build,

    # The device architecture. Building every ABI takes several times as long, and
    # on any one phone only a single one runs anyway.
    [string]$Abi = 'aarch64'
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'tools\android-dev.log'

$jdk = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
$sdk = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
$ndk = [Environment]::GetEnvironmentVariable('NDK_HOME', 'User')

if (-not $jdk -or -not $sdk -or -not $ndk) {
    "JAVA_HOME / ANDROID_HOME / NDK_HOME are missing." | Tee-Object -FilePath $log
    exit 1
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = $ndk
$env:Path = "$env:USERPROFILE\.cargo\bin;$jdk\bin;$sdk\platform-tools;$env:Path"

Set-Location $root

$command = if ($Build) { "android build --debug --apk --target $Abi" } else { 'android dev' }
"running: tauri $command" | Tee-Object -FilePath $log

# `pnpm.cmd` rather than `pnpm`: in an elevated session the PowerShell module need
# not be on the path, while the `.cmd` wrapper always sits beside the npm globals.
& "$env:APPDATA\npm\pnpm.cmd" --filter '@uleditor/desktop' exec tauri $command.Split(' ') 2>&1 |
    Tee-Object -FilePath $log -Append
