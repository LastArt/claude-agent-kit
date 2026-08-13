@echo off
REM Claude Agent Kit - double-click installer for Windows.
REM Wraps install.ps1 so nobody has to open a terminal or remember the
REM ExecutionPolicy flag. ASCII-only on purpose: .bat files are read in the
REM console codepage, and non-ASCII text here would be mojibake at best.
setlocal
cd /d "%~dp0"

if not exist "%~dp0install.ps1" (
  echo ERROR: install.ps1 not found next to this file.
  echo Run this from the unpacked kit folder.
  goto :done
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo Installation FAILED with exit code %EXITCODE%.
  echo If Windows blocked the files, right-click the ZIP you downloaded,
  echo open Properties and tick "Unblock", then unpack it again.
)

:done
echo.
echo Read the steps above. Press any key to open the guide and close this window...
pause >nul
REM Open the guide only after the user has read the terminal, and only on success.
if "%EXITCODE%"=="0" if exist "%USERPROFILE%\.claude\agent-kit\guide.html" start "" "%USERPROFILE%\.claude\agent-kit\guide.html"
exit /b %EXITCODE%
