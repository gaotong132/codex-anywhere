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
$launcherPath = Join-Path $PSScriptRoot 'launch-connector-hidden.vbs'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Hidden connector launcher was not found: $launcherPath"
}

$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "Windows Script Host was not found: $wscriptPath"
}
$arguments = "//B //NoLogo `"$launcherPath`" `"$projectRoot`""
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($PlanOnly) {
    [PSCustomObject]@{
        taskName = $TaskName
        user = $identity
        executable = $wscriptPath
        launcher = $launcherPath
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
    -Execute $wscriptPath `
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
