# Called by Tauri (bundle.windows.signCommand) for the app exe and the installer.
# The certificate is picked from the Windows certificate store by thumbprint, so no key or
# password ever sits in the repository:  $env:KOSTOMP_SIGN_THUMBPRINT = "<thumbprint>"
# Without it the file is left unsigned (plain local builds).
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = "Stop"

$thumb = $env:KOSTOMP_SIGN_THUMBPRINT
if (-not $thumb) { Write-Host "sign: KOSTOMP_SIGN_THUMBPRINT not set, leaving $File unsigned"; exit 0 }

$kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$signtool = Get-ChildItem -Path $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } |
    Sort-Object { [version]($_.FullName -replace '.*\\bin\\([\d.]+)\\.*', '$1') } -Descending |
    Select-Object -First 1
if (-not $signtool) { throw "signtool.exe not found; install the Windows SDK." }

# The timestamp keeps the signature valid after the certificate expires.
$stamp = if ($env:KOSTOMP_SIGN_TIMESTAMP_URL) { $env:KOSTOMP_SIGN_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
& $signtool.FullName sign /sha1 $thumb /fd sha256 /tr $stamp /td sha256 /d "Kostomp" $File
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE for $File" }
