#!/usr/bin/env node
/**
 * Раскладывает заглушки рабочих файлов из assets/stubs по их местам.
 *
 *   node .claude/hooks/stubs.mjs           разложить недостающее, существующее не трогать
 *   node .claude/hooks/stubs.mjs --force   перезаписать, даже если файл уже на месте
 *   node .claude/hooks/stubs.mjs --dry     показать, что было бы сделано
 *
 * Зачем. Формы плана, ревью и аудита теперь раздаёт `task.mjs new` — прямо из assets/stubs
 * в папку заведённой задачи, по копии на задачу. Этому хуку остаётся то, что живёт в проекте
 * в одном экземпляре: указатель текущей задачи `tasks/ACTIVE` и кэш разведок. В исходниках
 * набора их нет вовсе (иначе чужая работа уезжала бы в каждый новый проект), эталоны лежат
 * в assets/stubs, а хук их материализует: установщик зовёт его для мастер-копии, разработчик
 * набора — для себя после свежего клона.
 *
 * Хук кладёт ТОЛЬКО файл `tasks/ACTIVE` и никогда не создаёт папок задач: мастер-копия
 * `~/.claude/agent-kit` раздаётся в каждый новый проект, и попавшая туда задача разошлась бы
 * по всем сразу.
 *
 * Ничего, кроме перечисленных файлов, не трогает и не падает: нет заглушек — скажет и выйдет
 * с нулём.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUBS = path.join(KIT, 'assets', 'stubs');
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');
const out = (s) => process.stdout.write(s + '\n');

// Имя заглушки в assets/stubs -> куда она ложится внутри .claude
const PLACES = [
  ['FAQ_TEMPLATE.md', 'artifacts/FAQ_TEMPLATE.md'],
  ['tasks-ACTIVE', 'tasks/ACTIVE'],
  ['explores-INDEX.md', 'explores/INDEX.md'],
];

if (!existsSync(STUBS)) {
  out('[stubs] нет assets/stubs — раскладывать нечего.');
  process.exit(0);
}

let placed = 0, kept = 0, missing = 0;
for (const [stub, target] of PLACES) {
  const from = path.join(STUBS, stub);
  const to = path.join(KIT, target);
  if (!existsSync(from)) {
    out(`[stubs] нет заглушки ${stub} — пропускаю`);
    missing++;
    continue;
  }
  if (existsSync(to) && !FORCE) { kept++; continue; }
  if (DRY) { out(`[stubs] положил бы ${target}`); placed++; continue; }
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    placed++;
  } catch (err) {
    out(`[stubs] не смог положить ${target}: ${err.message}`);
  }
}

out(`[stubs] разложено: ${placed}`
  + (kept ? `, оставлено как есть: ${kept}` : '')
  + (missing ? `, заглушек не найдено: ${missing}` : ''));

// Дешёвая страховка: задача, заведённая прямо в мастер-копии ~/.claude/agent-kit, разъедется
// по всем создаваемым проектам. Это ВИДИМОСТЬ, а не запрет — хук ничего не удаляет и работать
// не отказывается: удаляют папки задач установщики, а не пускают их в проекты команды
// разворачивания. Здесь только строка, чтобы такая папка не лежала молча.
const TASK_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
try {
  const dir = path.join(KIT, 'tasks');
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && TASK_ID.test(e.name) && isFile(path.join(dir, e.name, 'STATE.md')))
    .map((e) => e.name);
  if (found.length) {
    const names = found.slice(0, 3).join(', ') + (found.length > 3 ? ' …' : '');
    out(`[stubs] ⚠ в этой копии набора лежат задачи (${found.length} шт.): ${names}`);
    out('[stubs]   если это мастер-копия ~/.claude/agent-kit, они не должны здесь находиться:');
    out('[stubs]   оттуда они уедут в каждый новый проект. Задачи живут в проектах, а не в наборе.');
  }
} catch { /* папки tasks нет — тем лучше */ }

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
