[CmdletBinding()]
param(
    [string] $ProjectRoot,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = if ($ProjectRoot) {
    [IO.Path]::GetFullPath($ProjectRoot)
}
else {
    Split-Path -Parent $PSScriptRoot
}
$starterPath = Join-Path $PSScriptRoot 'start-connector.ps1'
$connectorPath = Join-Path $projectRoot 'build\connector\index.js'
$mutex = [Threading.Mutex]::new($false, 'Local\CodexAnywhereConnectorWatchdog')
$ownsMutex = $false

try {
    try { $ownsMutex = $mutex.WaitOne(0, $false) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }

    while ($true) {
        & $starterPath -ProjectRoot $projectRoot -ConfigPath $ConfigPath
        $connector = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($connectorPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
            } |
            Select-Object -First 1
        if ($connector) {
            Wait-Process -Id $connector.ProcessId -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
}
finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
