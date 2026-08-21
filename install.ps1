# Claude Agent Kit - installer (Windows / PowerShell)
# Copies the kit and the global commands into the current user's home folder.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 in the system codepage,
# so non-ASCII text here would break parsing. Keep messages ASCII.
# Run:  powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'

# Commands that must work in ANY folder. Everything else in .claude/commands stays
# project-scoped: those commands only make sense where the kit is deployed.
$GLOBAL_COMMANDS = @('cckit_new-project', 'cckit_install', 'cckit_update', 'cckit_help', 'cckit_get_instruction', 'cckit_uninstall')

$src  = $PSScriptRoot                                   # kit folder (where this script lives)
$dest = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# 1) Master kit -> ~/.claude/agent-kit (fully refreshed)
$kit = Join-Path $dest 'agent-kit'
if (Test-Path $kit) { Remove-Item -Recurse -Force $kit }
Copy-Item -Recurse (Join-Path $src '.claude') $kit

# Files that belong to THIS repository only and must never travel into user projects:
#   settings.local.json - permissions granted on this machine
#   CLAUDE.md           - instructions for developing the kit itself
foreach ($name in @('settings.local.json', 'CLAUDE.md')) {
  $p = Join-Path $kit $name
  if (Test-Path $p) { Remove-Item -Force $p }
}

# Machine-local acceptance files: a run report, a confirmed command block and a gate state
# belong to THIS machine only. Shipping them would start every new project with someone
# else's "accepted" and with the output of someone else's tests.
foreach ($name in @('artifacts\VERIFY.json', 'artifacts\VERIFY.lock', 'artifacts\GATE_STATE.json')) {
  $p = Join-Path $kit $name
  if (Test-Path $p) { Remove-Item -Force $p }
}

# PROJECT_PROFILE.md in this repo describes the KIT itself. Shipping it would give every
# new project a profile full of someone else's facts, so the master copy always carries
# the blank template instead.
$template = Join-Path $kit 'PROJECT_PROFILE.template.md'
if (Test-Path $template) {
  Copy-Item -Force $template (Join-Path $kit 'PROJECT_PROFILE.md')
  Remove-Item -Force $template
}
$kitVersion = 'unknown'
$versionFile = Join-Path $kit 'VERSION'
if (Test-Path $versionFile) { $kitVersion = (Get-Content $versionFile -TotalCount 1).Trim() }
Write-Host "  + master kit:  $kit (version $kitVersion)" -ForegroundColor Green

# 2) Global commands -> ~/.claude/commands (single source: .claude/commands)
$cmds = Join-Path $dest 'commands'
New-Item -ItemType Directory -Force -Path $cmds | Out-Null
$installed = @()
foreach ($name in $GLOBAL_COMMANDS) {
  $file = Join-Path $src ".claude\commands\$name.md"
  if (Test-Path $file) { Copy-Item -Force $file $cmds; $installed += "/$name" }
  else { Write-Host "  ! missing: .claude\commands\$name.md" -ForegroundColor Yellow }
}
Write-Host "  + commands:    $($installed -join ', ')" -ForegroundColor Green

# 3) Hooks are launched through node. Without it they silently do nothing.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Host "  + node:        $(node --version)" -ForegroundColor Green
} else {
  Write-Host "  ! node not found - the syntax check hook will not run. Install Node.js." -ForegroundColor Yellow
}

Write-Host ""
# The banner lives in the kit and prints the logo and version. Its output is not parsed
# by PowerShell, so non-ASCII text there is fine - unlike in this file.
$banner = Join-Path $kit 'hooks\banner.mjs'
if ($node -and (Test-Path $banner)) { & node $banner }

# Guide page + branded desktop shortcut. NOT opened here - install.bat opens it AFTER the
# keypress, so the terminal instructions are read first. Desktop path via .NET handles OneDrive.
$guide = Join-Path $kit 'hooks\make-guide.mjs'
if ($node -and (Test-Path $guide)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  & node $guide --desktop "$desktop"
}

# The full next-steps are printed by the banner above (in Russian). This is a fallback line
# for the rare case where Node is missing and the banner did not run.
if (-not $node) {
  Write-Host ""
  Write-Host "Done. Install Node.js, then RESTART Claude Code. New project: /cckit_new-project <name>" -ForegroundColor Cyan
}
