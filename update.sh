#!/usr/bin/env bash
# Claude Agent Kit — обновление: подтянуть свежую версию с GitHub и переустановить.
# Запуск:  bash update.sh
#
# Зачем отдельно от install.sh: установщик копирует набор из ЭТОЙ папки в ~/.claude/agent-kit.
# Если папка — старый клон, простая переустановка даст ту же старую версию. Поэтому сначала
# обновляем сам клон (git pull), а потом уже запускаем установщик.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
cd "$SRC"

echo "Claude Agent Kit — обновление"
echo

if [ -e "$SRC/.git" ] && command -v git >/dev/null 2>&1; then
  echo "  Тяну свежую версию с GitHub (git pull)..."
  if git pull --ff-only; then
    echo "  + исходник обновлён"
  else
    echo "  ! git pull не прошёл (локальные правки или расхождение веток)."
    echo "    Разберите вручную (git status) или скачайте свежий ZIP с GitHub."
  fi
else
  echo "  Это не git-клон — обновить исходник автоматически нельзя."
  echo "  Скачайте свежий ZIP: https://github.com/LastArt/claude-agent-kit (Code -> Download ZIP),"
  echo "  распакуйте поверх этой папки, затем запустите установку."
fi

echo
echo "  Переустанавливаю набор из этой папки..."
echo
bash "$SRC/install.sh"

echo
echo "Готово. В каждом проекте с набором выполните /cckit_update, чтобы подтянуть новую версию."
