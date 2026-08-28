@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 exit /b 1
)
echo Starting LinkedInRec on http://localhost:5177
call npm.cmd start
endlocal
