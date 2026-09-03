#!/usr/bin/env node
/**
 * Сборка одного проекта: порядок чтения, таймаут и список отказов.
 *
 * ПОРЯДОК ЖЁСТКИЙ. Сначала пометка отвергнутого корня (фаза 3), затем асинхронная проба
 * доступности корня и папки кита в гонке с таймаутом на проект: не ответила —
 * `state: unreachable`, остальные поля `null`, код в списке отказов и НИКАКИХ синхронных
 * чтений дальше.
 *
 * ПОЧЕМУ ПОМЕТКА КОРНЯ ИДЁТ ПЕРВОЙ — ДВЕ ПРИЧИНЫ, И ОБЕ НЕСУЩИЕ. Первая: под запрещённым
 * корнем демон не читает НИЧЕГО, и это и есть закрытие дыры — проба уже была бы обращением
 * к диску. Вторая: домашний каталог, попавший в реестр, иначе запускал бы СИНХРОННЫЙ обход
 * отпечатка по всему дереву дома на каждом запросе списка — то есть вставал бы вместе с живым
 * терминалом ещё до того, как что-нибудь отдал. Пометка БЕРЁТСЯ ИЗ ЗАПИСИ реестра, а не
 * считается здесь заново: единственная дверь — `rootRejection()` в `pult/lib/registry.mjs`.
 *
 * ВСЕ ЧТЕНИЯ — через примитивы `pult/lib/fs-safe.mjs`, прямых обращений к `node:fs` нет:
 * проба идёт через `statSafe()` (то есть через `lstat`), потому что именно здесь, в самом
 * раннем обращении к чужому пути, обычный `stat` ушёл бы за симлинк.
 *
 * ПОЧЕМУ ПРОБА ВООБЩЕ НУЖНА. Мёртвый сетевой путь держит синхронный вызов десятки секунд
 * и вешает весь список, а подсчёт отпечатка синхронный. При этом честно: ТАЙМАУТ НА ПРОЕКТ
 * ЗАЩИЩАЕТ ТОЛЬКО АСИНХРОННУЮ ПРОБУ и прервать синхронное чтение не может — от него держат
 * потолки самого обхода: число файлов, объём, число каталогов и опрос времени внутри `scan()`
 * (`pult/lib/fingerprint.mjs`). Зависшая проба к тому же продолжает держать поток пула
 * файловых операций и после того, как гонка вернула `unreachable` (риск 1 плана).
 *
 * БЮДЖЕТ. Сквозной счётчик запроса создаётся HTTP-слоем ОДИН РАЗ и приходит сюда аргументом:
 * он тратится всеми читателями проекта — включая хвост журнала событий, где списывается
 * размер хвоста, — и проверяется внутри обхода, а не только по границе проекта: и по файлам,
 * и по времени, на каждом пути. Эталон приходит аргументом уже посчитанным (по своему бюджету
 * и с такой же пробой): читатель проекта его не пересчитывает и его бюджет не тратит, поэтому
 * исчерпать базу сравнения для остальных проектов отсюда невозможно.
 *
 * КОДЫ ОТКАЗОВ. Каждый читатель обёрнут так, что его сбой даёт `null` плюс запись
 * «поле, код» в список отказов, а не исключение наружу. Код берётся из закрытого словаря
 * по имени системной ошибки; имени в словаре нет — общий код «нераспознанный отказ», а не сырое
 * значение. Текст ошибки, стек и путь к файлу в ответ не попадают НИ ПРИ КАКИХ
 * обстоятельствах: в современном Node сообщение об ошибке цитирует разбираемое содержимое,
 * то есть чужой текст уехал бы мимо всех белых списков. Подробности остаются в stdout демона,
 * где они нужны человеку.
 *
 * ПОЛЕ «ТРОНУТО» СОБИРАЕТСЯ ИЗ ДВУХ РАЗНЫХ ВЕЛИЧИН, и склеивать их нельзя:
 *   registry_seen — время последнего просмотра из реестра (его обновляет только запрос
 *                   одного проекта);
 *   kit_changed   — время последнего изменения кита: время последнего события журнала,
 *                   а при его отсутствии — наибольшая метка изменения состояния активной
 *                   задачи или состояния гейта. Источник указывается полем.
 * Обе идут наружу только через единственную дверь к временам в виде `utc-iso`.
 */

import path from 'node:path';

import { statSafe, timeField, capText, faultFromError } from '../lib/fs-safe.mjs';
import { readKit } from './kit.mjs';
import { readTasks } from './tasks.mjs';
import { readArtifacts } from './artifacts.mjs';
import { readGate } from './gate.mjs';
import { readLastEvent } from './events.mjs';
import { FAULT, BUDGET_PROJECT, MAX_PROJECTS } from '../config.mjs';

/** Проба доступности в гонке с таймаутом на проект. */
async function probe(target, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, code: FAULT.READ_TIMEOUT }), ms);
  });
  try {
    return await Promise.race([statSafe(target), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Метка изменения файла — в машинное время UTC.
 *
 * Строится защищённо: негодная метка (а такие бывают на чужих файловых системах) роняет
 * преобразование, а метка за 9999 годом даёт расширенную форму, которой регулярка `utc-iso`
 * не примет. Оба исхода дают `null`, а не исключение и не сырую строку.
 */
function mtimeUtc(stat) {
  try {
    const ms = stat && stat.mtimeMs;
    if (!Number.isFinite(ms)) return null;
    return timeField(new Date(ms).toISOString(), 'utc-iso');
  } catch {
    return null;
  }
}

/** Наибольшая из двух проверенных величин времени. */
function later(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.value >= b.value ? a : b;
}

/**
 * Собрать проект целиком.
 *
 * @param {object} entry     запись реестра: `{id, name, path, seen}`
 * @param {object} options   `reference` — посчитанный эталон, `budget` — сквозной счётчик
 *                           запроса, `full` — добавить список задач (иначе только активная)
 */
export async function readProject(entry, options = {}) {
  const reference = options.reference || null;
  const budget = options.budget || null;
  const full = options.full === true;

  const faults = [];
  const fault = (field, code) => {
    if (!faults.some((f) => f.field === field && f.code === code)) faults.push({ field, code });
  };

  const project = {
    id: entry.id,
    name: capText(entry.name).text,
    path: capText(entry.path).text,
    touched: {
      registry_seen: entry.seen || null,
      kit_changed: null,
    },
    state: 'unreachable',
    version: null,
    fingerprint: {
      value: null,
      reference: reference && reference.fingerprint ? reference.fingerprint.value : null,
      verdict: 'unknown',
      diverged: [],
      truncated: false,
      scan_truncated: false,
      reason: null,
      composition: null,
    },
    profile: null,
    active_task: null,
    gate: null,
    faults,
  };
  if (full) project.tasks = [];

  // 0. КОРЕНЬ ОТВЕРГНУТ — и на этом всё: ни пробы, ни `readKit()`, ни одного обращения
  //    к диску проекта. Состояние встаёт рядом с «путь недоступен», «набора нет», «чужой
  //    набор» и «старая структура», как того требует раздел 1.4 контракта: запись остаётся
  //    в реестре и показывается человеку с причиной, а не исчезает из списка.
  if (entry.rejected) {
    project.state = 'root_rejected';
    fault('path', entry.rejected);
    return project;
  }

  // 1. Проба доступности корня и папки кита. До её успеха — ни одного синхронного чтения.
  const rootStat = await probe(entry.path, BUDGET_PROJECT.ms);
  if (!rootStat.ok || !rootStat.stat.isDirectory()) {
    fault('path', rootStat.ok ? FAULT.PATH_UNREACHABLE : rootStat.code);
    return project;
  }
  const kitDir = path.join(entry.path, '.claude');
  const kitStat = await probe(kitDir, BUDGET_PROJECT.ms);
  if (!kitStat.ok && kitStat.code === FAULT.READ_TIMEOUT) {
    fault('path', FAULT.READ_TIMEOUT);
    return project;
  }

  if (budget && budget.tick()) {
    fault('budget', FAULT.BUDGET_EXHAUSTED);
    project.state = 'unreachable';
    return project;
  }

  // 2. Состояние кита: версия, профиль, отпечаток.
  let kit = null;
  try {
    kit = await readKit(entry.path, { reference, budget });
  } catch (e) {
    fault('kit', faultFromError(e));
    return project;
  }
  project.state = kit.state;
  project.version = kit.version;
  project.profile = kit.profile;
  project.fingerprint = {
    value: kit.fingerprint.value,
    reference: kit.fingerprint.reference,
    verdict: kit.fingerprint.verdict,
    diverged: kit.fingerprint.diverged,
    truncated: kit.fingerprint.truncated,
    scan_truncated: kit.fingerprint.scan_truncated,
    reason: kit.fingerprint.reason,
    // ФАЗА 4: сверка по составу профиля. Поля переносятся ПОИМЁННО, поэтому новый объект
    // обязан быть перенесён явной строкой — иначе он не доедет до страницы вовсе. `null`
    // здесь означает «записи о раскладке нет», то есть сравнивались полные значения.
    composition: kit.fingerprint.composition,
  };
  for (const f of kit.faults) fault(f.field, f.code);
  // Признак усечения обхода ОБЯЗАН сопровождаться кодом в списке отказов этого проекта.
  if (project.fingerprint.scan_truncated) {
    fault('fingerprint', project.fingerprint.reason || FAULT.SCAN_TRUNCATED);
  }
  if (kit.state === 'no_kit' || kit.state === 'foreign') return project;

  // 3. Задачи.
  let tasks = { items: [], active: null, faults: [] };
  try {
    tasks = await readTasks(kitDir, { budget });
  } catch (e) {
    fault('tasks', faultFromError(e));
  }
  for (const f of tasks.faults) fault(f.field, f.code);

  const withArtifacts = async (item) => {
    try {
      const a = await readArtifacts(item.dir, { budget });
      for (const f of a.faults) fault(`task.${item.task.id}.${f.field}`, f.code);
      return { ...item.task, review: a.review, security: a.security, done: a.done };
    } catch (e) {
      fault(`task.${item.task.id}`, faultFromError(e));
      return { ...item.task, review: null, security: null, done: null };
    }
  };

  const activeItem = tasks.active ? tasks.items.find((i) => i.task.id === tasks.active) : null;
  if (activeItem) project.active_task = await withArtifacts(activeItem);
  if (full) {
    const list = [];
    for (const item of tasks.items) {
      list.push(item.task.id === tasks.active && project.active_task
        ? project.active_task
        : await withArtifacts(item));
    }
    project.tasks = list;
  }

  // 4. Гейт и отчёт приёмки.
  try {
    const g = await readGate(kitDir, { budget });
    project.gate = g.gate;
    for (const f of g.faults) fault(f.field, f.code);
  } catch (e) {
    fault('gate', faultFromError(e));
  }

  // 5. Время последнего движения конвейера.
  let changed = null;
  let source = null;
  try {
    const ev = await readLastEvent(kitDir, { budget });
    for (const f of ev.faults) fault(f.field, f.code);
    if (ev.last && ev.last.ts) {
      changed = ev.last.ts;
      source = 'events';
    }
  } catch (e) {
    fault('events', faultFromError(e));
  }
  if (!changed) {
    let best = null;
    if (tasks.active) {
      const st = await statSafe(path.join(kitDir, 'tasks', tasks.active, 'STATE.md'));
      if (st.ok) best = later(best, mtimeUtc(st.stat));
    }
    const gs = await statSafe(path.join(kitDir, 'artifacts', 'GATE_STATE.json'));
    if (gs.ok) best = later(best, mtimeUtc(gs.stat));
    if (best) {
      changed = best;
      source = 'mtime';
    }
  }
  project.touched.kit_changed = changed ? { value: changed.value, kind: changed.kind, source } : null;

  return project;
}

/** Потолок числа проектов держится здесь же, чтобы он был виден рядом со сборкой. */
export const PROJECT_LIMIT = MAX_PROJECTS;
