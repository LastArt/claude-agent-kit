#!/usr/bin/env node
/**
 * Задачи проекта и состояние конвейера.
 *
 * Что считается задачей — правило `readTaskDirs()` из карты памяти
 * (`.claude/hooks/map.mjs`), и оно здесь повторено, а не ослаблено: имя папки по форме
 * «дата-слаг», каталог проверяется через `lstat`, физический файл состояния — обязательный
 * признак. Всё прочее пропускается МОЛЧА: оборванный перенос и посторонний каталог не должны
 * приезжать в ответ узлом без полей.
 *
 * ВСЕ ЧТЕНИЯ — через примитивы `pult/lib/fs-safe.mjs`, прямых обращений к `node:fs` нет.
 *
 * ПРАВИЛА РАЗБОРА НЕДОВЕРЕННОГО ТЕКСТА (общие для всего модуля):
 *   • front-matter разбирается ПОСТРОЧНОЙ регуляркой, как `frontMatter()`
 *     в `.claude/hooks/task.mjs`, а не YAML-парсером: YAML умеет якоря, ссылки и типы,
 *     и всё это здесь лишняя поверхность;
 *   • регулярки привязаны к началу строки и не имеют вложенных квантификаторов;
 *   • строка длиннее потолка отбрасывается ЦЕЛИКОМ — иначе чужой файл становится точкой
 *     зависания;
 *   • разобранное складывается в объект без прототипа: литерал `{}` принял бы из чужого
 *     `STATE.md` ключи `constructor` и `toString` как есть;
 *   • в ответ поля переносятся ПОИМЁННО, разобранный чужой объект не разворачивается никогда.
 *
 * ПЕРЕЧИСЛИМЫЕ ПОЛЯ идут только как совпадение с закрытым словарём кита — ровно как версия,
 * а не как строка из чужого файла. Не совпало — `null` и код отказа.
 *
 * ПОЛЕ `branch` ПРОВЕРИТЬ НЕЧЕМ, и это сказано вслух: оно приходит из `gitBranch()`
 * в `.claude/hooks/task.mjs`, а имена веток git почти произвольны — закрытого словаря нет
 * и быть не может. Поэтому `branch` проходит через очистку свободного текста, в машинных
 * гарантиях API не участвует и назван таковым в разделе 1.5 контракта наравне с `title`.
 *
 * ВРЕМЕНА идут только через единственную дверь в виде `local-naive`: так их пишет `stamp()`
 * в `.claude/hooks/task.mjs`. Сырая строка из чужого `STATE.md` под машинной пометкой наружу
 * не уходит ни при каких условиях.
 *
 * Класс риска берётся ГОТОВЫМ и не пересчитывается: пересчёт разбором плана — это второй
 * источник правды, и он в задачу фазы 1 не входит.
 */

import path from 'node:path';

import {
  statSafe, readTextCapped, readDirCapped, capText, timeField, enumField, counterField,
} from '../lib/fs-safe.mjs';
import {
  FAULT, ENUM, TASK_ID_RE, TASK_ID_MAX, MAX_TASKS, MAX_TEXT_FILE, MAX_LINE_BYTES,
  MAX_LOG_LINES, MAX_DIR_ENTRIES,
} from '../config.mjs';

/** Поле front-matter: имя, двоеточие, значение. Привязана к началу строки, без вложенности. */
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_-]{0,63})\s*:(.*)$/;

/** Строка журнала задачи: «- ЧЧ:ММ текст». Дата стоит в поле `updated`, поэтому только время. */
const LOG_RE = /^-\s+(\d{2}:\d{2})\s+(.*)$/;

/**
 * Front-matter построчно. Возвращает `Map`, а не литерал объекта: чужие ключи `constructor`
 * и `__proto__` в `Map` — обычные ключи и ничего не ломают.
 */
export function frontMatter(text) {
  const fields = new Map();
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') return fields;
    if (line.length > MAX_LINE_BYTES) continue;      // длинная строка не разбирается вовсе
    const m = line.match(FIELD_RE);
    if (m) fields.set(m[1], m[2].trim());
  }
  return null;                                        // блок не закрылся — шапки нет
}

/** Строки журнала задачи с конца, в пределах потолка. */
function readLog(text, faults) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith('## Журнал'));
  if (start < 0) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > MAX_LINE_BYTES) continue;
    if (!line.trim().startsWith('- ')) continue;
    const m = line.match(LOG_RE);
    if (m) {
      const time = timeField(m[1], 'clock');
      if (!time) faults.push({ field: 'log.time', code: FAULT.TIME_UNRECOGNISED });
      const t = capText(m[2]);
      if (t.truncated) faults.push({ field: 'log.text', code: FAULT.TEXT_TRUNCATED });
      items.push({ time, text: t.text });
      continue;
    }
    // Форма не совпала: время не выдумываем, строка целиком уходит текстом.
    const t = capText(line.trim().replace(/^-\s+/, ''));
    if (t.truncated) faults.push({ field: 'log.text', code: FAULT.TEXT_TRUNCATED });
    items.push({ time: null, text: t.text });
  }
  return items.length > MAX_LOG_LINES ? items.slice(items.length - MAX_LOG_LINES) : items;
}

/** Одна задача: поля переносятся поимённо, ни одно не идёт «как есть». */
function shapeTask(id, state, faults) {
  const fm = frontMatter(state);
  const task = {
    id,
    title: null,
    status: null,
    mode: null,
    class: null,
    branch: null,
    created: null,
    updated: null,
    review_iterations: null,
    audit_iterations: null,
    stop_kind: null,
    log: [],
  };
  if (!fm) {
    faults.push({ field: 'state', code: FAULT.STATE_NO_FRONT_MATTER });
    task.log = readLog(state, faults);
    return task;
  }

  const get = (name) => (fm.has(name) ? fm.get(name) : '');

  const title = capText(get('title'));
  if (title.truncated) faults.push({ field: 'title', code: FAULT.TEXT_TRUNCATED });
  task.title = title.text || null;

  const branch = capText(get('branch'));
  if (branch.truncated) faults.push({ field: 'branch', code: FAULT.TEXT_TRUNCATED });
  task.branch = branch.text || null;

  const enums = [
    ['status', ENUM.taskStatus],
    ['mode', ENUM.taskMode],
    ['class', ENUM.taskClass],
    ['stop_kind', ENUM.taskStopKind],
  ];
  for (const [field, dict] of enums) {
    const raw = get(field);
    const value = enumField(raw, dict);
    if (value === null && raw !== '') faults.push({ field, code: FAULT.ENUM_UNRECOGNISED });
    task[field] = value;
  }

  for (const field of ['created', 'updated']) {
    const raw = get(field);
    const value = timeField(raw, 'local-naive');
    if (value === null && raw !== '') faults.push({ field, code: FAULT.TIME_UNRECOGNISED });
    task[field] = value;
  }

  for (const field of ['review_iterations', 'audit_iterations']) {
    const raw = get(field);
    const value = counterField(raw);
    if (value === null && raw !== '') faults.push({ field, code: FAULT.ENUM_UNRECOGNISED });
    task[field] = value;
  }

  task.log = readLog(state, faults);
  return task;
}

/** Идентификатор активной задачи: форма проверяется ДО подстановки в файловый путь. */
async function readActive(tasksDir, budget, faults, known) {
  const res = await readTextCapped(path.join(tasksDir, 'ACTIVE'), MAX_TEXT_FILE, budget);
  if (!res.ok) {
    if (res.code !== FAULT.PATH_UNREACHABLE) faults.push({ field: 'active', code: FAULT.ACTIVE_UNREADABLE });
    return null;
  }
  const first = (res.text.split(/\r?\n/)[0] || '').trim();
  if (!first) return null;
  if (first.length > TASK_ID_MAX || !TASK_ID_RE.test(first)) {
    faults.push({ field: 'active', code: FAULT.ACTIVE_UNREADABLE });
    return null;
  }
  if (!known.has(first)) {
    faults.push({ field: 'active', code: FAULT.ACTIVE_UNREADABLE });
    return null;
  }
  return first;
}

/**
 * Задачи проекта.
 *
 * @param {string} kitDir  папка кита проекта
 * @param {object} options `budget` — сквозной счётчик запроса
 * @returns {{items: Array<{task: object, dir: string}>, active: string|null, faults: Array}}
 *          `dir` рядом с задачей, а не внутри неё: абсолютный путь в ответ не попадает.
 */
export async function readTasks(kitDir, options = {}) {
  const budget = options.budget || null;
  const tasksDir = path.join(kitDir, 'tasks');
  const faults = [];
  const items = [];

  const st = await statSafe(tasksDir);
  if (!st.ok || !st.stat.isDirectory()) {
    return { items, active: null, faults };
  }

  const dir = await readDirCapped(tasksDir, MAX_DIR_ENTRIES);
  if (!dir.ok) {
    faults.push({ field: 'tasks', code: FAULT.TASKS_UNREADABLE });
    return { items, active: null, faults };
  }
  if (dir.truncated) faults.push({ field: 'tasks', code: FAULT.TASKS_TRUNCATED });

  const known = new Set();
  for (const name of dir.names.sort()) {
    if (!TASK_ID_RE.test(name)) continue;
    const taskDir = path.join(tasksDir, name);
    const dst = await statSafe(taskDir);
    if (!dst.ok || !dst.stat.isDirectory()) continue;
    const state = await readTextCapped(path.join(taskDir, 'STATE.md'), MAX_TEXT_FILE, budget);
    if (!state.ok) continue;                          // нет STATE.md — задачей не считается
    known.add(name);
    if (items.length >= MAX_TASKS) {
      faults.push({ field: 'tasks', code: FAULT.TASKS_TRUNCATED });
      break;
    }
    const own = [];
    const task = shapeTask(name, state.text, own);
    for (const f of own) faults.push({ field: `task.${name}.${f.field}`, code: f.code });
    items.push({ task, dir: taskDir });
  }

  const active = await readActive(tasksDir, budget, faults, known);
  return { items, active, faults };
}
