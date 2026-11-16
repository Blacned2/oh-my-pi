# Generates ONE new updater key pair and writes its public key into tauri.conf.json.
# Only for when the original private key is lost; if another machine still has it, copy
# updater.key + updater.key.pub from there instead (installed apps keep working).
# After rotating: commit tauri.conf.json, copy the key pair to every other build machine
# (never into git), and reinstall the app once by hand everywhere: installed apps still embed the
# old public key and reject updates signed with the new one.
#   rotate-updater-key.ps1 [-KeyPath <file>]   default ~\.kostomp\updater.key or $env:KOSTOMP_UPDATER_KEY
param([string]$KeyPath = "")
$ErrorActionPreference = "Stop"
$desktop = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$confPath = Join-Path $desktop "tauri.conf.json"
if (-not $KeyPath) { $KeyPath = if ($env:KOSTOMP_UPDATER_KEY) { $env:KOSTOMP_UPDATER_KEY } else { Join-Path $env:USERPROFILE ".kostomp\updater.key" } }

if (Test-Path -LiteralPath $KeyPath) {
    $backup = "$KeyPath.$(Get-Date -Format yyyyMMddHHmmss).bak"
    Move-Item -LiteralPath $KeyPath -Destination $backup
    if (Test-Path -LiteralPath "$KeyPath.pub") { Move-Item -LiteralPath "$KeyPath.pub" -Destination "$backup.pub" }
    "Old key kept as $backup"
}
New-Item -ItemType Directory -Force (Split-Path $KeyPath) | Out-Null

# --ci: empty password, no prompt (build-installer.ps1 signs with an empty password).
Push-Location $desktop
try {
    bunx @tauri-apps/cli@2 signer generate --ci -w $KeyPath
    if ($LASTEXITCODE -ne 0) { throw "tauri signer generate failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$pub = (Get-Content -LiteralPath "$KeyPath.pub" -Raw).Trim()
$utf8 = New-Object Text.UTF8Encoding($false)
$text = [IO.File]::ReadAllText($confPath)
$re = New-Object Text.RegularExpressions.Regex('"pubkey"\s*:\s*"[^"]*"')
if (-not $re.IsMatch($text)) { throw "No pubkey field found in $confPath" }
[IO.File]::WriteAllText($confPath, $re.Replace($text, "`"pubkey`": `"$pub`"", 1), $utf8)
"New pubkey written to tauri.conf.json. Next: commit it, copy $KeyPath and $KeyPath.pub to the other machine, reinstall once everywhere."
