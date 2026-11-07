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
    #
    # On a phone with real data, only -Build. The dev loop serves the interface
    # over cleartext HTTP from the LAN with the full IPC behind it, so anything on
    # the LAN that can spoof the computer's address writes the page of an app that
    # may hold all-files access (independent review of ADR 0003 step 1, S4).
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

# No shared Gradle daemon. An idle daemon serves whichever client finds it, and
# one started without elevation (VS Code's Java extension starts one as soon as
# the CLI rewrites the Gradle files) runs the build's own `tauri
# android-studio-script` unelevated, so the second symlink is refused even from
# an administrator's shell. A single-use daemon is this process's child and has
# its rights. Measured: with this the shared daemon received no build, without
# it the build went into it. It costs a cold JVM, about ten seconds a build.
$env:GRADLE_OPTS = "$env:GRADLE_OPTS -Dorg.gradle.daemon=false".Trim()

Set-Location $root

$command = if ($Build) { "android build --debug --apk --target $Abi" } else { 'android dev' }
"running: tauri $command" | Tee-Object -FilePath $log

# `pnpm.cmd` rather than `pnpm`: in an elevated session the PowerShell module need
# not be on the path, while the `.cmd` wrapper always sits beside the npm globals.
& "$env:APPDATA\npm\pnpm.cmd" --filter '@uleditor/desktop' exec tauri $command.Split(' ') 2>&1 |
    Tee-Object -FilePath $log -Append

# The pipeline's own result is Tee-Object's, which always succeeds; without this
# a build that failed (a symlink refused without elevation, say) exited 0.
exit $LASTEXITCODE
