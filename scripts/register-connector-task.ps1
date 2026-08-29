[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $ProjectRoot,
    [string] $TaskName = 'Codex Anywhere Connector',
    [switch] $NoStart,
    [switch] $PlanOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = if ($ProjectRoot) {
    [IO.Path]::GetFullPath($ProjectRoot)
}
else {
    Split-Path -Parent $PSScriptRoot
}
$watcherPath = Join-Path $PSScriptRoot 'watch-connector.ps1'
if (-not (Test-Path -LiteralPath $watcherPath -PathType Leaf)) {
    throw "Connector watchdog was not found: $watcherPath"
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watcherPath`" -ProjectRoot `"$projectRoot`""
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($PlanOnly) {
    [PSCustomObject]@{
        taskName = $TaskName
        user = $identity
        executable = $powerShellPath
        arguments = $arguments
        workingDirectory = $projectRoot
        trigger = 'AtLogOn'
        restartCount = 10
        restartIntervalMinutes = 1
    }
    return
}

$requiredCommands = @(
    'New-ScheduledTaskAction',
    'New-ScheduledTaskTrigger',
    'New-ScheduledTaskPrincipal',
    'New-ScheduledTaskSettingsSet',
    'New-ScheduledTask',
    'Register-ScheduledTask'
)
foreach ($command in $requiredCommands) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Windows scheduled-task command is unavailable: $command"
    }
}

$action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument $arguments `
    -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal `
    -UserId $identity `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Keeps this PC connected to Codex Anywhere while the user is signed in.'

if ($PSCmdlet.ShouldProcess($TaskName, 'Register current-user connector task')) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    if (-not $NoStart) {
        try {
            Start-ScheduledTask -TaskName $TaskName
        }
        catch {
            Write-Warning "The task was registered but could not be started immediately. It will retry at the next sign-in. $($_.Exception.Message)"
        }
    }
    Write-Output "Installed current-user background task: $TaskName"
}
else {
    Write-Output "Planned current-user background task: $TaskName"
}
