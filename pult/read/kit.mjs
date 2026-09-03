#!/usr/bin/env node
/**
 * Состояние кита в проекте: пять состояний, версия, профиль и сверка отпечатка.
 *
 * ВСЕ ЧТЕНИЯ — исключительно через примитивы `pult/lib/fs-safe.mjs`, прямых обращений
 * к `node:fs` здесь нет. Причина не формальная: пути тут фиксированные (файл версии, профиль),
 * а содержимое уезжает в ответ, поэтому симлинк или junction на месте любого из них вынес бы
 * чужой файл в HTTP-ответ. Образец правильного порядка в ките — `readTaskFile()`
 * в `.claude/hooks/map.mjs`: `lstat` и проверка обычности до чтения.
 *
 * РАЗЛИЧЕНИЕ СОСТОЯНИЙ (раздел 1.4 контракта):
 *   no_kit   — папки кита нет или это не каталог;
 *   foreign  — папка есть, но в ней нет ни файла версии, ни списка состава, ни каталога
 *              агентов. Эвристика НАША: признака «это наш кит» в самом ките не существует,
 *              и чужая папка `.claude` с ручными настройками — законный случай;
 *   legacy   — кит есть, но нет каталога задач, а в рабочих файлах лежат одиночные план,
 *              ревью или аудит: так выглядели копии до 1.10 (признаки — в докблоке
 *              `.claude/hooks/migrate-tasks.mjs`);
 *   ok       — всё остальное.
 *
 * ВЕРСИЯ И ПРОФИЛЬ наружу идут только как машинные значения: версия — как совпадение
 * привязанной регулярки «число.число.число», профиль — как одно из трёх слов. Ни строки
 * содержимого профиля в ответ не попадает.
 *
 * ОТПЕЧАТОК. Два разных признака, и путать их нельзя:
 *   truncated      — обрезка списка расхождений по потолку;
 *   scan_truncated — НЕПОЛНЫЙ ОБХОД: файл сверх потолка, не обычный файл, исчерпанные потолки
 *                    или бюджет, нечитаемый файл, неперечислимый каталог, несостоявшийся
 *                    `lstat`. При нём значение не выдаётся, список расхождений пуст, вердикт
 *                    только `unknown`, а `reason` несёт код причины.
 * СВЕРКА ИДЁТ ПО СОСТАВУ ПРОФИЛЯ (фаза 4, решение человека 2). Эталон считается не целиком,
 * а по тем путям, которые в этом проекте вообще должны быть: профиль установки может
 * не разворачивать часть агентов и команд, и полное значение у такого проекта не сойдётся
 * с полным значением эталона НИКОГДА. Сторож, кричащий всегда, обесценивает сигнал ровно так
 * же надёжно, как молчащий, — поэтому у совпадения по составу своё слово вердикта,
 * `match_preset`, и при нём ПОЛНЫЕ ЗНАЧЕНИЯ ЗАКОННО РАЗЛИЧАЮТСЯ. Поля `value` и `reference`
 * сохраняют прежний смысл (полные значения), значения по составу лежат отдельно.
 *
 * ЯДРО СВЕРЯЕТСЯ ПРОТИВ ЭТАЛОНА, А НЕ ПО ЗАПИСИ ПРОЕКТА (находки E круга 2 и N круга 3
 * аудита). Перечень ядра берётся из карты эталона, пересечённой с профилем, и подделать его
 * записью нельзя ни в одном варианте: запись умеет вынести из сверки только пути внутри
 * `agents/` и `commands/`. Требования «путь ядра обязан быть в списке положенного» здесь НЕТ
 * и быть не может — довод записан у самой проверки.
 *
 * У ПРОЕКТА С НЕПОЛНЫМ ПРОФИЛЕМ ПОЛНОГО ЗНАЧЕНИЯ НЕТ ВОВСЕ, и это не поломка: список состава
 * едет в проект целиком, а каталогов, которые профиль не разворачивал, в нём нет — обход
 * честно взводит признак усечения. Поэтому при наличии записи о раскладке усечение ТОЛЬКО
 * из-за отсутствующих путей не гасит сверку, а признак `scan_truncated` остаётся правдой
 * и уезжает наружу вместе с `value: null`. Любая другая причина усечения гасит сверку
 * как прежде.
 *
 * ЧЕГО ОТПЕЧАТОК НЕ СВЕРЯЕТ ВООБЩЕ — существующая граница набора, а не решение этой фазы:
 * файл настроек и профиль проекта стоят в списке `SKIP` самого алгоритма
 * (`pult/lib/fingerprint.mjs`), то есть не входят в отпечаток ни у эталона, ни у проекта.
 * Подмена в них не видна сверкой ни до фазы 4, ни после.
 *
 * `mismatch` при усечении не выдаётся НИКОГДА: обход с выпавшим файлом даёт ложную тревогу
 * ровно на том сигнале, ради которого отпечаток заводили. Ложная тревога обесценивает сигнал
 * так же надёжно, как молчание.
 */

import path from 'node:path';

import { statSafe, readTextCapped, capText } from '../lib/fs-safe.mjs';
import { scan } from '../lib/fingerprint.mjs';
import { allows, coreViolation, valueFromMap, PRESET_DEFAULT } from '../lib/profiles.mjs';
import { readDeployRecord } from './deploy-record.mjs';
import {
  FAULT, BUDGET_PROJECT, VERSION_RE, MAX_TEXT_FILE, MAX_DIVERGED,
} from '../config.mjs';

/** Признак заполненного профиля — тот же, что у приветствия набора: цвет кружка. */
const PROFILE_FILLED = '\u{1F7E2}';
const PROFILE_TEMPLATE = '\u{1F534}';

async function isDir(p) {
  const st = await statSafe(p);
  return st.ok && st.stat.isDirectory();
}

async function isFile(p) {
  const st = await statSafe(p);
  return st.ok && st.stat.isFile();
}

/** Первая строка файла версии как совпадение регулярки — и ничего кроме. */
async function readVersion(kitDir, budget) {
  const res = await readTextCapped(path.join(kitDir, 'VERSION'), MAX_TEXT_FILE, budget);
  if (!res.ok) {
    return { version: null, code: res.code === FAULT.PATH_UNREACHABLE ? FAULT.VERSION_UNREADABLE : res.code };
  }
  const first = res.text.split(/\r?\n/)[0];
  if (typeof first !== 'string' || first.length > 32) return { version: null, code: FAULT.VERSION_UNREADABLE };
  const m = first.trim().match(VERSION_RE);
  if (!m) return { version: null, code: FAULT.VERSION_UNREADABLE };
  return { version: m[0], code: null };
}

/** Профиль: одно из трёх слов либо `null` с кодом. Содержимое наружу не идёт. */
async function readProfile(kitDir, budget) {
  const file = path.join(kitDir, 'PROJECT_PROFILE.md');
  const st = await statSafe(file);
  if (!st.ok && st.code === FAULT.PATH_UNREACHABLE) return { profile: 'absent', code: null };
  const res = await readTextCapped(file, MAX_TEXT_FILE, budget);
  if (!res.ok) return { profile: null, code: FAULT.PROFILE_UNREADABLE };
  if (res.text.includes(PROFILE_FILLED)) return { profile: 'filled', code: null };
  if (res.text.includes(PROFILE_TEMPLATE)) return { profile: 'template', code: null };
  return { profile: null, code: FAULT.PROFILE_UNREADABLE };
}

/**
 * Список расхождений: файл есть только с одной стороны или хеши различаются.
 * Сортируется и обрезается по потолку с отдельным признаком обрезки.
 */
function diverge(mine, theirs) {
  const names = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  const list = [];
  for (const name of names) {
    if (mine[name] !== theirs[name]) list.push(name);
  }
  list.sort();
  const truncated = list.length > MAX_DIVERGED;
  const cut = truncated ? list.slice(0, MAX_DIVERGED) : list;
  return { list: cut.map((p) => capText(p).text), truncated };
}

/**
 * Состояние кита проекта.
 *
 * @param {string} root      корень проекта
 * @param {object} options   `reference` — уже посчитанный эталон (шаг 8), `budget` — сквозной
 *                           счётчик запроса.
 */
export async function readKit(root, options = {}) {
  const reference = options.reference || null;
  const budget = options.budget || null;
  const kitDir = path.join(root, '.claude');

  const faults = [];
  const fault = (field, code) => {
    if (!faults.some((f) => f.field === field && f.code === code)) faults.push({ field, code });
  };

  const result = {
    kitDir,
    state: 'no_kit',
    version: null,
    profile: null,
    fingerprint: {
      value: null,
      reference: reference && reference.fingerprint ? reference.fingerprint.value : null,
      verdict: 'unknown',
      diverged: [],
      truncated: false,
      scan_truncated: false,
      reason: null,
      // Сверка по составу профиля. `null` означает «записи о раскладке нет», то есть
      // ровно сегодняшнее поведение фазы 1: сравниваются полные значения.
      composition: null,
    },
    files: Object.create(null),
    faults,
  };

  if (!await isDir(kitDir)) return result;

  const hasVersion = await isFile(path.join(kitDir, 'VERSION'));
  const hasShip = await isFile(path.join(kitDir, 'ship.list'));
  const hasAgents = await isDir(path.join(kitDir, 'agents'));
  if (!hasVersion && !hasShip && !hasAgents) {
    result.state = 'foreign';
    return result;
  }

  const hasTasks = await isDir(path.join(kitDir, 'tasks'));
  let legacy = false;
  if (!hasTasks) {
    for (const name of ['PLAN.md', 'REVIEW.md', 'SECURITY.md']) {
      if (await isFile(path.join(kitDir, 'artifacts', name))) { legacy = true; break; }
    }
  }
  result.state = legacy ? 'legacy' : 'ok';

  const v = await readVersion(kitDir, budget);
  result.version = v.version;
  if (v.code) fault('version', v.code);

  const p = await readProfile(kitDir, budget);
  result.profile = p.profile;
  if (p.code) fault('profile', p.code);

  let sc;
  try {
    sc = scan(kitDir, { budget, files: BUDGET_PROJECT.files, bytes: BUDGET_PROJECT.bytes });
  } catch {
    result.fingerprint.reason = FAULT.FINGERPRINT_UNCOUNTABLE;
    fault('fingerprint', FAULT.FINGERPRINT_UNCOUNTABLE);
    return result;
  }
  for (const code of sc.faults) fault('fingerprint', code);
  result.files = sc.files;

  // ЗАПИСЬ О РАСКЛАДКЕ ЧИТАЕТСЯ ЗДЕСЬ, ДО РАЗБОРА УСЕЧЕНИЯ, и это не перестановка ради
  // порядка: она ОБЪЯСНЯЕТ часть усечений. Читается недоверенно, своим модулем.
  const record = await readDeployRecord(root, { budget });
  for (const f of record.faults) fault(f.field, f.code);

  // УСЕЧЕНИЕ, ОБЪЯСНЁННОЕ ПРОФИЛЕМ, — НЕ ТО ЖЕ САМОЕ, ЧТО УСЕЧЕНИЕ ВООБЩЕ.
  //
  // Проект, разложенный неполным профилем, несёт ПОЛНЫЙ список состава (`ship.list` едет
  // в проект как есть — этого требует договор с фазой 4), а каталогов `agents/` или части
  // команд в нём нет. Обход честно спотыкается на них и взводит признак усечения: полное
  // значение у такого проекта не считается НИКОГДА. Без этой развилки вердикт у всех
  // проектов с профилем был бы «неизвестно» навсегда — то есть ровно тот шум, ради ухода
  // от которого принято решение человека 2.
  //
  // Развилка узкая намеренно: терпится ТОЛЬКО отсутствие пути (`lstat_failed`) и ТОЛЬКО при
  // наличии записи о раскладке. Нечитаемый файл, неперечислимый каталог, исчерпанный бюджет
  // и не обычный файл дают «неизвестно» как прежде. Безопасность при этом держит не эта
  // развилка, а сверка ядра ниже: пропавший файл ЯДРА даёт «ядро не наше» с перечнем путей,
  // сколько бы записей ни лежало в проекте.
  const onlyMissing = sc.faults.length > 0 && sc.faults.every((c) => c === FAULT.LSTAT_FAILED);
  const explained = sc.truncated && record.present && onlyMissing;

  // Обход неполон и объяснить это нечем — дальше сравнивать нечего: отпечаток от неполного
  // состава не отпечаток.
  if (sc.truncated && !explained) {
    result.fingerprint.value = null;
    result.fingerprint.scan_truncated = true;
    result.fingerprint.reason = sc.reason || FAULT.SCAN_TRUNCATED;
    result.fingerprint.verdict = 'unknown';
    fault('fingerprint', result.fingerprint.reason);
    return result;
  }
  if (sc.truncated) {
    // Признак остаётся ПРАВДОЙ и уезжает наружу: полного значения у такого проекта нет.
    result.fingerprint.scan_truncated = true;
    result.fingerprint.reason = sc.reason || FAULT.SCAN_TRUNCATED;
  }

  result.fingerprint.value = sc.value;
  if (sc.value === null && !explained) {
    result.fingerprint.reason = sc.reason || FAULT.FINGERPRINT_UNCOUNTABLE;
    fault('fingerprint', result.fingerprint.reason);
    return result;
  }

  // Эталона нет, он недоступен или его обход усечён — сверять не с чем.
  const refValue = reference && reference.fingerprint ? reference.fingerprint.value : null;
  if (!reference || refValue === null) {
    result.fingerprint.verdict = 'unknown';
    const code = (reference && reference.fingerprint && reference.fingerprint.reason)
      || FAULT.REFERENCE_MISSING;
    result.fingerprint.reason = code;
    fault('fingerprint', code);
    return result;
  }

  const refFiles = reference.files || Object.create(null);

  // ЗАПИСИ НЕТ — ПОВЕДЕНИЕ РОВНО СЕГОДНЯШНЕЕ. Так выглядят все проекты до этой фазы
  // и все, куда набор ставили промтом: сравниваются полные значения.
  if (!record.present) {
    if (sc.value === refValue) { result.fingerprint.verdict = 'match'; return result; }
    result.fingerprint.verdict = 'mismatch';
    const dFull = diverge(sc.files, refFiles);
    result.fingerprint.diverged = dFull.list;
    result.fingerprint.truncated = dFull.truncated;
    return result;
  }

  // ПРОФИЛЬ ИЗ ЗАПИСИ НЕ РАСПОЗНАН — считаем по ПОЛНОМУ составу. Сторона отказа выбрана
  // намеренно: полный профиль ничего из сверки не выносит, то есть подделка имени профиля
  // делает сверку строже, а не слабее.
  const preset = record.profile || PRESET_DEFAULT;

  // ПУСТОЙ ИЛИ ОБРЕЗАННЫЙ СПИСОК ПОЛОЖЕННОГО — «неизвестно». По обрезанному списку сверка
  // считала бы, что часть набора в проект не клали, и молча сузила бы предмет.
  if (!record.placed.length || record.truncated.placed) {
    result.fingerprint.verdict = 'unknown';
    result.fingerprint.reason = FAULT.DEPLOY_RECORD_INVALID;
    fault('deploy_record', FAULT.DEPLOY_RECORD_INVALID);
    return result;
  }

  // ЯДРО — ПРОТИВ ЭТАЛОНА. Перечень приходит из карты эталона, пересечённой с профилем.
  //
  // ТРЕБОВАНИЯ «ПУТЬ ЯДРА ОБЯЗАН БЫТЬ В СПИСКЕ ПОЛОЖЕННОГО» ЗДЕСЬ НЕТ, и это не упущение
  // (находка N круга 3 аудита). Список положенного — это фактически записанное ТЕМ прогоном
  // раскладки; на главном сценарии §4.2 — раскладка туда, где набор уже стоит, — всё ядро
  // пропускается additive-копией, и такое условие давало бы «ядро не наше» НАВСЕГДА у каждого
  // такого проекта, причём без возможности назвать причину. Членство в списке положенного
  // безопасности не несёт вовсе: перечень ядра приходит СНАРУЖИ, из эталона, и записью
  // его не подделать.
  const coreMissing = [];
  let compared = 0;
  const placedSet = new Set(record.placed);
  const inSet = (rel) => {
    if (!allows(preset, rel)) return false;      // профиль вынес путь из состава
    if (coreViolation(rel)) return true;         // ядро сверяется ВСЕГДА
    return placedSet.has(rel);                   // не-ядро — только то, что мы клали
  };
  for (const rel of Object.keys(refFiles)) {
    if (!allows(preset, rel) || !coreViolation(rel)) continue;
    if (sc.files[rel] === undefined) coreMissing.push(rel);
  }

  // ИСКЛЮЧЁННОЕ ИЗ СВЕРКИ — поимённо, тремя источниками: профиль, список пропущенного
  // из записи и чужие файлы проекта внутри `agents/` и `commands/`.
  const excludedSet = new Set();
  for (const rel of Object.keys(refFiles)) if (!allows(preset, rel)) excludedSet.add(rel);
  for (const rel of record.skipped) excludedSet.add(rel);
  for (const rel of Object.keys(sc.files)) {
    if (!coreViolation(rel) && !placedSet.has(rel)) excludedSet.add(rel);
  }
  const excludedAll = [...excludedSet].sort();
  const excludedCut = excludedAll.slice(0, MAX_DIVERGED);

  const mineMap = Object.create(null);
  for (const rel of Object.keys(sc.files)) if (inSet(rel)) { mineMap[rel] = sc.files[rel]; compared += 1; }
  const refMap = Object.create(null);
  for (const rel of Object.keys(refFiles)) if (inSet(rel)) refMap[rel] = refFiles[rel];

  const mineValue = valueFromMap(mineMap);
  const refPresetValue = valueFromMap(refMap);

  result.fingerprint.composition = {
    profile: preset,
    value: mineValue,
    reference: refPresetValue,
    compared,
    excluded: excludedCut.map((rel) => capText(rel).text),
    excluded_truncated: excludedAll.length > MAX_DIVERGED,
    skipped_core: record.skippedCore.slice(0, MAX_DIVERGED).map((rel) => capText(rel).text),
    core_missing: coreMissing.slice(0, MAX_DIVERGED).sort().map((rel) => capText(rel).text),
  };

  // ЯДРА НЕТ В ПРОЕКТЕ — «неизвестно» со своим кодом. Список пропущенного ядра из записи
  // уезжает рядом ОБЪЯСНЕНИЕМ: он ничего из сверки не выносит, но без него это состояние
  // не умело бы назвать причину.
  if (coreMissing.length) {
    result.fingerprint.verdict = 'unknown';
    result.fingerprint.reason = FAULT.CORE_FOREIGN;
    fault('fingerprint', FAULT.CORE_FOREIGN);
    return result;
  }

  if (mineValue === null || refPresetValue === null) {
    result.fingerprint.verdict = 'unknown';
    result.fingerprint.reason = FAULT.FINGERPRINT_UNCOUNTABLE;
    fault('fingerprint', FAULT.FINGERPRINT_UNCOUNTABLE);
    return result;
  }

  if (mineValue === refPresetValue) {
    result.fingerprint.verdict = 'match_preset';
    return result;
  }

  result.fingerprint.verdict = 'mismatch';
  const d = diverge(mineMap, refMap);
  result.fingerprint.diverged = d.list;
  result.fingerprint.truncated = d.truncated;
  return result;
}
