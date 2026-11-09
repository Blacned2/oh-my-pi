# Builds the NSIS installer: stages the bundled runtime, then runs the Tauri build.
#   -NoOmp / -NoStats   leave that part out of the installer (see stage-runtime.ps1)
#   -Shell              shell-only installer for updates: same as -NoOmp -NoStats. Installing it
#                       over an existing install keeps the omp/stats already in runtime\.
#   -Notes "text"       release notes shown with the update
#   -Version "x.y.z"    build this version instead of the next patch version
#   -NoBump             keep the current version (no update is offered to an app on the same version)
# Each build bumps the patch version (1.0.1 -> 1.0.2) in tauri.conf.json and Cargo.toml first, so the
# installed app sees the new build as an update.
# Code signing: set $env:KOSTOMP_SIGN_THUMBPRINT first; Tauri calls sign.ps1 for the exe and installer.
# Updates: if the updater key exists (default ~\.kostomp\updater.key, or $env:KOSTOMP_UPDATER_KEY) the
# build also writes target\update\ (installer, .sig, latest.json) and copies it to the local update
# folder (%LOCALAPPDATA%\Kostomp\updates, or $env:KOSTOMP_UPDATE_DIR) that the app serves on loopback.
# The download URL is $env:KOSTOMP_UPDATE_BASE_URL, default: the folder of the endpoint in tauri.conf.json.
param(
    [switch]$NoOmp,
    [switch]$NoStats,
    [switch]$Shell,
    [string]$Notes = "",
    [string]$Version = "",
    [switch]$NoBump
)
$ErrorActionPreference = "Stop"
if ($Shell) { $NoOmp = $true; $NoStats = $true }
$desktop = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$confPath = Join-Path $desktop "tauri.conf.json"
$cargoPath = Join-Path $desktop "Cargo.toml"

# Version bump: text replace (first match only) so the files keep their formatting; written without a BOM.
if (-not $NoBump) {
    $current = (Get-Content $confPath -Raw | ConvertFrom-Json).version
    if ($Version) {
        if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "-Version must look like 1.2.3, got '$Version'" }
        $next = $Version
    } elseif ($current -match '^(\d+)\.(\d+)\.(\d+)$') {
        $next = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
    } else {
        throw "Cannot bump version '$current' in tauri.conf.json; pass -Version x.y.z"
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    foreach ($file in @(
        @{ Path = $confPath; Pattern = '"version"\s*:\s*"[^"]*"'; Value = "`"version`": `"$next`"" },
        @{ Path = $cargoPath; Pattern = '(?m)^version\s*=\s*"[^"]*"'; Value = "version = `"$next`"" }
    )) {
        $text = [IO.File]::ReadAllText($file.Path)
        $re = New-Object Text.RegularExpressions.Regex($file.Pattern)
        if (-not $re.IsMatch($text)) { throw "No version field found in $($file.Path)" }
        [IO.File]::WriteAllText($file.Path, $re.Replace($text, $file.Value, 1), $utf8)
    }
    "Version: $current -> $next"
}
$conf = Get-Content $confPath -Raw | ConvertFrom-Json

& (Join-Path $PSScriptRoot "stage-runtime.ps1") -NoOmp:$NoOmp -NoStats:$NoStats
if ($LASTEXITCODE -ne 0) { throw "stage-runtime failed" }

$keyPath = if ($env:KOSTOMP_UPDATER_KEY) { $env:KOSTOMP_UPDATER_KEY } else { Join-Path $env:USERPROFILE ".kostomp\updater.key" }
$updates = Test-Path -LiteralPath $keyPath
$tauriArgs = @("build", "--bundles", "nsis")
if ($updates) {
    $env:TAURI_SIGNING_PRIVATE_KEY = $keyPath
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }
    $override = Join-Path $desktop "target\updater-config.json"
    New-Item -ItemType Directory -Force (Split-Path $override) | Out-Null
    Set-Content -Path $override -Value '{"bundle":{"createUpdaterArtifacts":true}}'
    $tauriArgs += @("--config", $override)
} else {
    "No updater key at $keyPath - building without update artifacts."
}

Push-Location $desktop
try {
    # Windows cannot hold an empty env var, so the empty updater-key password is answered on stdin
    # (an unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD makes Tauri prompt for it).
    if ($updates -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { "" | bunx @tauri-apps/cli@2 @tauriArgs }
    else { bunx @tauri-apps/cli@2 @tauriArgs }
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$version = $conf.version
$name = "Kostomp_${version}_x64-setup.exe"
$installer = Join-Path $desktop "target\release\bundle\nsis\$name"
"Installer: $((Resolve-Path $installer).Path) ($([math]::Round((Get-Item $installer).Length / 1MB, 1)) MB)"
"Signature: $((Get-AuthenticodeSignature $installer).Status)"

if ($updates) {
    $out = Join-Path $desktop "target\update"
    New-Item -ItemType Directory -Force $out | Out-Null
    Copy-Item -LiteralPath $installer -Destination $out -Force
    Copy-Item -LiteralPath "$installer.sig" -Destination $out -Force
    $base = $env:KOSTOMP_UPDATE_BASE_URL
    if (-not $base) { $base = ($conf.plugins.updater.endpoints[0] -replace "/[^/]*$", "") }
    $latest = [ordered]@{
        version  = $version
        notes    = $Notes
        pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        platforms = [ordered]@{
            "windows-x86_64" = [ordered]@{
                signature = (Get-Content -LiteralPath "$installer.sig" -Raw).Trim()
                url       = "$($base.TrimEnd('/'))/$name"
            }
        }
    }
    # No BOM: the updater's JSON decoder rejects one.
    [IO.File]::WriteAllText((Join-Path $out "latest.json"), ($latest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    # Publish into the local update folder the running app serves on 127.0.0.1.
    $pub = $env:KOSTOMP_UPDATE_DIR
    if (-not $pub) { $pub = Join-Path $env:LOCALAPPDATA "Kostomp\updates" }
    New-Item -ItemType Directory -Force $pub | Out-Null
    Copy-Item -Path (Join-Path $out "*") -Destination $pub -Force
    "Update files: $out; published to $pub"
}
