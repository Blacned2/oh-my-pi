# Shortcut for scripts\build-installer.ps1. The default build bundles omp + stats: an installer
# without them leaves the app on "omp is not running".
#   build.ps1                 full build (omp + stats), notes "update"
#   build.ps1 "notes"         full build with these notes
#   build.ps1 fast "notes"    shell-only build (no omp/stats; keeps the ones already installed)
#   build.ps1 keep "notes"    full build without bumping the version
param([string]$Mode = "", [string]$Notes = "")
$opts = @{}
switch ($Mode.ToLower()) {
    "full" { }
    "fast" { $opts = @{ NoOmp = $true; NoStats = $true } }
    "keep" { $opts.NoBump = $true }
    ""     { }
    default { $Notes = $Mode }
}
if (-not $Notes) { $Notes = "update" }
$opts.Notes = $Notes
& (Join-Path $PSScriptRoot "scripts\build-installer.ps1") @opts
exit $LASTEXITCODE
