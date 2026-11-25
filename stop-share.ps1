$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.preview\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No background server is recorded. For a foreground server, press Ctrl+C in its window.'
    exit
}
$serverPid = [int](Get-Content -LiteralPath $pidFile)
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
$serverScript = Join-Path $PSScriptRoot 'server.js'
if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine.Contains($serverScript)) {
    Stop-Process -Id $serverPid
    Write-Host 'LAN Drop stopped.'
} else {
    Write-Host 'The recorded server is no longer running. No process was stopped.'
}
