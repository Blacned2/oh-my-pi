# Creates a self-signed code-signing certificate in the current user's store and prints its
# thumbprint. For trying the signing pipeline only: Windows does not trust it, so SmartScreen
# still warns on other machines. Use a certificate from a CA for real releases.
# Remove it again with:  Remove-Item Cert:\CurrentUser\My\<thumbprint>
$ErrorActionPreference = "Stop"
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Kostomp (dev)" `
    -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2)
"Thumbprint: $($cert.Thumbprint)"
"Use it with:  `$env:KOSTOMP_SIGN_THUMBPRINT = '$($cert.Thumbprint)'"
