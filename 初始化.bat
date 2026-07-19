@echo off
setlocal EnableExtensions
if /I "%~1"=="--dry-run" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\reset-dev.ps1" -DryRun
) else if /I "%~1"=="--yes" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\reset-dev.ps1" -Yes
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\reset-dev.ps1"
)
set "EXIT_CODE=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %EXIT_CODE%
