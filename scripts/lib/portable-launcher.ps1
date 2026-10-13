# The builder copies this entrypoint to rea.ps1 at the portable root.
$ErrorActionPreference = 'Stop'
$reaStart = [System.Diagnostics.ProcessStartInfo]::new()
$reaStart.FileName = Join-Path $PSScriptRoot 'runtime/node.exe'
$reaStart.UseShellExecute = $false
$reaStart.EnvironmentVariables.Remove('npm_command')
$reaArguments = @((Join-Path $PSScriptRoot 'app/scripts/rea.mjs')) + $args
# ProcessStartInfo on Windows PowerShell 5.1 has no ArgumentList. Encode each
# argument once using Windows CRT rules, with no cmd or native pipeline parsing.
$reaStart.Arguments = ($reaArguments | ForEach-Object {
  '"' + (([string]$_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}) -join ' '
$reaProcess = [System.Diagnostics.Process]::Start($reaStart)
try {
  $reaProcess.WaitForExit()
  $reaExitCode = $reaProcess.ExitCode
} finally {
  $reaProcess.Dispose()
}
exit $reaExitCode
