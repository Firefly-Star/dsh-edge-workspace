#requires -Version 5.1
<#
  doctor.ps1 - health check for this workspace.
  Read-only: starts nothing, closes nothing, kills nothing. At most it creates empty var\ dirs.
  Exit 0 = usable (browser running, or cleanly stopped). Exit 1 = fix something first.

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a CJK
  literal in a .ps1 breaks the parse, and editing tools strip the BOM. Docs stay Chinese,
  code stays ASCII. Keep it that way.
#>
[CmdletBinding()]
param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'

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

function Get-CdpVersion {
    try { return Invoke-RestMethod -Uri "$base/json/version" -TimeoutSec 3 -ErrorAction Stop }
    catch { return $null }
}

function Get-WorkspaceEdge {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    return @($all | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileDir*" })
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
$listener = $null
try {
    $listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) | Select-Object -First 1
}
catch { $listener = $null }

$ver   = Get-CdpVersion
$procs = Get-WorkspaceEdge

$verdict = 'STOPPED'
if ($ver) {
    $verdict = 'RUNNING'
    $verStr = if ($ver.Browser) { $ver.Browser } else { 'unknown' }
    Write-Row "port $Port" 'ok' "listening, CDP responds ($verStr)"
    if ($procs.Count -eq 0) {
        Write-Row 'browser owner' 'warn' 'this browser was NOT started by this workspace (foreign profile)'
    }
}
elseif ($listener) {
    $verdict = 'STALE'
    $ownerPid = $listener.OwningProcess
    $owner = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
    $ownerName = if ($owner) { $owner.ProcessName } else { '?' }
    Write-Row "port $Port" 'fail' "listening but CDP silent (pid $ownerPid / $ownerName) - stale port"
    $problems.Add('stale port')
}
elseif ($procs.Count -gt 0) {
    $verdict = 'ORPHAN'
    Write-Row "port $Port" 'fail' "not listening, but $($procs.Count) msedge process(es) use this workspace profile"
    $problems.Add('orphan browser process')
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
        $pages = @(Invoke-RestMethod -Uri "$base/json/list" -TimeoutSec 3 -ErrorAction Stop |
            Where-Object { $_.type -eq 'page' -and -not ([string]$_.url).StartsWith('devtools://') })
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
        Write-Host '  powershell -NoProfile -File tools\start-edge.ps1   (from an agent; may be reaped)' -ForegroundColor Gray
    }
    'STALE' {
        Write-Host 'RESULT: stale port. Run tools\stop-edge.ps1, then start again.' -ForegroundColor Red
    }
    'ORPHAN' {
        Write-Host 'RESULT: Edge is using this profile but has no debug port. Run tools\stop-edge.ps1 first.' -ForegroundColor Red
    }
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host 'Must fix first:' -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

if (-not $nodeOk -and $verdict -ne 'RUNNING') { exit 1 }
exit 0
