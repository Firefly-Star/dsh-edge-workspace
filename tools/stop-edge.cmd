@echo off
rem Double-click this file to stop the workspace Edge browser.
rem It only matches processes that use this workspace profile,
rem so your everyday Edge is never touched.
setlocal
cd /d "%~dp0.."
where pwsh >nul 2>nul && goto :usepwsh
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-edge.ps1" %*
goto :done
:usepwsh
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-edge.ps1" %*
:done
echo.
pause >nul
