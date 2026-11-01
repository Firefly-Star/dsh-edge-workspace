#requires -Version 5.1
<#
  cdp-common.ps1 - shared helpers for doctor.ps1 / start-edge.ps1 / stop-edge.ps1.
  Dot-source it:  . (Join-Path $PSScriptRoot 'cdp-common.ps1')

  WHY THIS FILE EXISTS
  An agent-run command in this workspace gets a low-integrity token. Measured facts:
    Get-CimInstance Win32_Process   -> Access denied
    Get-NetTCPConnection            -> Access denied
    netstat -ano, Get-Process       -> work
  The three scripts used to swallow those denials with -ErrorAction SilentlyContinue and
  report the result as "nothing is running". Consequence: stop-edge printed
  "Port released." + exit 0 while the browser was still listening, and doctor could never
  enter its stale-port branch. Silent loss of information presented as a clean bill of
  health is worse than an error, so every helper here distinguishes three outcomes:

    known-empty  ("checked: nothing there")
    known-present
    unknown      ("could not check")   <- callers must report this, never map it to empty

  Conventions:
    Get-ListenPid        -> 0 = free, -1 = could not tell, >0 = pid
    Get-WorkspaceEdgeState -> @{ Known = $true/$false; Procs = @(...) }
    Get-*Identity        -> 'ours' | 'foreign' | 'unknown'

  ASCII-only on purpose (see doctor.ps1 header).
#>

$script:CdpProcessQuery = $null

# $true when process command lines are readable (WMI allowed: user-run, or agent outside
# the sandbox). $false under the agent sandbox.
function Test-ProcessQuery {
    if ($null -ne $script:CdpProcessQuery) { return $script:CdpProcessQuery }
    try {
        $null = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop
        $script:CdpProcessQuery = $true
    }
    catch { $script:CdpProcessQuery = $false }
    return $script:CdpProcessQuery
}

# msedge processes whose command line carries this workspace profile.
# Known=$false means the query itself is not permitted - do NOT read that as "none".
function Get-WorkspaceEdgeState {
    param([Parameter(Mandatory)][string]$ProfileDir)
    if (-not (Test-ProcessQuery)) { return @{ Known = $false; Procs = @() } }
    $all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    $hit = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProfileDir*" })
    return @{ Known = $true; Procs = $hit }
}

function Get-CdpVersion {
    param([Parameter(Mandatory)][string]$Base, [int]$TimeoutSec = 3)
    try { return Invoke-RestMethod -Uri "$Base/json/version" -TimeoutSec $TimeoutSec -ErrorAction Stop }
    catch { return $null }
}

# pid listening on $Port: 0 = nothing listens, -1 = could not read the table, >0 = pid.
# netstat is used on purpose - Get-NetTCPConnection is denied under the agent sandbox,
# and netstat needs no elevation. Parsed by splitting on whitespace so the localized
# state column does not matter; a listener is "local :port, foreign 0.0.0.0:0 / [::]:0".
function Get-ListenPid {
    param([Parameter(Mandatory)][int]$Port)
    $lines = @()
    try { $lines = @(netstat -ano -p tcp 2>$null) } catch { return -1 }
    if ($lines.Count -eq 0) { return -1 }
    foreach ($line in $lines) {
        $f = @($line -split '\s+' | Where-Object { $_ -ne '' })
        if ($f.Count -lt 4 -or $f[0] -ne 'TCP') { continue }
        $remote = $f[2]
        if ($remote -ne '0.0.0.0:0' -and $remote -ne '[::]:0') { continue }
        $local = [string]$f[1]
        $i = $local.LastIndexOf(':')
        if ($i -lt 0) { continue }
        if ($local.Substring($i + 1) -ne [string]$Port) { continue }
        $pidStr = [string]$f[$f.Count - 1]
        if ($pidStr -match '^\d+$') { return [int]$pidStr }
        return -1
    }
    return 0
}

# Chromium writes <profile>\DevToolsActivePort while a debug port is open:
#   line 1 = port, line 2 = /devtools/browser/<uuid>
function Get-DevToolsActivePort {
    param([Parameter(Mandatory)][string]$ProfileDir)
    $file = Join-Path $ProfileDir 'DevToolsActivePort'
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $lines = @()
    try { $lines = @(Get-Content -LiteralPath $file -TotalCount 2 -ErrorAction Stop) } catch { return $null }
    if ($lines.Count -lt 1) { return $null }
    $p = ([string]$lines[0]).Trim()
    if ($p -notmatch '^\d+$') { return $null }
    $pathPart = ''
    if ($lines.Count -ge 2) { $pathPart = ([string]$lines[1]).Trim() }
    return @{ Port = [int]$p; Path = $pathPart }
}

# Who answers CDP on the debug port: 'ours' | 'foreign' | 'unknown'.
# Proof of ownership without WMI: the uuid in /json/version must match the uuid Chromium
# wrote into OUR profile's DevToolsActivePort. A missing var\profile proves 'foreign'
# (a browser that had ever used this workspace would have created it).
function Get-BrowserIdentity {
    param(
        [Parameter(Mandatory)][string]$ProfileDir,
        [Parameter(Mandatory)][int]$Port,
        $Version
    )
    if (-not $Version) { return 'unknown' }
    if (-not (Test-Path -LiteralPath $ProfileDir)) { return 'foreign' }
    $dap = Get-DevToolsActivePort -ProfileDir $ProfileDir
    if (-not $dap) { return 'unknown' }
    if ($dap.Port -ne $Port) { return 'unknown' }   # profile's last debug port was another port
    $ws = ''
    if ($Version.webSocketDebuggerUrl) { $ws = [string]$Version.webSocketDebuggerUrl }
    if ($dap.Path -and $ws -and $ws.EndsWith($dap.Path)) { return 'ours' }
    if (-not $dap.Path) { return 'unknown' }
    return 'foreign'
}

# Who holds the port when CDP does NOT answer: 'ours' when our profile's
# DevToolsActivePort names this same port, 'foreign' when the profile never existed,
# else 'unknown'. Used for the stale-port case, where /json/version cannot be asked.
function Get-StaleListenerIdentity {
    param([Parameter(Mandatory)][string]$ProfileDir, [Parameter(Mandatory)][int]$Port)
    if (-not (Test-Path -LiteralPath $ProfileDir)) { return 'foreign' }
    $dap = Get-DevToolsActivePort -ProfileDir $ProfileDir
    if ($dap -and $dap.Port -eq $Port) { return 'ours' }
    return 'unknown'
}

# Printable name for a pid, or '?' when the process is not visible to us.
function Get-PidName {
    param([Parameter(Mandatory)][int]$ProcessId)
    try { return (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName } catch { return '?' }
}
