Option Explicit

Dim shell, fileSystem, scriptDirectory, projectRoot
Dim watcherPath, powerShellPath, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
    If LCase(CStr(WScript.Arguments(0))) = "--check" Then
        WScript.Quit 0
    End If
    projectRoot = fileSystem.GetAbsolutePathName(CStr(WScript.Arguments(0)))
Else
    projectRoot = fileSystem.GetParentFolderName(scriptDirectory)
End If

watcherPath = fileSystem.BuildPath(scriptDirectory, "watch-connector.ps1")
If Not fileSystem.FileExists(watcherPath) Then
    WScript.Quit 2
End If

powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
If Not fileSystem.FileExists(powerShellPath) Then
    WScript.Quit 3
End If

shell.CurrentDirectory = projectRoot
command = QuoteArgument(powerShellPath) _
    & " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
    & QuoteArgument(watcherPath) & " -ProjectRoot " & QuoteArgument(projectRoot)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
