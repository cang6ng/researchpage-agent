@echo off
rem ---------------------------------------------------------------------------
rem  ResearchPage one-click launch (Windows).
rem
rem  This file is deliberately ASCII-only: every user-facing message is Chinese
rem  and lives in the PowerShell helper below, which sets the console to UTF-8.
rem  It works from any current directory because %~dp0 is where this file sits.
rem ---------------------------------------------------------------------------
setlocal
rem %~dp0 always ends with a backslash, and a backslash right before the closing
rem quote would escape it once this path is passed on as an argument — strip it.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "LAUNCHER=%ROOT%\scripts\windows\start-researchpage.ps1"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

if not exist "%LAUNCHER%" (
  echo [ERROR] Missing launcher script:
  echo         "%LAUNCHER%"
  echo         Keep this file in the repository root next to package.json.
  pause
  exit /b 1
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Root "%ROOT%"
set "CODE=%ERRORLEVEL%"

rem Never vanish on an unexpected outcome: the reason was printed above, and the
rem window stays until a key is pressed so it can be read (and screenshotted).
if not "%CODE%"=="0" (
  echo.
  pause
)
endlocal & exit /b %CODE%
