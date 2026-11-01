#requires -Version 5.1
<#
  stop-edge.ps1 - close the workspace Edge.
  Matches ONLY processes whose command line carries this workspace profile path,
  so the user's everyday Edge is never touched.

  ASCII-only on purpose (see doctor.ps1 header).
#>
[CmdletBinding()]
param([int]$Port = 9222, [switch]$Quiet)

$ErrorActionPreference = 'Stop'

$root       = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $root 'var\profile'

function Get-WorkspaceEdge {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    return @($all | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" })
}

$total = 0
for ($pass = 1; $pass -le 3; $pass++) {
    $procs = Get-WorkspaceEdge
    if ($procs.Count -eq 0) { break }
    $total += $procs.Count
    if (-not $Quiet) { Write-Host "Pass ${pass}: closing $($procs.Count) process(es)" -ForegroundColor Cyan }
    foreach ($p in $procs) {
        if (-not $Quiet) { Write-Host "  pid $($p.ProcessId)" -ForegroundColor DarkGray }
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Milliseconds 700
}

$left = Get-WorkspaceEdge
if ($left.Count -gt 0) {
    Write-Host "$($left.Count) process(es) still alive (permission?). Remaining pids:" -ForegroundColor Red
    $left | ForEach-Object { Write-Host "  $($_.ProcessId)" -ForegroundColor Red }
    exit 1
}

if ($total -eq 0) {
    if (-not $Quiet) { Write-Host 'No workspace Edge was running.' -ForegroundColor Green }
}
else {
    if (-not $Quiet) { Write-Host "Closed $total process(es)." -ForegroundColor Green }
}

# is the port actually free now?
$listener = $null
try { $listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) | Select-Object -First 1 }
catch { $listener = $null }

if ($listener) {
    $op = $listener.OwningProcess
    $opName = '?'
    try { $opName = (Get-Process -Id $op -ErrorAction Stop).ProcessName } catch {}
    Write-Host "Port $Port is still held by $opName (pid $op) - not this workspace's process, left alone." -ForegroundColor Yellow
    exit 1
}

if (-not $Quiet) { Write-Host 'Port released.' -ForegroundColor Green }
exit 0
