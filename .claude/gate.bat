@echo off
REM Claude Agent Kit - acceptance checks menu (Windows).
REM ASCII-only on purpose: .bat is read in the console codepage, non-ASCII would be mojibake.
REM The menu itself lives in hooks/gate-menu.mjs and prints Russian - hence the UTF-8 codepage below.
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

node "%~dp0hooks\gate-menu.mjs"

REM Keep the window open: launched by double click or by "start", it would vanish instantly.
pause
