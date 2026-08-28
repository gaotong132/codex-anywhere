[CmdletBinding()]
param(
    [Security.SecureString] $ConnectorToken,
    [Security.SecureString] $ClientToken,
    [string] $BridgeUrl = 'ws://127.0.0.1:3300/ws',
    [string] $DeviceId = 'personal-pc',
    [string[]] $AllowedRoots,
    [switch] $AllowAnyFileDownload,
    [switch] $EnableNetworkAccess,
    [switch] $NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'start-connector.ps1'
$stateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PersonalCodexBridge'
$secretPath = Join-Path $stateDirectory 'connector-token.dpapi'
$clientSecretPath = Join-Path $stateDirectory 'bridge-client-token.dpapi'
$configPath = Join-Path $stateDirectory 'connector.json'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Codex Anywhere Connector.lnk'
$legacyShortcutPath = Join-Path $startupDirectory 'Personal Codex Bridge Connector.lnk'

$bridgeUri = $null
if (-not [Uri]::TryCreate($BridgeUrl, [UriKind]::Absolute, [ref] $bridgeUri) -or $bridgeUri.Scheme -notin @('ws', 'wss')) {
    throw 'BridgeUrl must use ws:// or wss://.'
}
if (-not [string]::IsNullOrEmpty($bridgeUri.UserInfo) -or -not [string]::IsNullOrEmpty($bridgeUri.Query) -or -not [string]::IsNullOrEmpty($bridgeUri.Fragment)) {
    throw 'BridgeUrl must not contain credentials, query parameters, or a fragment.'
}
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

function Save-ProtectedCredential {
    param(
        [Parameter(Mandatory)] [Security.SecureString] $Value,
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Name
    )

    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    $plainBytes = $null
    $protectedToken = $null
    try {
        $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
        if ($plainToken.Length -lt 32) { throw "$Name must contain at least 32 characters." }
        $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainToken)
        $protectedToken = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [IO.File]::WriteAllText($Path, [Convert]::ToBase64String($protectedToken), [Text.UTF8Encoding]::new($false))
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
        $plainToken = $null
        if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
        if ($protectedToken) { [Array]::Clear($protectedToken, 0, $protectedToken.Length) }
    }
}

if ($ConnectorToken) {
    Save-ProtectedCredential -Value $ConnectorToken -Path $secretPath -Name 'Connector token'
}
elseif (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw 'ConnectorToken is required for the first installation.'
}
if ($ClientToken) {
    Save-ProtectedCredential -Value $ClientToken -Path $clientSecretPath -Name 'Browser client token'
}

$resolvedAllowedRoots = if ($AllowedRoots -and $AllowedRoots.Count -gt 0) {
    @($AllowedRoots | ForEach-Object { [IO.Path]::GetFullPath($_) })
}
else {
    @($projectRoot)
}
$connectorConfig = [ordered]@{
    bridgeUrl = $bridgeUri.AbsoluteUri
    deviceId = $DeviceId
    allowedRoots = $resolvedAllowedRoots
    allowAnyFileDownload = [bool] $AllowAnyFileDownload
    networkAccess = [bool] $EnableNetworkAccess
}
[IO.File]::WriteAllText(
    $configPath,
    ($connectorConfig | ConvertTo-Json -Depth 3),
    [Text.UTF8Encoding]::new($false)
)

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powerShellPath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Connect this PC to Codex Anywhere.'
    $shortcut.Save()
    if ($legacyShortcutPath -ne $shortcutPath -and (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf)) {
        Remove-Item -LiteralPath $legacyShortcutPath -Force
    }
}
finally {
    if ($shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}

if (-not $NoStart) {
    Start-Process -FilePath $powerShellPath -ArgumentList $arguments -WindowStyle Hidden
}

Write-Output "Installed login shortcut: $shortcutPath"
Write-Output "Connector credential stored with Windows DPAPI: $secretPath"
if (Test-Path -LiteralPath $clientSecretPath -PathType Leaf) {
    Write-Output "Browser credential stored with Windows DPAPI: $clientSecretPath"
}
Write-Output "Connector settings stored outside the repository: $configPath"
