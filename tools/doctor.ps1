#requires -Version 5.1
<#
  doctor.ps1 - health check for this workspace.
  Read-only: starts nothing, closes nothing, kills nothing. At most it creates empty var\ dirs.
  Exit 0 = usable (browser running, or cleanly stopped). Exit 1 = fix something first.

  Three-way honesty: "no listener" and "could not check" are different answers. An agent
  run gets a low-integrity token, where WMI and Get-NetTCPConnection are denied; see
  cdp-common.ps1. When a check is impossible the row says so instead of claiming clean.

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a CJK
  literal in a .ps1 breaks the parse, and editing tools strip the BOM. Docs stay Chinese,
  code stays ASCII. Keep it that way.
#>
[CmdletBinding()]
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cdp-common.ps1')

$root       = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $root 'var\profile'
$base       = "http://127.0.0.1:$Port"
$problems   = New-Object 'System.Collections.Generic.List[string]'

function Write-Row {
    param([string]$Name, [string]$State, [string]$Detail)
    $map = @{
        ok   = @('[ OK ]', 'Green')
        warn = @('[WARN]', 'Yellow')
        fail = @('[FAIL]', 'Red')
        info = @('[INFO]', 'Gray')
    }
    $pair = $map[$State]
    if (-not $pair) { $pair = $map['info'] }
    Write-Host ("{0} {1,-15} {2}" -f $pair[0], $Name, $Detail) -ForegroundColor $pair[1]
}

Write-Host ''
Write-Host "Edge/CDP workspace health check  -  $root" -ForegroundColor Cyan
Write-Host ('-' * 68) -ForegroundColor DarkGray

# --- 1. node ---------------------------------------------------------------
$nodeOk = $false
try {
    $nv = (& node -v 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $nv) { throw 'node -v failed' }
    $major = [int]($nv.TrimStart('v').Split('.')[0])
    if ($major -lt 22) {
        Write-Row 'node' 'fail' "$nv - need >= 22 (global WebSocket)"
        $problems.Add('node too old')
    }
    else {
        $ws = (& node -e "process.stdout.write(typeof WebSocket)" 2>$null | Out-String).Trim()
        if ($ws -ne 'function') {
            Write-Row 'node' 'fail' "$nv - global WebSocket missing, cdp.mjs cannot run"
            $problems.Add('node lacks WebSocket')
        }
        else { Write-Row 'node' 'ok' "$nv, WebSocket available"; $nodeOk = $true }
    }
}
catch {
    Write-Row 'node' 'fail' 'node not found in PATH'
    $problems.Add('node missing')
}

# --- 2. edge ---------------------------------------------------------------
$edge = $null
$cands = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $edge = $c; break } }
if (-not $edge) {
    try {
        $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction Stop
        if ($reg.'(default)' -and (Test-Path -LiteralPath $reg.'(default)')) { $edge = $reg.'(default)' }
    }
    catch {}
}
if ($edge) { Write-Row 'edge' 'ok' $edge }
else { Write-Row 'edge' 'fail' 'msedge.exe not found'; $problems.Add('Edge missing') }

# --- 3. dirs ---------------------------------------------------------------
foreach ($d in @('var', 'var\logs', 'var\artifacts', 'var\tabs')) {
    $full = Join-Path $root $d
    if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Path $full -Force | Out-Null }
}
Write-Row 'var dirs' 'ok' 'var\  var\logs  var\artifacts  var\tabs'

# --- 4. port / service -----------------------------------------------------
$ver     = Get-CdpVersion -Base $base -TimeoutSec 3
$listen  = Get-ListenPid -Port $Port          # 0 free / -1 unknown / >0 pid
$edgeSt  = Get-WorkspaceEdgeState -ProfileDir $profileDir
$verdict = 'STOPPED'
$unknownWhy = ''

if ($ver) {
    $verdict = 'RUNNING'
    $verStr = if ($ver.Browser) { $ver.Browser } else { 'unknown' }
    Write-Row "port $Port" 'ok' "listening, CDP responds ($verStr)"
    $who = Get-BrowserIdentity -ProfileDir $profileDir -Port $Port -Version $ver
    if ($who -eq 'ours') {
        Write-Row 'browser owner' 'ok' 'started by this workspace (var\profile)'
    }
    elseif ($who -eq 'foreign') {
        Write-Row 'browser owner' 'warn' 'NOT this workspace: its profile is not var\profile'
    }
    else {
        Write-Row 'browser owner' 'info' 'cannot verify owner here (no matching DevToolsActivePort)'
    }
}
elseif ($listen -gt 0) {
    $verdict = 'STALE'
    $ownerName = Get-PidName -ProcessId $listen
    Write-Row "port $Port" 'fail' "listening but CDP silent (pid $listen / $ownerName) - stale port"
    $problems.Add('stale port')
}
elseif ($listen -lt 0) {
    $verdict = 'UNKNOWN'
    $unknownWhy = 'tcp'
    Write-Row "port $Port" 'warn' 'could not read the TCP table (netstat failed) - state unknown'
}
elseif ($edgeSt.Known -and $edgeSt.Procs.Count -gt 0) {
    $verdict = 'ORPHAN'
    Write-Row "port $Port" 'fail' "not listening, but $($edgeSt.Procs.Count) msedge process(es) use this workspace profile"
    $problems.Add('orphan browser process')
}
elseif (-not $edgeSt.Known) {
    # Nothing listens, and process command lines are unreadable. Say only what is provable.
    if (-not (Test-Path -LiteralPath $profileDir)) {
        Write-Row "port $Port" 'info' 'not listening; var\profile does not exist, so no browser of ours exists'
    }
    else {
        $edgeCount = @(Get-Process msedge -ErrorAction SilentlyContinue).Count
        if ($edgeCount -eq 0) {
            Write-Row "port $Port" 'info' 'not listening, and no msedge is running (clean)'
        }
        else {
            $verdict = 'UNKNOWN'
            $unknownWhy = 'owner'
            Write-Row "port $Port" 'info' "not listening; $edgeCount msedge process(es) exist but ownership is unverifiable here"
        }
    }
}
else {
    Write-Row "port $Port" 'info' 'not listening (browser stopped - normal state)'
}

# --- 5. profile ------------------------------------------------------------
if (Test-Path -LiteralPath $profileDir) {
    $size = 0
    try {
        $sum = (Get-ChildItem -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($sum) { $size = [math]::Round($sum / 1MB, 1) }
    }
    catch {}
    Write-Row 'profile' 'ok' "present (${size} MB) - holds login state, treat as a password"
}
else { Write-Row 'profile' 'info' 'not created yet (created on first start)' }

# --- 6. tabs ---------------------------------------------------------------
if ($verdict -eq 'RUNNING') {
    try {
        # Assign first, filter second. In PowerShell 5.1 Invoke-RestMethod hands a JSON
        # array to the pipeline as ONE object (no enumeration), so piping it straight into
        # Where-Object tests the whole array -- member enumeration makes the condition true
        # and the array itself passes as a single item. Result: the count was always 1.
        $raw = Invoke-RestMethod -Uri "$base/json/list" -TimeoutSec 3 -ErrorAction Stop
        $pages = @($raw | Where-Object { $_.type -eq 'page' -and -not ([string]$_.url).StartsWith('devtools://') })
        $claims = 0
        try { $claims = @(Get-ChildItem -LiteralPath (Join-Path $root 'var\tabs') -Filter *.json -ErrorAction Stop).Count } catch {}
        Write-Row 'tabs' 'ok' "$($pages.Count) page(s), $claims claimed"
    }
    catch { Write-Row 'tabs' 'warn' 'could not list tabs' }
}

Write-Host ('-' * 68) -ForegroundColor DarkGray

# --- verdict ---------------------------------------------------------------
switch ($verdict) {
    'RUNNING' {
        Write-Host 'RESULT: browser is up, claim a tab and go.' -ForegroundColor Green
        Write-Host '  node tools\cdp.mjs newtab --tab <your-name> <url>' -ForegroundColor Gray
    }
    'STOPPED' {
        Write-Host 'RESULT: clean, browser not running.' -ForegroundColor Green
        Write-Host '  tools\start-edge.cmd                          (double-click; survives session teardown, recommended)' -ForegroundColor Gray
        Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-edge.ps1   (from an agent; may be reaped)' -ForegroundColor Gray
    }
    'STALE' {
        Write-Host 'RESULT: stale port. Run tools\stop-edge.ps1, then start again.' -ForegroundColor Red
    }
    'ORPHAN' {
        Write-Host 'RESULT: Edge is using this profile but has no debug port. Run tools\stop-edge.ps1 first.' -ForegroundColor Red
    }
    default {
        if ($unknownWhy -eq 'tcp') {
            Write-Host 'RESULT: the TCP table could not be read, so the port state is unknown.' -ForegroundColor Yellow
            Write-Host '  Run doctor.ps1 from a normal PowerShell window, or check: netstat -ano' -ForegroundColor Gray
        }
        else {
            Write-Host 'RESULT: nothing answers CDP - there is nothing to drive right now.' -ForegroundColor Yellow
            Write-Host '  Start it: double-click tools\start-edge.cmd' -ForegroundColor Gray
            Write-Host '  (this shell cannot read WMI, so it cannot tell whether an Edge still holds' -ForegroundColor Gray
            Write-Host '   var\profile; if a start fails, run doctor.ps1 from a normal PowerShell window)' -ForegroundColor Gray
        }
    }
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host 'Must fix first:' -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

if (-not $nodeOk) { exit 1 }
exit 0
