#!/usr/bin/env node
/**
 * Заглушка: архивация задачи больше не нужна.
 *
 * Раньше этот хук уносил PLAN.md / SECURITY.md / REVIEW.md в `.claude/artifacts/history/`:
 * все три файла были единственными на проект, и следующая задача их затирала. С версии 1.10
 * у каждой задачи своя папка `.claude/tasks/<id>/` — затирать нечего, значит и архивировать
 * нечего. Память проекта теперь лежит в самих папках задач.
 *
 * Почему файл не удалён. В развёрнутых копиях 1.5.0–1.9.x его зовут старый промт оркестратора
 * и старые команды (`/cckit_feature`, `/cckit_quick`, `/cckit_plan`) — исчезнувший скрипт
 * сломал бы им первый же шаг цепочки. Заглушка отвечает нулём, ничего не трогает на диске
 * и говорит, чем пользоваться вместо неё.
 *
 *   node .claude/hooks/archive-task.mjs           подсказка, код 0
 *   node .claude/hooks/archive-task.mjs --dry     то же самое: делать нечего в любом режиме
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.stdout.write(
  '[архив] архивация больше не нужна: у каждой задачи своя папка .claude/tasks/<id>/, ' +
  'список — node .claude/hooks/task.mjs list\n'
);

// Про старую историю говорим только то, что правда на этой машине прямо сейчас. Хук миграции
// приезжает отдельной версией, и назвать его раньше, чем он лёг на диск, — значит послать
// человека за несуществующим файлом.
const MIGRATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrate-tasks.mjs');
process.stdout.write(existsSync(MIGRATE)
  ? '[архив] старую историю из .claude/artifacts/history/ переносит ' +
    'node .claude/hooks/migrate-tasks.mjs (оригиналы остаются на месте)\n'
  : '[архив] старая история в .claude/artifacts/history/ остаётся на месте и читается как есть\n');

process.exit(0);
