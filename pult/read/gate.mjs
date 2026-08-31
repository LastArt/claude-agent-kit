#!/usr/bin/env node
/**
 * Гейт и отчёт машинной приёмки.
 *
 * Состояние читается из рабочего файла гейта: файла нет — это «взвод снят», в ответе `null`
 * и никакого отказа. Битый JSON — тоже `null`, но с кодом: ровно так читает своё состояние
 * `readState()` в `.claude/hooks/gate.mjs`.
 *
 * ОТДАЁТСЯ ЗАКРЫТЫЙ БЕЛЫЙ СПИСОК ПОЛЕЙ И НИЧЕГО СВЕРХ НЕГО.
 *   из состояния гейта — `task_id`, `status`, `attempts`, `armed_at`, `verify`;
 *   из отчёта приёмки — `status`, `total`, `passed`, `failed_count`, `failed`.
 *
 * НЕ ПОКИДАЮТ ПРОЦЕСС НИ ПРИ КАКИХ РЕЖИМАХ И КЛЮЧАХ: `checks[]` целиком, `cmd` (командная
 * строка из чужого профиля), `tail` (сырой хвост вывода упавшей команды), `checks_hash`,
 * `tools_hash`, `fingerprint`, а также поле `task` — это ЗАГОЛОВОК задачи, свободный текст
 * человека, и его отсутствие в ответе есть решение, а не совпадение. Причина: отчёт приёмки
 * пишется `writeSecure()` в `.claude/hooks/verify.mjs` с режимом `0600` намеренно, а маскирование
 * секретов — последний рубеж, на который профиль проекта прямо запрещает полагаться.
 *
 * БЕЛЫЙ СПИСОК ФОРМОЙ ЗНАЧЕНИЯ НЕ ЗАМЕНЯЕТСЯ. `armed_at` отдаётся только через единственную
 * дверь к временам в виде `utc-iso` (гейт пишет его временем в UTC — см. `arm()`
 * в `.claude/hooks/gate.mjs`); перечислимые поля — только как совпадение с закрытым словарём.
 *
 * ЛОВУШКА, В КОТОРУЮ НЕЛЬЗЯ ПОПАСТЬ: слова `stale`, `none`, `fail`, `error` встречаются
 * в том же хуке как payload события `gate_result`, а НЕ как состояние на диске. Словари
 * не сливать: в файле живут три значения `status` (`implementing` от `arm()`, `verified`
 * и `blocked` от `decide()` — все три через `writeState()`) и четыре значения `verify`.
 *
 * `verified` в перечень «только payload» НЕ входит, и это исправленная ошибка, а не мелочь:
 * оно и payload, и состояние на диске, причём самое частое здоровое. Пока словарь знал два
 * значения из трёх, у прошедшего приёмку проекта `status` уходил в `null` с кодом
 * «нераспознанное значение перечислимого поля» — белый список честно отбивал живое значение
 * кита. Словарь — снимок, и сверяется он с китом при каждом обновлении набора.
 *
 * И ВТОРОЕ, ЧТО НЕЛЬЗЯ СЛИВАТЬ: статус гейта и статус задачи — два разных «заблокировано».
 * Приёмка меряет рабочее ДЕРЕВО, а дерево одно на все задачи; связь с задачей — только поле
 * идентификатора, и приписывать чужой вердикт задаче значило бы врать.
 *
 * Все чтения — через примитивы `pult/lib/fs-safe.mjs`; прямых обращений к `node:fs` нет.
 */

import path from 'node:path';

import { readTextCapped, capText, timeField, enumField, counterField } from '../lib/fs-safe.mjs';
import {
  FAULT, ENUM, TASK_ID_RE, TASK_ID_MAX, MAX_TEXT_FILE, MAX_TEXT,
} from '../config.mjs';

/** Разбор JSON без исключения наружу. */
function parseJson(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Строка из чужого JSON — только через очистку и потолок. */
function text(value, faults, field) {
  if (typeof value !== 'string') return null;
  const t = capText(value, MAX_TEXT);
  if (t.truncated) faults.push({ field, code: FAULT.TEXT_TRUNCATED });
  return t.text || null;
}

/** Отчёт приёмки: пять полей и ни одним больше. */
async function readReport(kitDir, budget, faults) {
  const res = await readTextCapped(path.join(kitDir, 'artifacts', 'VERIFY.json'), MAX_TEXT_FILE, budget);
  if (!res.ok) {
    if (res.code !== FAULT.PATH_UNREACHABLE) {
      faults.push({ field: 'verify_report', code: FAULT.VERIFY_REPORT_UNREADABLE });
    }
    return null;
  }
  const data = parseJson(res.text);
  if (!data) {
    faults.push({ field: 'verify_report', code: FAULT.VERIFY_REPORT_UNREADABLE });
    return null;
  }

  const status = enumField(typeof data.status === 'string' ? data.status : '', ENUM.gateVerify);
  if (status === null) faults.push({ field: 'verify_report.status', code: FAULT.ENUM_UNRECOGNISED });

  const num = (name) => {
    const value = counterField(String(data[name] === undefined || data[name] === null ? '' : data[name]));
    if (value === null && data[name] !== undefined && data[name] !== null) {
      faults.push({ field: `verify_report.${name}`, code: FAULT.ENUM_UNRECOGNISED });
    }
    return value;
  };

  // `failed` в отчёте — строка с именами упавших проверок через запятую либо null.
  let failed = null;
  if (typeof data.failed === 'string' && data.failed) {
    failed = data.failed.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 32)
      .map((name) => text(name, faults, 'verify_report.failed'))
      .filter((name) => name !== null);
  } else if (Array.isArray(data.failed)) {
    failed = data.failed.slice(0, 32)
      .map((name) => text(name, faults, 'verify_report.failed'))
      .filter((name) => name !== null);
  }

  return {
    status,
    total: num('total'),
    passed: num('passed'),
    failed_count: num('failed_count'),
    failed,
  };
}

/**
 * Состояние приёмки проекта.
 *
 * @param {string} kitDir  папка кита проекта
 * @param {object} options `budget` — сквозной счётчик запроса
 * @returns {{gate: object|null, faults: Array}}
 */
export async function readGate(kitDir, options = {}) {
  const budget = options.budget || null;
  const faults = [];

  const res = await readTextCapped(path.join(kitDir, 'artifacts', 'GATE_STATE.json'), MAX_TEXT_FILE, budget);
  if (!res.ok) {
    // Файла нет — взвод снят. Это не отказ, а обычное состояние проекта без задачи в работе.
    if (res.code !== FAULT.PATH_UNREACHABLE) {
      faults.push({ field: 'gate', code: FAULT.GATE_STATE_UNREADABLE });
    }
    return { gate: null, faults };
  }

  const data = parseJson(res.text);
  if (!data) {
    faults.push({ field: 'gate', code: FAULT.GATE_STATE_UNREADABLE });
    return { gate: null, faults };
  }

  const rawId = typeof data.task_id === 'string' ? data.task_id : '';
  let taskId = null;
  if (rawId) {
    if (rawId.length <= TASK_ID_MAX && TASK_ID_RE.test(rawId)) taskId = rawId;
    else faults.push({ field: 'gate.task_id', code: FAULT.GATE_STATE_UNREADABLE });
  }

  const status = enumField(typeof data.status === 'string' ? data.status : '', ENUM.gateStatus);
  if (status === null) faults.push({ field: 'gate.status', code: FAULT.ENUM_UNRECOGNISED });

  const verify = enumField(typeof data.verify === 'string' ? data.verify : '', ENUM.gateVerify);
  if (verify === null) faults.push({ field: 'gate.verify', code: FAULT.ENUM_UNRECOGNISED });

  const attempts = counterField(String(data.attempts === undefined || data.attempts === null ? '' : data.attempts));
  if (attempts === null && data.attempts !== undefined && data.attempts !== null) {
    faults.push({ field: 'gate.attempts', code: FAULT.ENUM_UNRECOGNISED });
  }

  let armedAt = null;
  if (typeof data.armed_at === 'string' && data.armed_at) {
    armedAt = timeField(data.armed_at, 'utc-iso');
    if (!armedAt) faults.push({ field: 'gate.armed_at', code: FAULT.TIME_UNRECOGNISED });
  }

  const report = await readReport(kitDir, budget, faults);

  // Поля переносятся поимённо: разобранный чужой объект не разворачивается никогда.
  return {
    gate: {
      task_id: taskId,
      status,
      attempts,
      verify,
      armed_at: armedAt,
      verify_report: report,
    },
    faults,
  };
}
