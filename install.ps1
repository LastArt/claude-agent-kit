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
#
# Copy strictly by the ship.list whitelist: anything not listed does not travel. The old way
# copied the whole .claude folder and deleted the unwanted bits afterwards, and that blacklist
# fell behind on every new file - which is how working artifacts and generated pages ended up
# in other people's projects.
$kit = Join-Path $dest 'agent-kit'
if (Test-Path $kit) { Remove-Item -Recurse -Force $kit }
New-Item -ItemType Directory -Force -Path $kit | Out-Null

$shipList = Join-Path $src '.claude\ship.list'
if (-not (Test-Path $shipList)) {
  Write-Host "  ! no ship.list next to the installer - nothing tells me what to copy. Aborting." -ForegroundColor Red
  exit 1
}

foreach ($raw in Get-Content $shipList) {
  $entry = ($raw -split '#', 2)[0].Trim()
  if ($entry -eq '') { continue }
  $isDir = $entry.EndsWith('/')
  $name  = $entry.TrimEnd('/')
  $from  = Join-Path (Join-Path $src '.claude') $name
  if (-not (Test-Path $from)) {
    Write-Host "  ! ship.list asks for '$entry' but it does not exist - skipping" -ForegroundColor Yellow
    continue
  }
  $to = Join-Path $kit $name
  if ($isDir) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Copy-Item -Recurse -Force (Join-Path $from '*') $to
  } else {
    Copy-Item -Force $from $to
  }
}

# Working files (plan, review, audit, explore cache) do not exist in the kit sources at all -
# only the reference stubs in assets/stubs do. A dedicated hook materialises them: one piece of
# logic shared by both installers and by the repository itself, instead of three copies.
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node (Join-Path $kit 'hooks\stubs.mjs') --force | Out-Null
} else {
  Write-Host "  ! node not found - PLAN/REVIEW/SECURITY stubs were not placed." -ForegroundColor Yellow
  Write-Host "    Install Node.js, then run: node $kit\hooks\stubs.mjs" -ForegroundColor Yellow
}

# Task folders must not live in the master copy. It is handed out to every new project, and a
# single task run straight inside ~/.claude/agent-kit would carry someone else's PLAN, SECURITY
# and REVIEW into all of them. The tasks/ACTIVE pointer stays - it is empty and belongs there.
#
# Honest note: this block duplicates the "Remove-Item -Recurse -Force $kit" above. Today the
# master copy is wiped before copying anyway, so a planted folder would disappear without this
# block. It exists as insurance in case installing ever stops meaning "wipe and lay out again".
$tasksDir = Join-Path $kit 'tasks'
if (Test-Path $tasksDir) {
  $stray = @(Get-ChildItem -Path $tasksDir -Directory -ErrorAction SilentlyContinue)
  if ($stray.Count -gt 0) {
    foreach ($t in $stray) { Remove-Item -Recurse -Force $t.FullName }
    Write-Host "  ! removed task folders from the master copy: $($stray.Count) (tasks live in projects, not in the kit)" -ForegroundColor Yellow
  }
}

# PROJECT_PROFILE.md in this repo describes the KIT itself. Shipping it would give every
# new project a profile full of someone else's facts, so the master copy always carries
# the blank template instead.
$template = Join-Path $kit 'PROJECT_PROFILE.template.md'
if (Test-Path $template) {
  Copy-Item -Force $template (Join-Path $kit 'PROJECT_PROFILE.md')
  Remove-Item -Force $template
}

# Postcondition: the whitelist may have fallen behind the kit structure. Check what the kit
# cannot live without - aborting loudly here beats leaving a half-installed kit behind.
foreach ($must in @('VERSION', 'settings.json', 'ORCHESTRATOR_PROMPT.md', 'PROJECT_PROFILE.md',
                    'agents\explorer.md', 'hooks\check-syntax.mjs', 'commands\cckit_help.md')) {
  if (-not (Test-Path (Join-Path $kit $must))) {
    Write-Host "  ! master copy has no $must - ship.list fell behind the kit structure." -ForegroundColor Red
    Write-Host "    Installation aborted: an incomplete kit is worse than none." -ForegroundColor Red
    exit 1
  }
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
