@echo off
@rem OMP Workspace launcher
node "%~dp0launch.mjs" %*
if errorlevel 1 exit /b 1
