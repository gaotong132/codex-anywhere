[CmdletBinding()]
param(
    [Security.SecureString] $ConnectorToken,
    [string] $BridgeUrl,
    [string] $DeviceId,
    [string[]] $AllowedRoots,
    [switch] $AllowAnyFileDownload,
    [switch] $EnableNetworkAccess,
    [switch] $AllowFullAccess,
    [switch] $NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')

$projectRoot = Split-Path -Parent $PSScriptRoot
$hiddenLauncherPath = Join-Path $PSScriptRoot 'launch-connector-hidden.vbs'
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

$existingConfig = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try {
        $existingConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Existing connector settings are invalid: $configPath. $($_.Exception.Message)"
    }
}

function Get-ExistingSetting {
    param(
        [Parameter(Mandatory)] [string] $Name,
        $DefaultValue
    )

    if ($existingConfig -and $existingConfig.PSObject.Properties.Name -contains $Name) {
        return $existingConfig.$Name
    }
    return $DefaultValue
}

$effectiveBridgeUrl = if ($PSBoundParameters.ContainsKey('BridgeUrl')) {
    $BridgeUrl
}
else {
    [string] (Get-ExistingSetting -Name 'bridgeUrl' -DefaultValue 'ws://127.0.0.1:3300/ws')
}
$effectiveDeviceId = if ($PSBoundParameters.ContainsKey('DeviceId')) {
    $DeviceId
}
else {
    [string] (Get-ExistingSetting -Name 'deviceId' -DefaultValue 'personal-pc')
}

$bridgeUri = $null
if (-not [Uri]::TryCreate($effectiveBridgeUrl, [UriKind]::Absolute, [ref] $bridgeUri) -or $bridgeUri.Scheme -notin @('ws', 'wss')) {
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
[string[]] $resolvedAllowedRoots = if ($PSBoundParameters.ContainsKey('AllowedRoots') -and $AllowedRoots.Count -gt 0) {
    $AllowedRoots | ForEach-Object { [IO.Path]::GetFullPath($_) }
}
elseif ($existingConfig) {
    @(Get-ExistingSetting -Name 'allowedRoots' -DefaultValue @($projectRoot)) |
        ForEach-Object { [IO.Path]::GetFullPath([string] $_) }
}
else {
    $projectRoot
}
$effectiveAllowAnyFileDownload = if ($PSBoundParameters.ContainsKey('AllowAnyFileDownload')) {
    [bool] $AllowAnyFileDownload
}
else {
    [bool] (Get-ExistingSetting -Name 'allowAnyFileDownload' -DefaultValue $false)
}
$effectiveNetworkAccess = if ($PSBoundParameters.ContainsKey('EnableNetworkAccess')) {
    [bool] $EnableNetworkAccess
}
else {
    [bool] (Get-ExistingSetting -Name 'networkAccess' -DefaultValue $false)
}
$effectiveAllowFullAccess = if ($PSBoundParameters.ContainsKey('AllowFullAccess')) {
    [bool] $AllowFullAccess
}
else {
    [bool] (Get-ExistingSetting -Name 'allowFullAccess' -DefaultValue $false)
}
$connectorConfig = [ordered]@{
    bridgeUrl = $bridgeUri.AbsoluteUri
    deviceId = $effectiveDeviceId
    allowedRoots = $resolvedAllowedRoots
    allowAnyFileDownload = $effectiveAllowAnyFileDownload
    networkAccess = $effectiveNetworkAccess
    allowFullAccess = $effectiveAllowFullAccess
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
    if (-not (Test-Path -LiteralPath $hiddenLauncherPath -PathType Leaf)) {
        throw "Hidden connector launcher was not found: $hiddenLauncherPath"
    }
    $wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
        throw "Windows Script Host was not found: $wscriptPath"
    }
    $arguments = "//B //NoLogo `"$hiddenLauncherPath`" `"$projectRoot`""
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $wscriptPath
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
        Start-Process -FilePath $wscriptPath -ArgumentList $arguments -WindowStyle Hidden
    }
    $backgroundLauncher = "login shortcut: $shortcutPath"
}

Write-Output "Installed connector launcher: $backgroundLauncher"
Write-Output "Connector credential stored with Windows DPAPI: $secretPath"
Write-Output "Connector device key will be stored with Windows DPAPI: $deviceSecretPath"
Write-Output "Connector settings stored outside the repository: $configPath"
