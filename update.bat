@echo off
REM Claude Agent Kit - update: pull the latest from GitHub and reinstall.
REM ASCII-only on purpose: .bat is read in the console codepage, non-ASCII would be mojibake.
REM Separate from install.bat because the installer copies THIS folder into ~/.claude/agent-kit.
REM If the folder is an old clone, a plain reinstall just re-copies the old version - so we
REM refresh the clone first (git pull), then run the installer.
setlocal
cd /d "%~dp0"

echo Claude Agent Kit - update
echo.

if exist "%~dp0.git" (
  echo   Pulling the latest from GitHub...
  git pull --ff-only
  if errorlevel 1 (
    echo   ! git pull failed ^(local changes, or git not installed^).
    echo     Run "git status" to sort it out, or download a fresh ZIP from GitHub.
  )
) else (
  echo   Not a git clone - cannot refresh the source automatically.
  echo   Download a fresh ZIP: https://github.com/LastArt/claude-agent-kit ^(Code -^> Download ZIP^),
  echo   unpack it over this folder, then run install.bat.
)

echo.
echo   Reinstalling the kit from this folder...
echo.
call "%~dp0install.bat"

echo.
echo Done. In each project that uses the kit, run /cckit_update to pull the new version.
exit /b %ERRORLEVEL%
