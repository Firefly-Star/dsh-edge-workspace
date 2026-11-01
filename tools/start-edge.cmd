@echo off
rem Double-click this file to start the workspace Edge browser.
rem A process started from Explorer is not part of the agent session job tree,
rem so it survives session teardown -- that is why this is the recommended way.
setlocal
cd /d "%~dp0.."
where pwsh >nul 2>nul && goto :usepwsh
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-edge.ps1" %*
goto :done
:usepwsh
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-edge.ps1" %*
:done
echo.
echo Press any key to close this window (the browser keeps running).
pause >nul
