#requires -Version 5.1
<#
  stop-edge.ps1 - close the workspace Edge.

  Two ways to find "our" browser, because the agent sandbox denies WMI:
    * command lines readable (user-run, or agent outside the sandbox): match only
      processes whose command line carries this workspace profile - exact, as before.
    * command lines denied (agent-run): fall back to the pid holding the port, and kill it
      ONLY when ownership is proven (the uuid Chromium wrote into our own profile's
      DevToolsActivePort matches the live endpoint). Otherwise refuse - closing a browser
      we cannot identify could kill someone else's session.

  The old version treated "could not query" as "nothing running" and printed
  "Port released." while the browser was still listening. It now re-reads the port and
  reports what it actually sees.

  ASCII-only on purpose (see doctor.ps1 header).
#>
[CmdletBinding()]
param([int]$Port = 9222, [switch]$Quiet)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cdp-common.ps1')

$root       = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $root 'var\profile'
$base       = "http://127.0.0.1:$Port"

function Write-Act {
    param([string]$Text, [string]$Color = 'Cyan')
    if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}

$edgeSt = Get-WorkspaceEdgeState -ProfileDir $profileDir

if ($edgeSt.Known) {
    # ---- full process query: kill every msedge carrying our profile ----------
    $total = 0
    for ($pass = 1; $pass -le 3; $pass++) {
        $cur = Get-WorkspaceEdgeState -ProfileDir $profileDir
        if (-not $cur.Known) { break }
        if ($cur.Procs.Count -eq 0) { break }
        $total += $cur.Procs.Count
        Write-Act "Pass ${pass}: closing $($cur.Procs.Count) process(es)"
        foreach ($p in $cur.Procs) {
            Write-Act "  pid $($p.ProcessId)" 'DarkGray'
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
        }
        Start-Sleep -Milliseconds 700
    }

    $left = Get-WorkspaceEdgeState -ProfileDir $profileDir
    if ($left.Known -and $left.Procs.Count -gt 0) {
        Write-Host "$($left.Procs.Count) process(es) still alive (permission?). Remaining pids:" -ForegroundColor Red
        $left.Procs | ForEach-Object { Write-Host "  $($_.ProcessId)" -ForegroundColor Red }
        exit 1
    }
    if ($total -eq 0) { Write-Act 'No workspace Edge was running.' 'Green' }
    else { Write-Act "Closed $total process(es)." 'Green' }
}
else {
    # ---- process query denied: act only on proof from netstat + profile ------
    $ver    = Get-CdpVersion -Base $base -TimeoutSec 2
    $listen = Get-ListenPid -Port $Port        # 0 free / -1 unknown / >0 pid

    if ($listen -lt 0) {
        Write-Host 'Could not read the TCP table (netstat failed); cannot tell what is running.' -ForegroundColor Red
        exit 1
    }

    if ($listen -eq 0) {
        if (-not (Test-Path -LiteralPath $profileDir)) {
            Write-Act 'No workspace Edge has ever run here (var\profile missing). Nothing to stop.' 'Green'
            exit 0
        }
        Write-Host 'Nothing is listening on the debug port, but process command lines are not' -ForegroundColor Yellow
        Write-Host 'readable here (low-integrity token), so a browser could still hold var\profile' -ForegroundColor Yellow
        Write-Host 'without a debug port. Close it manually, or double-click tools\stop-edge.cmd' -ForegroundColor Yellow
        Write-Host 'from Explorer, where the full process query works.' -ForegroundColor Yellow
        exit 1
    }

    $ownerName = Get-PidName -ProcessId $listen
    if ($ver) { $who = Get-BrowserIdentity -ProfileDir $profileDir -Port $Port -Version $ver }
    else { $who = Get-StaleListenerIdentity -ProfileDir $profileDir -Port $Port }

    # Two kinds of proof, and only these:
    #   live endpoint  -> the uuid it reports matches our profile's DevToolsActivePort
    #   dead endpoint  -> our DevToolsActivePort names this port AND an msedge holds it
    # The second half matters: the profile's last debug port is only a hint that our
    # Edge died here; if some other program grabbed the port since, the pid is not msedge
    # and it is not ours to kill.
    $proven = $false
    if ($who -eq 'ours') {
        if ($ver) { $proven = $true }
        elseif ($ownerName -eq 'msedge') { $proven = $true }
    }

    if (-not $proven) {
        Write-Host "Port $Port is held by pid $listen ($ownerName), and this workspace cannot prove it owns it." -ForegroundColor Red
        if ($who -eq 'ours') {
            Write-Host 'The port was last used by this workspace, but the process holding it is not msedge -' -ForegroundColor Red
            Write-Host 'something else grabbed it after our browser died.' -ForegroundColor Red
        }
        elseif ($ownerName -eq 'msedge') {
            Write-Host 'It is an msedge, but with a different profile - killing it would close someone else''s browser.' -ForegroundColor Red
        }
        Write-Host 'Refusing to touch it. If it really is this workspace''s browser, double-click' -ForegroundColor Yellow
        Write-Host 'tools\stop-edge.cmd from Explorer (full process query works there).' -ForegroundColor Yellow
        exit 1
    }

    Write-Act "Closing pid $listen ($ownerName) - ownership proven via var\profile\DevToolsActivePort"
    try { Stop-Process -Id $listen -Force -ErrorAction Stop }
    catch {
        Write-Host "Could not stop pid $listen : $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
    Start-Sleep -Milliseconds 800
    Write-Act 'Closed 1 process.' 'Green'
}

# --- did the port actually come free? --------------------------------------
$after = Get-ListenPid -Port $Port
if ($after -gt 0) {
    Write-Host "Port $Port is still held by pid $after ($(Get-PidName -ProcessId $after)) - not this workspace's process, left alone." -ForegroundColor Red
    exit 1
}
if ($after -lt 0) {
    Write-Host 'Could not re-read the TCP table; port state unknown.' -ForegroundColor Yellow
    exit 1
}

Write-Act 'Port released.' 'Green'

# Browser is fully down: archive tab records that no longer belong to a live page.
# Only done here (and by 'cdp.mjs prune') - never while pages are still open.
if (-not $Quiet) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        try {
            Write-Host 'Archiving tab records of closed pages...' -ForegroundColor DarkGray
            & $nodeCmd.Source (Join-Path $PSScriptRoot 'cdp.mjs') prune | Out-String | Write-Host
        }
        catch { Write-Host 'Archive step skipped (cdp.mjs prune failed).' -ForegroundColor DarkYellow }
    }
}

exit 0
