@echo off
rem  Double-click this file to start ERPL GC-4.
rem
rem  It opens the startup window in tools\gc-launcher.ps1, which is a front end
rem  for `node server\index.js` and nothing more. If the window will not open,
rem  the software still starts from a terminal in this folder:
rem
rem      node server\index.js
rem
setlocal
set "LAUNCHER=%~dp0tools\gc-launcher.ps1"

if not exist "%LAUNCHER%" (
  echo.
  echo   Could not find "%LAUNCHER%".
  echo   Keep this file in the GC-4 folder it shipped in, beside the tools folder.
  echo.
  pause
  exit /b 1
)

rem  Started in a window of its own, then hidden: the launcher draws a real
rem  window, and a console sitting behind it for the whole session is noise.
rem  -ExecutionPolicy Bypass applies to this one process only, so a machine
rem  that has never had its policy loosened can still double-click this.
start "ERPL GC-4" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%LAUNCHER%" -Root "%~dp0."
exit /b 0
