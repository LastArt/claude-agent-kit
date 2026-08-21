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
#
# Копируем строго по белому списку ship.list: что не перечислено — не едет. Раньше копировалась
# вся папка .claude, а лишнее вычищалось следом, и этот чёрный список отставал от реальности
# при каждом новом файле — так в чужие проекты уезжали рабочие артефакты и собранные страницы.
rm -rf "$DEST/agent-kit"
mkdir -p "$DEST/agent-kit"

SHIP="$SRC/ship.list"
if [ ! -f "$SHIP" ]; then
  echo "  ! рядом с установщиком нет ship.list — не знаю, что копировать. Прерываю."
  exit 1
fi

while IFS= read -r raw || [ -n "$raw" ]; do
  entry="${raw%%#*}"
  entry="$(printf '%s' "$entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$entry" ]; then continue; fi
  name="${entry%/}"
  from="$SRC/.claude/$name"
  if [ ! -e "$from" ]; then
    echo "  ! ship.list просит '$entry', а такого файла нет — пропускаю"
    continue
  fi
  case "$entry" in
    */) mkdir -p "$DEST/agent-kit/$name"
        cp -r "$from/." "$DEST/agent-kit/$name/" ;;
    *)  cp -f "$from" "$DEST/agent-kit/$name" ;;
  esac
done < "$SHIP"

# Файлы машинной приёмки принадлежат ЭТОЙ машине: снимок прогона (в нём может быть вывод
# ваших тестов), подтверждение блока команд и состояние гейта. Раздай их — и новый проект
# стартует с чужим «принято».
rm -f "$DEST/agent-kit/artifacts/VERIFY.json" "$DEST/agent-kit/artifacts/VERIFY.lock" \
      "$DEST/agent-kit/artifacts/GATE_STATE.json"

# Артефакты задачи и кэш разведок — наработка ЭТОГО репозитория: в них лежит то, над чем мы
# работаем прямо сейчас, а не пустая заготовка. В мастер-копию всегда кладём эталонные заглушки
# из assets/stubs, иначе новый проект стартует с чужим планом, чужим ревью и чужой разведкой.
# В развёрнутом ките сами заглушки не нужны — папку убираем следом.
STUBS="$DEST/agent-kit/assets/stubs"
if [ -d "$STUBS" ]; then
  for name in PLAN REVIEW SECURITY; do
    if [ -f "$STUBS/$name.md" ]; then
      cp -f "$STUBS/$name.md" "$DEST/agent-kit/artifacts/$name.md"
    fi
  done
  mkdir -p "$DEST/agent-kit/explores"
  rm -f "$DEST/agent-kit/explores/"*.md
  if [ -f "$STUBS/explores-INDEX.md" ]; then
    cp -f "$STUBS/explores-INDEX.md" "$DEST/agent-kit/explores/INDEX.md"
  fi
  rm -rf "$STUBS"
fi

# История задач — память этого репозитория, а не часть механизма.
rm -rf "$DEST/agent-kit/artifacts/history"

# PROJECT_PROFILE.md в этом репозитории описывает САМ набор. Если раздать его как есть,
# каждый новый проект получит профиль с чужими фактами — поэтому в мастер-копию всегда
# кладётся пустой шаблон.
if [ -f "$DEST/agent-kit/PROJECT_PROFILE.template.md" ]; then
  mv -f "$DEST/agent-kit/PROJECT_PROFILE.template.md" "$DEST/agent-kit/PROJECT_PROFILE.md"
fi

# Постусловие: белый список мог отстать от структуры набора. Проверяем то, без чего кит мёртв, —
# лучше внятно прерваться здесь, чем оставить пользователя с наполовину установленным набором.
for must in VERSION settings.json ORCHESTRATOR_PROMPT.md PROJECT_PROFILE.md \
            agents/explorer.md hooks/check-syntax.mjs commands/cckit_help.md; do
  if [ ! -e "$DEST/agent-kit/$must" ]; then
    echo "  ! в мастер-копии нет $must — ship.list отстал от структуры набора."
    echo "    Установка прервана: неполный кит хуже отсутствующего."
    exit 1
  fi
done

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
