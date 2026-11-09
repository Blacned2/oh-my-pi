# Shortcut for scripts\build-installer.ps1.
#   build.ps1                 fast build (no omp/stats), notes "update"
#   build.ps1 "notes"         fast build with these notes
#   build.ps1 full "notes"    full build including omp + stats
#   build.ps1 keep "notes"    fast build without bumping the version
param([string]$Mode = "", [string]$Notes = "")
$opts = @{ NoOmp = $true; NoStats = $true }
switch ($Mode.ToLower()) {
    "full" { $opts = @{} }
    "keep" { $opts.NoBump = $true }
    ""     { }
    default { $Notes = $Mode }
}
if (-not $Notes) { $Notes = "update" }
$opts.Notes = $Notes
& (Join-Path $PSScriptRoot "scripts\build-installer.ps1") @opts
exit $LASTEXITCODE
