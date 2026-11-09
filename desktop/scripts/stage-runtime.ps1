# Copies the omp built from this repository (packages/coding-agent and the workspace packages it
# needs) and/or omp-stats, plus the bun runtime and exactly the packages they depend on, into
# desktop/runtime, which tauri.conf.json bundles into the installer. The omp installed on the
# machine is never used: the source is the repo root's node_modules (workspace links resolved).
# Requires `bun install` at the repo root and a built natives addon (packages/natives/native/*.node).
#   -NoOmp    leave the agent (pi-coding-agent) and the packages only it needs out
#   -NoStats  leave the dashboard (omp-stats) and the packages only it needs out
param(
    [switch]$NoOmp,
    [switch]$NoStats,
    [string]$Global = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$Bun = (Join-Path $env:USERPROFILE ".bun\bin\bun.exe")
)
$ErrorActionPreference = "Stop"

$ompPkg = "@oh-my-pi/pi-coding-agent"
$statsPkg = "@oh-my-pi/omp-stats"
$dest = Join-Path $PSScriptRoot "..\runtime"
$modules = Join-Path $Global "node_modules"

# Workspace packages are links into packages/; copy what they point at.
function Get-PkgDir([string]$name) {
    $p = Join-Path $modules ($name -replace "/", "\")
    if (Test-Path -LiteralPath $p) {
        $item = Get-Item -LiteralPath $p
        if ($item.LinkType) { $t = @($item.Target)[0]; if ($t) { return $t } }
    }
    $p
}

$roots = @()
if (-not $NoOmp) { $roots += $ompPkg }
if (-not $NoStats) { $roots += $statsPkg }
$required = @()
if ($roots.Count -gt 0) { $required += $Bun }
foreach ($r in $roots) { $required += (Get-PkgDir $r) }
foreach ($p in $required) {
    if (-not (Test-Path -LiteralPath $p)) { throw "Missing $p - run 'bun install' at the repo root first." }
}

# Walk dependencies + optionalDependencies through the repo's flat node_modules. A component
# that is switched off is never entered, even when the other one depends on it.
$skip = @()
if ($NoOmp) { $skip += $ompPkg }
if ($NoStats) { $skip += $statsPkg }
$wanted = [System.Collections.Generic.HashSet[string]]::new()
$queue = [System.Collections.Generic.Queue[string]]::new()
foreach ($r in $roots) { $queue.Enqueue($r) }
while ($queue.Count -gt 0) {
    $name = $queue.Dequeue()
    if ($skip -contains $name -and $roots -notcontains $name) { continue }
    if (-not $wanted.Add($name)) { continue }
    $json = Join-Path (Get-PkgDir $name) "package.json"
    if (-not (Test-Path -LiteralPath $json)) { continue } # optional dependency of another platform
    $pkg = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
    foreach ($field in "dependencies", "optionalDependencies") {
        if ($pkg.$field) { foreach ($d in $pkg.$field.PSObject.Properties.Name) { $queue.Enqueue($d) } }
    }
}
# Whatever omp-stats needs must be there even if only omp lists it, and vice versa: the
# loop above already took both closures. The platform natives are optional of pi-natives.
foreach ($skipped in $skip) { [void]$wanted.Remove($skipped) }
foreach ($r in $roots) { [void]$wanted.Add($r) }

if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest | Out-Null
if ($roots.Count -gt 0) { Copy-Item -LiteralPath $Bun -Destination (Join-Path $dest "bun.exe") }

$copied = 0
foreach ($name in $wanted) {
    $src = Get-PkgDir $name
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $to = Join-Path $dest ("node_modules\" + ($name -replace "/", "\"))
    # /XJ: no junctions. /XD .bin: shims there point at absolute paths of the source machine.
    robocopy $src $to /E /XJ /XD .bin /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $name with exit code $LASTEXITCODE" }
    $copied++
}

$version = (Get-Content (Join-Path (Get-PkgDir $ompPkg) "package.json") -Raw | ConvertFrom-Json).version
$parts = @()
if (-not $NoOmp) { $parts += "omp" }
if (-not $NoStats) { $parts += "stats" }
# Informational. A shell-only (update) installer writes no OMP_VERSION, so an installed runtime
# keeps its own; "SHELL_ONLY" just keeps the otherwise empty resource folder non-empty.
if ($parts) { Set-Content -Path (Join-Path $dest "OMP_VERSION") -Value $version -NoNewline }
else { Set-Content -Path (Join-Path $dest "SHELL_ONLY") -Value "" -NoNewline }
"Staged $($parts -join ' + ') $version ($copied packages) into $((Resolve-Path $dest).Path)"
$global:LASTEXITCODE = 0
