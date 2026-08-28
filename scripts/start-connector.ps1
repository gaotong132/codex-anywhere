[CmdletBinding()]
param(
    [string] $ProjectRoot,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')

$projectRoot = if ($ProjectRoot) { [IO.Path]::GetFullPath($ProjectRoot) } else { Split-Path -Parent $PSScriptRoot }
$stateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PersonalCodexBridge'
$secretPath = Join-Path $stateDirectory 'bridge-token.dpapi'
$configPath = if ($ConfigPath) { [IO.Path]::GetFullPath($ConfigPath) } else { Join-Path $stateDirectory 'connector.json' }
$failurePath = Join-Path $stateDirectory 'last-start-error.log'

New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

trap {
    $failureText = "$(Get-Date -Format o)`r`n$($_ | Out-String)"
    [IO.File]::WriteAllText($failurePath, $failureText, [Text.UTF8Encoding]::new($false))
    exit 1
}

if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "Bridge credential is missing: $secretPath"
}

$config = [PSCustomObject]@{}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

function Get-ConfigValue {
    param([string] $Name)
    $property = $config.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Resolve-TextSetting {
    param(
        [string] $EnvironmentName,
        [string] $ConfigName,
        [string] $DefaultValue
    )
    $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) { return $environmentValue.Trim() }
    $configValue = Get-ConfigValue $ConfigName
    if (-not [string]::IsNullOrWhiteSpace([string] $configValue)) { return ([string] $configValue).Trim() }
    return $DefaultValue
}

$bridgeUrl = Resolve-TextSetting 'BRIDGE_URL' 'bridgeUrl' 'ws://127.0.0.1:3300/ws'
$deviceId = Resolve-TextSetting 'BRIDGE_DEVICE_ID' 'deviceId' 'personal-pc'
$workspace = [IO.Path]::GetFullPath((Resolve-TextSetting 'CODEX_WORKSPACE' 'workspace' $projectRoot))
$allowedRootsFromEnvironment = [Environment]::GetEnvironmentVariable('CODEX_ALLOWED_ROOTS', 'Process')
if (-not [string]::IsNullOrWhiteSpace($allowedRootsFromEnvironment)) {
    $allowedRoots = $allowedRootsFromEnvironment.Trim()
}
else {
    $configuredRoots = Get-ConfigValue 'allowedRoots'
    if ($configuredRoots -is [string]) {
        $allowedRoots = $configuredRoots.Trim()
    }
    elseif ($configuredRoots) {
        $allowedRoots = [string]::Join([IO.Path]::PathSeparator, @($configuredRoots | ForEach-Object { [IO.Path]::GetFullPath([string] $_) }))
    }
    else {
        $allowedRoots = $workspace
    }
}
$networkAccessFromEnvironment = [Environment]::GetEnvironmentVariable('CODEX_NETWORK_ACCESS', 'Process')
if (-not [string]::IsNullOrWhiteSpace($networkAccessFromEnvironment)) {
    $networkAccess = if ($networkAccessFromEnvironment -eq '1') { '1' } else { '0' }
}
else {
    $networkAccess = if ((Get-ConfigValue 'networkAccess') -eq $true) { '1' } else { '0' }
}
$allowAnyFileDownloadFromEnvironment = [Environment]::GetEnvironmentVariable('CODEX_ALLOW_ANY_FILE_DOWNLOAD', 'Process')
if (-not [string]::IsNullOrWhiteSpace($allowAnyFileDownloadFromEnvironment)) {
    $allowAnyFileDownload = if ($allowAnyFileDownloadFromEnvironment -eq '1') { '1' } else { '0' }
}
else {
    $allowAnyFileDownload = if ((Get-ConfigValue 'allowAnyFileDownload') -eq $true) { '1' } else { '0' }
}

$bridgeUri = $null
if (-not [Uri]::TryCreate($bridgeUrl, [UriKind]::Absolute, [ref] $bridgeUri) -or $bridgeUri.Scheme -notin @('ws', 'wss')) {
    throw "Bridge URL must use ws:// or wss://: $bridgeUrl"
}
if (-not [string]::IsNullOrEmpty($bridgeUri.UserInfo) -or -not [string]::IsNullOrEmpty($bridgeUri.Query) -or -not [string]::IsNullOrEmpty($bridgeUri.Fragment)) {
    throw 'Bridge URL must not contain credentials, query parameters, or a fragment.'
}
$bridgeUrl = $bridgeUri.AbsoluteUri

$protectedToken = [Convert]::FromBase64String((Get-Content -LiteralPath $secretPath -Raw).Trim())
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedToken,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$plainToken = [Text.Encoding]::UTF8.GetString($plainBytes)
[Array]::Clear($plainBytes, 0, $plainBytes.Length)

$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $nodePath) {
    $nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
}
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw 'Node.js executable was not found.'
}

$codexPath = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $codexPath) {
    $codexPath = (Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $codexPath) {
    throw 'Codex CLI executable was not found.'
}

try {
    if (Test-Path -LiteralPath $failurePath -PathType Leaf) {
        Remove-Item -LiteralPath $failurePath -Force
    }

    $env:BRIDGE_TOKEN = $plainToken
    $env:BRIDGE_URL = $bridgeUrl
    $env:BRIDGE_DEVICE_ID = $deviceId
    $env:CODEX_WORKSPACE = $workspace
    $env:CODEX_ALLOWED_ROOTS = $allowedRoots
    $env:CODEX_ALLOW_ANY_FILE_DOWNLOAD = $allowAnyFileDownload
    $env:CODEX_NETWORK_ACCESS = $networkAccess
    $env:CODEX_BIN = $codexPath

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = 'src\connector\index.js'
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $connectorProcess = [Diagnostics.Process]::Start($startInfo)
    if (-not $connectorProcess) {
        throw 'Connector process could not be started.'
    }
    try {
        Start-Sleep -Milliseconds 800
        $connectorProcess.Refresh()
        if ($connectorProcess.HasExited -and $connectorProcess.ExitCode -ne 0) {
            throw "Connector exited during startup with code $($connectorProcess.ExitCode)."
        }
    }
    finally {
        $connectorProcess.Dispose()
    }
}
finally {
    $plainToken = $null
    [Array]::Clear($protectedToken, 0, $protectedToken.Length)
    Remove-Item Env:BRIDGE_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:BRIDGE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:BRIDGE_DEVICE_ID -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_WORKSPACE -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_ALLOWED_ROOTS -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_ALLOW_ANY_FILE_DOWNLOAD -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_NETWORK_ACCESS -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_BIN -ErrorAction SilentlyContinue
}
