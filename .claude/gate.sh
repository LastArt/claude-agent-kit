#!/usr/bin/env bash
# Claude Agent Kit — меню машинной приёмки (macOS / Linux).
# Запуск: bash .claude/gate.sh   — или двойным кликом, если система так умеет.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Поставьте его с https://nodejs.org и запустите этот файл снова."
  exit 1
fi

node "$DIR/hooks/gate-menu.mjs"
