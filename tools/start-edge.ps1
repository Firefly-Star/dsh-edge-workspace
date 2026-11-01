#requires -Version 5.1
<#
  start-edge.ps1 - idempotent start of the workspace Edge with the CDP debug port.
  Already running -> reuse. Stale port -> clean it. Process using our profile without the
  debug port -> refuse (a second instance on the same user-data-dir ignores the flag).

  Lifetime: Start-Process here keeps the browser inside the caller's job tree. Started from
  an agent session it can be reaped when the session ends. For a browser that stays, the
  user should double-click tools\start-edge.cmd (Explorer-started parents are not reaped).

  ASCII-only on purpose (see doctor.ps1 header).
#>
[CmdletBinding()]
param([int]$Port = 9222, [int]$WaitSeconds = 30)

$ErrorActionPreference = 'Stop'

$root       = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $root 'var\profile'
$logDir     = Join-Path $root 'var\logs'
$logFile    = Join-Path $logDir 'edge.log'
$base       = "http://127.0.0.1:$Port"

function Get-CdpVersion {
    try { return Invoke-RestMethod -Uri "$base/json/version" -TimeoutSec 2 -ErrorAction Stop }
    catch { return $null }
}

function Get-WorkspaceEdge {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    return @($all | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" })
}

function Get-EdgePath {
    $cands = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    try {
        $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction Stop
        if ($reg.'(default)' -and (Test-Path -LiteralPath $reg.'(default)')) { return $reg.'(default)' }
    }
    catch {}
    return $null
}

# --- 1. already running -> reuse -------------------------------------------
$ver = Get-CdpVersion
if ($ver) {
    Write-Host "Already running, reusing: $($ver.Browser)" -ForegroundColor Green
    Write-Host "  $($ver.webSocketDebuggerUrl)" -ForegroundColor DarkGray
    if ((Get-WorkspaceEdge).Count -eq 0) {
        Write-Host "NOTE: the browser on port $Port was not started by this workspace (profile mismatch)." -ForegroundColor Yellow
        Write-Host "      It works for CDP, but tools\stop-edge.ps1 cannot close it - its profile is not var\profile." -ForegroundColor Yellow
    }
    exit 0
}

# --- 2. profile in use without a debug port -> refuse ----------------------
$existing = Get-WorkspaceEdge
if ($existing.Count -gt 0) {
    Write-Host "$($existing.Count) msedge process(es) use this workspace profile but expose no debug port." -ForegroundColor Yellow
    Write-Host 'One user-data-dir admits one instance; starting another will NOT open the port. Run first:' -ForegroundColor Yellow
    Write-Host '  powershell -NoProfile -File tools\stop-edge.ps1' -ForegroundColor Gray
    exit 1
}

# --- 3. stale listener -> clean it -----------------------------------------
$listener = $null
try { $listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) | Select-Object -First 1 }
catch { $listener = $null }

if ($listener) {
    $ownerPid  = $listener.OwningProcess
    $ownerProc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $ownerName = if ($ownerProc) { $ownerProc.ProcessName } else { '?' }
    if ($ownerName -eq 'msedge') {
        Write-Host "Port $Port held by a stale msedge (pid $ownerPid) that does not answer CDP -> cleaning" -ForegroundColor Yellow
        & (Join-Path $PSScriptRoot 'stop-edge.ps1') -Port $Port -Quiet
        Start-Sleep -Milliseconds 800
    }
    else {
        Write-Host "Port $Port is held by $ownerName (pid $ownerPid), which is not this workspace's browser." -ForegroundColor Red
        Write-Host 'Refusing to touch a process this workspace does not own.' -ForegroundColor Red
        exit 1
    }
}

# --- 4. launch -------------------------------------------------------------
$edge = Get-EdgePath
if (-not $edge) { Write-Host 'msedge.exe not found.' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$edgeArgs = @(
    "--remote-debugging-port=$Port",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=`"$profileDir`"",
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--enable-logging',
    "--log-file=`"$logFile`"",
    'about:blank'
)

Write-Host "Starting: $edge" -ForegroundColor Cyan
Write-Host "  profile  $profileDir" -ForegroundColor DarkGray
Write-Host "  port     $Port (bound to 127.0.0.1 only)" -ForegroundColor DarkGray

$proc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ver = $null

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $ver = Get-CdpVersion
    if ($ver) { break }
    $exited = $false
    try { $exited = $proc.HasExited } catch { $exited = $true }
    if ($exited) { break }
}

# --- 5. result -------------------------------------------------------------
if ($ver) {
    Write-Host ''
    Write-Host "Ready: $($ver.Browser)" -ForegroundColor Green
    Write-Host "  $($ver.webSocketDebuggerUrl)" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Next: node tools\cdp.mjs newtab --tab <your-name> <url>' -ForegroundColor Gray
    Write-Host 'Note: a browser started from an agent session may be reaped with it. For a lasting one, double-click tools\start-edge.cmd.' -ForegroundColor DarkYellow
    exit 0
}

Write-Host ''
Write-Host "FAILED: CDP did not answer within $WaitSeconds s." -ForegroundColor Red

$restricted = $false
if (Test-Path -LiteralPath $logFile) {
    $hits = @(Select-String -LiteralPath $logFile -Pattern 'platform_channel|Access denied \(0x5\)|network_sandbox|Mojo' -ErrorAction SilentlyContinue)
    if ($hits.Count -gt 0) { $restricted = $true }
    Write-Host ''
    Write-Host "Log tail (${logFile}):" -ForegroundColor DarkGray
    Get-Content -LiteralPath $logFile -Tail 15 -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

if ($restricted) {
    Write-Host ''
    Write-Host 'Likely cause: restricted sandbox. Chromium cannot create the named pipes its' -ForegroundColor Yellow
    Write-Host 'multi-process IPC needs (platform_channel.cc:187 Check failed: Access denied 0x5).' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Fix: ask the user to double-click tools\start-edge.cmd - an Explorer-started process' -ForegroundColor Green
    Write-Host 'is outside both the sandbox and the session job tree.' -ForegroundColor Green
}
else {
    Write-Host ''
    Write-Host 'Try: powershell -NoProfile -File tools\doctor.ps1, then tools\stop-edge.ps1 and retry.' -ForegroundColor Gray
}

exit 1
