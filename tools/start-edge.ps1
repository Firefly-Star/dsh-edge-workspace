#requires -Version 5.1
<#
  start-edge.ps1 - idempotent start of the workspace Edge with the CDP debug port.
  Already running -> reuse. Stale port -> clean it. Process using our profile without the
  debug port -> refuse (a second instance on the same user-data-dir ignores the flag).

  Ownership is decided by cdp-common.ps1. When run by an agent (low-integrity token) the
  process query is denied, so the "profile already in use" check is skipped LOUDLY instead
  of silently passing - and a port held by something we cannot prove is ours is refused,
  never killed.

  Lifetime: Start-Process here keeps the browser inside the caller's job tree. Started from
  an agent session it can be reaped when the session ends. For a browser that stays, the
  user should double-click tools\start-edge.cmd (Explorer-started parents are not reaped).

  ASCII-only on purpose (see doctor.ps1 header).
#>
[CmdletBinding()]
param([int]$Port = 9222, [int]$WaitSeconds = 30)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cdp-common.ps1')

$root       = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $root 'var\profile'
$logDir     = Join-Path $root 'var\logs'
$logFile    = Join-Path $logDir 'edge.log'
$base       = "http://127.0.0.1:$Port"

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
$ver = Get-CdpVersion -Base $base -TimeoutSec 2
if ($ver) {
    Write-Host "Already running, reusing: $($ver.Browser)" -ForegroundColor Green
    Write-Host "  $($ver.webSocketDebuggerUrl)" -ForegroundColor DarkGray
    $who = Get-BrowserIdentity -ProfileDir $profileDir -Port $Port -Version $ver
    if ($who -eq 'foreign') {
        Write-Host "NOTE: the browser on port $Port was not started by this workspace (profile mismatch)." -ForegroundColor Yellow
        Write-Host "      It works for CDP, but tools\stop-edge.ps1 cannot close it - its profile is not var\profile." -ForegroundColor Yellow
    }
    elseif ($who -eq 'unknown') {
        Write-Host "NOTE: could not verify who owns port $Port (no matching DevToolsActivePort in var\profile)." -ForegroundColor DarkYellow
        Write-Host "      It answers CDP, so it is reusable either way." -ForegroundColor DarkYellow
    }
    exit 0
}

# --- 2. profile in use without a debug port -> refuse ----------------------
$edgeSt = Get-WorkspaceEdgeState -ProfileDir $profileDir
if (-not $edgeSt.Known) {
    Write-Host 'NOTE: process command lines are not readable here (low-integrity token),' -ForegroundColor DarkYellow
    Write-Host '      so the "profile already in use" check cannot run. If Edge opens without a' -ForegroundColor DarkYellow
    Write-Host '      debug port, close it and use tools\start-edge.cmd from Explorer instead.' -ForegroundColor DarkYellow
}
elseif ($edgeSt.Procs.Count -gt 0) {
    Write-Host "$($edgeSt.Procs.Count) msedge process(es) use this workspace profile but expose no debug port." -ForegroundColor Yellow
    Write-Host 'One user-data-dir admits one instance; starting another will NOT open the port. Run first:' -ForegroundColor Yellow
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-edge.ps1' -ForegroundColor Gray
    exit 1
}

# --- 3. stale listener -> clean it -----------------------------------------
$listen = Get-ListenPid -Port $Port        # 0 free / -1 unknown / >0 pid
if ($listen -lt 0) {
    Write-Host "WARNING: could not read the TCP table (netstat failed); assuming port $Port is free." -ForegroundColor Yellow
}
elseif ($listen -gt 0) {
    $ownerName = Get-PidName -ProcessId $listen
    $who = Get-StaleListenerIdentity -ProfileDir $profileDir -Port $Port
    if ($ownerName -eq 'msedge' -and $who -eq 'ours') {
        Write-Host "Port $Port held by a stale msedge (pid $listen) that does not answer CDP -> cleaning" -ForegroundColor Yellow
        & (Join-Path $PSScriptRoot 'stop-edge.ps1') -Port $Port -Quiet
        Start-Sleep -Milliseconds 800
        $again = Get-ListenPid -Port $Port
        if ($again -gt 0) {
            Write-Host "Port $Port is still held (pid $again). Stopping here; run tools\stop-edge.ps1, then retry." -ForegroundColor Red
            exit 1
        }
    }
    else {
        Write-Host "Port $Port is held by $ownerName (pid $listen), which this workspace cannot prove it owns." -ForegroundColor Red
        if ($ownerName -eq 'msedge' -and $who -ne 'ours') {
            Write-Host "It is an msedge, but with a different profile - closing it would kill someone else's browser." -ForegroundColor Red
        }
        Write-Host 'Refusing to touch a process this workspace does not own. Free the port first.' -ForegroundColor Red
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
    $ver = Get-CdpVersion -Base $base -TimeoutSec 2
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

# Say what the port looks like now - this is the state doctor/stop-edge must deal with next.
$listen = Get-ListenPid -Port $Port
if ($listen -gt 0) {
    Write-Host ''
    Write-Host "Port $Port is held by pid $listen ($(Get-PidName -ProcessId $listen)) but nothing answers CDP." -ForegroundColor Yellow
    Write-Host 'That is the stale-port case: run tools\stop-edge.ps1 before retrying.' -ForegroundColor Yellow
}
elseif ($listen -eq 0) {
    Write-Host ''
    Write-Host "Port $Port is free (the failed instance left nothing behind)." -ForegroundColor DarkGray
}
else {
    Write-Host ''
    Write-Host "Could not read the TCP table; port state unknown." -ForegroundColor Yellow
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
    Write-Host 'Try: powershell -NoProfile -ExecutionPolicy Bypass -File tools\doctor.ps1, then tools\stop-edge.ps1 and retry.' -ForegroundColor Gray
}

exit 1
