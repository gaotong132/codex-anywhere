[CmdletBinding()]
param(
    [Security.SecureString] $ConnectorToken,
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
$watcherPath = Join-Path $PSScriptRoot 'watch-connector.ps1'
$taskRegistrarPath = Join-Path $PSScriptRoot 'register-connector-task.ps1'
$stateDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-anywhere'
$legacyStateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PersonalCodexBridge'
$secretPath = Join-Path $stateDirectory 'connector-token.dpapi'
$deviceSecretPath = Join-Path $stateDirectory 'connector-device-key.dpapi'
$configPath = Join-Path $stateDirectory 'connector.json'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Codex Anywhere Connector.lnk'
$legacyShortcutPath = Join-Path $startupDirectory 'Personal Codex Bridge Connector.lnk'
$taskName = 'Codex Anywhere Connector'

$bridgeUri = $null
if (-not [Uri]::TryCreate($BridgeUrl, [UriKind]::Absolute, [ref] $bridgeUri) -or $bridgeUri.Scheme -notin @('ws', 'wss')) {
    throw 'BridgeUrl must use ws:// or wss://.'
}
if (-not [string]::IsNullOrEmpty($bridgeUri.UserInfo) -or -not [string]::IsNullOrEmpty($bridgeUri.Query) -or -not [string]::IsNullOrEmpty($bridgeUri.Fragment)) {
    throw 'BridgeUrl must not contain credentials, query parameters, or a fragment.'
}
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

# Files created from a packaged desktop app can be redirected into an app-specific
# LocalAppData view that a normal Windows background task cannot see. Keep the
# DPAPI user boundary, but migrate known state into a shared per-user directory.
foreach ($stateFileName in @(
    'connector-token.dpapi',
    'connector-device-key.dpapi',
    'connector.json'
)) {
    $legacyStatePath = Join-Path $legacyStateDirectory $stateFileName
    $currentStatePath = Join-Path $stateDirectory $stateFileName
    if (-not [IO.File]::Exists($currentStatePath) -and [IO.File]::Exists($legacyStatePath)) {
        [IO.File]::Copy($legacyStatePath, $currentStatePath, $false)
    }
}

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

$backgroundLauncher = $null
try {
    & $taskRegistrarPath -ProjectRoot $projectRoot -TaskName $taskName -NoStart:$NoStart
    $backgroundLauncher = "current-user background task: $taskName"
    foreach ($obsoleteShortcut in @($shortcutPath, $legacyShortcutPath)) {
        if (Test-Path -LiteralPath $obsoleteShortcut -PathType Leaf) {
            Remove-Item -LiteralPath $obsoleteShortcut -Force
        }
    }
}
catch {
    Write-Warning "Could not register the Windows background task; using the login shortcut instead. $($_.Exception.Message)"
    $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcherPath`""
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
    $backgroundLauncher = "login shortcut: $shortcutPath"
}

Write-Output "Installed connector launcher: $backgroundLauncher"
Write-Output "Connector credential stored with Windows DPAPI: $secretPath"
Write-Output "Connector device key will be stored with Windows DPAPI: $deviceSecretPath"
Write-Output "Connector settings stored outside the repository: $configPath"
