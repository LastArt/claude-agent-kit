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
 * `mismatch` при усечении не выдаётся НИКОГДА: обход с выпавшим файлом даёт ложную тревогу
 * ровно на том сигнале, ради которого отпечаток заводили. Ложная тревога обесценивает сигнал
 * так же надёжно, как молчание.
 */

import path from 'node:path';

import { statSafe, readTextCapped, capText } from '../lib/fs-safe.mjs';
import { scan } from '../lib/fingerprint.mjs';
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

  // Обход неполон — дальше сравнивать нечего: отпечаток от неполного состава не отпечаток.
  if (sc.truncated) {
    result.fingerprint.value = null;
    result.fingerprint.scan_truncated = true;
    result.fingerprint.reason = sc.reason || FAULT.SCAN_TRUNCATED;
    result.fingerprint.verdict = 'unknown';
    fault('fingerprint', result.fingerprint.reason);
    return result;
  }

  result.fingerprint.value = sc.value;
  if (sc.value === null) {
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

  if (sc.value === refValue) {
    result.fingerprint.verdict = 'match';
    return result;
  }

  result.fingerprint.verdict = 'mismatch';
  const d = diverge(sc.files, reference.files || Object.create(null));
  result.fingerprint.diverged = d.list;
  result.fingerprint.truncated = d.truncated;
  return result;
}
