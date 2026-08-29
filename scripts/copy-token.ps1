[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')

$primaryStateDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-anywhere'
$legacyStateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PersonalCodexBridge'
$stateDirectory = if (
    [IO.File]::Exists((Join-Path $primaryStateDirectory 'bridge-client-token.dpapi')) -or
    -not [IO.File]::Exists((Join-Path $legacyStateDirectory 'bridge-client-token.dpapi'))
) {
    $primaryStateDirectory
}
else {
    $legacyStateDirectory
}
$secretPath = Join-Path $stateDirectory 'bridge-client-token.dpapi'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw 'Browser credential is missing. Store it with install-connector.ps1 -ClientToken before using this script.'
}

$protectedToken = [Convert]::FromBase64String((Get-Content -LiteralPath $secretPath -Raw).Trim())
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedToken,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
    $plainToken = [Text.Encoding]::UTF8.GetString($plainBytes)
    Set-Clipboard -Value $plainToken
    Write-Output 'Browser client token copied to the clipboard.'
}
finally {
    $plainToken = $null
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    [Array]::Clear($protectedToken, 0, $protectedToken.Length)
}
