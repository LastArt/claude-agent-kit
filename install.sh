#!/usr/bin/env bash
# Claude Agent Kit — установщик (Linux / macOS)
# Раскладывает кит и глобальные команды в домашнюю папку текущего пользователя.
# Запуск:  bash install.sh
set -euo pipefail

# Команды, которые должны работать в ЛЮБОЙ папке. Остальные команды из
# .claude/commands остаются проектными: вне развёрнутого кита они бесполезны.
GLOBAL_COMMANDS=(cckit_new-project cckit_install cckit_update cckit_help cckit_get_instruction cckit_uninstall)

SRC="$(cd "$(dirname "$0")" && pwd)"      # папка кита (где лежит этот скрипт)
DEST="$HOME/.claude"
mkdir -p "$DEST"

# 1) Мастер-кит -> ~/.claude/agent-kit (полностью обновляем)
rm -rf "$DEST/agent-kit"
cp -r "$SRC/.claude" "$DEST/agent-kit"

# Файлы, принадлежащие только этому репозиторию; в чужие проекты им нельзя:
#   settings.local.json — разрешения, выданные на ЭТОЙ машине
#   CLAUDE.md           — инструкции по разработке самого набора
rm -f "$DEST/agent-kit/settings.local.json" "$DEST/agent-kit/CLAUDE.md"

# Файлы машинной приёмки принадлежат ЭТОЙ машине: снимок прогона (в нём может быть вывод
# ваших тестов), подтверждение блока команд и состояние гейта. Раздай их — и новый проект
# стартует с чужим «принято».
rm -f "$DEST/agent-kit/artifacts/VERIFY.json" "$DEST/agent-kit/artifacts/VERIFY.lock" \
      "$DEST/agent-kit/artifacts/GATE_STATE.json"

# PROJECT_PROFILE.md в этом репозитории описывает САМ набор. Если раздать его как есть,
# каждый новый проект получит профиль с чужими фактами — поэтому в мастер-копию всегда
# кладётся пустой шаблон.
if [ -f "$DEST/agent-kit/PROJECT_PROFILE.template.md" ]; then
  mv -f "$DEST/agent-kit/PROJECT_PROFILE.template.md" "$DEST/agent-kit/PROJECT_PROFILE.md"
fi

KIT_VERSION="$(head -n 1 "$DEST/agent-kit/VERSION" 2>/dev/null | tr -d '\r\n' || true)"
echo "  + мастер-кит:      $DEST/agent-kit (версия ${KIT_VERSION:-неизвестна})"

# 2) Глобальные команды -> ~/.claude/commands (единственный источник — .claude/commands)
mkdir -p "$DEST/commands"
installed=()
for name in "${GLOBAL_COMMANDS[@]}"; do
  file="$SRC/.claude/commands/$name.md"
  if [ -f "$file" ]; then
    cp -f "$file" "$DEST/commands/"
    installed+=("/$name")
  else
    echo "  ! нет файла: .claude/commands/$name.md"
  fi
done
echo "  + команды:         ${installed[*]:-(ни одной)}"

# 3) Хуки запускаются через node. Без него они молча ничего не делают.
if command -v node >/dev/null 2>&1; then
  echo "  + node:            $(node --version)"
else
  echo "  ! node не найден — хук проверки синтаксиса работать не будет. Поставьте Node.js."
fi

echo
# Баннер лежит в самом ките и печатает логотип и версию.
if command -v node >/dev/null 2>&1 && [ -f "$DEST/agent-kit/hooks/banner.mjs" ]; then
  node "$DEST/agent-kit/hooks/banner.mjs"
fi

# Страница-инструкция + фирменный ярлык на рабочем столе. БЕЗ авто-открытия — откроем ПОСЛЕ
# нажатия Enter, чтобы пользователь сначала прочитал шаги в терминале.
GUIDE="$DEST/agent-kit/hooks/make-guide.mjs"
if command -v node >/dev/null 2>&1 && [ -f "$GUIDE" ]; then
  node "$GUIDE" --desktop "$HOME/Desktop"
fi

# Полные шаги а)/б) и напоминание про иконку на рабочем столе печатает баннер выше.
echo
printf 'Прочитайте шаги выше. Нажмите Enter, чтобы открыть инструкцию в браузере… '
read -r _ || true
PAGE="$DEST/agent-kit/guide.html"
if [ -f "$PAGE" ]; then
  if command -v open >/dev/null 2>&1; then open "$PAGE" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$PAGE" >/dev/null 2>&1 &
  fi
fi
