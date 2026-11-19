# Generates a new updater key pair for THIS machine. Every build machine has its own pair:
# build-installer.ps1 embeds the local updater.key.pub into the app, so nothing goes into git.
# The installed app still trusts the old key and rejects updates signed with the new one:
# after rotating, install the next build once by hand on this machine.
#   rotate-updater-key.ps1 [-KeyPath <file>]   default ~\.kostomp\updater.key or $env:KOSTOMP_UPDATER_KEY
param([string]$KeyPath = "")
$ErrorActionPreference = "Stop"
$desktop = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
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

"New key pair at $KeyPath. Install the next build from build-installer.ps1 once by hand on this machine."
