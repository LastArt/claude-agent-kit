#!/usr/bin/env node
/**
 * ЧИТАТЕЛЬ НАШЕЙ ЗАПИСИ О РАСКЛАДКЕ — И ЧИТАЕТСЯ ОНА КАК НЕДОВЕРЕННЫЙ ВХОД.
 *
 * Это первая строка шапки не для красоты. Запись `.claude/.cckit-deploy.json` пишет пульт
 * (`pult/deploy/deploy.mjs`), но лежит она ВНУТРИ ТОГО САМОГО ДЕРЕВА, целостность которого
 * сверяется по ней, и она СНИМАЕТ ЧАСТЬ СВЕРКИ: пути внутри `agents/` и `commands/`, честно
 * пропущенные при раскладке, из сравнения выпадают. Значит любой, кто может править файлы
 * проекта, может править и её, — а сторож, который слушается подопечного, сторожем не является.
 *
 * ЧТО ИЗ ЭТОГО СЛЕДУЕТ ПРАКТИЧЕСКИ:
 *
 *   • разбор идёт в перехвате, с потолком размера и по форме — поле за полем;
 *   • имя профиля принимается ТОЛЬКО как совпадение с закрытым словарём `PRESETS`;
 *   • каждый путь проходит те же ограничения, что записи состава в `pult/lib/fingerprint.mjs`:
 *     не абсолютный, без двух точек, без обратного слэша, без нулевого байта, в пределах
 *     потолка длины;
 *   • ПОТОЛКИ ЧИСЛА РАЗНЫЕ, и это не педантизм. К спискам ОТКЛОНЕНИЙ (пропущенное и пропущенное
 *     ядро) применяется малый потолок `MAX_DEVIATIONS`: потолок состава на них означал бы, что
 *     подделанной записью можно вынести из сверки весь механизм набора разом. К списку
 *     ПОЛОЖЕННОГО применяется потолок размера состава `MAX_PLACED`: в нём лежит весь
 *     разложенный набор, и малый потолок обрезал бы его, а обрезка честно превращается
 *     в «неизвестно» — то есть у самых полных проектов сторож замолчал бы навсегда;
 *   • НЕ ПРОШЕДШЕЕ ОТБРАСЫВАЕТСЯ ПО ОДНОМУ, а не файл целиком: одна испорченная строка
 *     не имеет права стереть весь остальной разбор;
 *   • факт обрезки ЛЮБОГО списка возвращается признаком — читатель сверки обязан превратить
 *     его в «неизвестно», а не считать по укороченному списку.
 *
 * `coreViolation()` ПРИМЕНЯЕТСЯ К КАНАЛУ ИСКЛЮЧЕНИЙ, И ТОЛЬКО К НЕМУ (уточнение круга 3
 * аудита). Путь ядра, оказавшийся в списке ПРОПУЩЕННОГО, отбрасывается поимённо с кодом:
 * его место — в третьем списке. Сам третий список (`skipped_core`) из сверки НЕ ВЫНОСИТ
 * НИЧЕГО и служит только объяснением состояния «ядро не наше»: на главном сценарии §4.2 —
 * раскладка туда, где набор уже стоит, — ядро целиком пропускается additive-копией, и без
 * этого списка карточка проекта не смогла бы назвать причину.
 *
 * ФАЙЛА НЕТ — ЭТО НЕ ОТКАЗ, а «записи нет»: так выглядят все проекты до этой фазы и все,
 * куда набор ставили промтом. Отдельного кода отказа этот случай не получает.
 *
 * Все чтения идут через примитивы `pult/lib/fs-safe.mjs`; прямых обращений к `node:fs` здесь
 * нет, и каталог пишущей раскладки (`pult/deploy/**`) этот модуль не импортирует — он часть
 * графа демона.
 */

import path from 'node:path';

import { readTextCapped, capText } from '../lib/fs-safe.mjs';
import { coreViolation, presetKey } from '../lib/profiles.mjs';
import {
  FAULT, DEPLOY_RECORD, MAX_TEXT_FILE, MAX_PLACED, MAX_DEVIATIONS, MAX_SHIP_ENTRY, TIME_RE,
} from '../config.mjs';

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

/**
 * Путь в форме состава либо `null`. Ограничения те же, что у обёртки над списком состава
 * в `pult/lib/fingerprint.mjs`: этот список тоже управляет обходом файловой системы —
 * по нему удаляет `pult/tools/kit-remove.mjs`.
 */
function shipPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SHIP_ENTRY) return null;
  if (raw.includes(NUL) || raw.includes(BACKSLASH)) return null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
  if (raw.split('/').includes('..')) return null;
  return raw;
}

/**
 * Разобрать один список путей.
 *
 * @param {*} raw       значение из записи: массив строк либо массив объектов `{path, why}`
 * @param {number} cap  потолок числа — СВОЙ у каждого списка, см. шапку
 * @param {Function} reject  необязательный дополнительный фильтр: вернул код — путь отброшен
 */
function pathList(raw, cap, reject = null) {
  const list = [];
  const codes = [];
  let truncated = false;
  if (!Array.isArray(raw)) return { list, truncated, codes };
  for (const item of raw) {
    if (list.length >= cap) { truncated = true; break; }
    const value = item && typeof item === 'object' && !Array.isArray(item) ? item.path : item;
    const rel = shipPath(value);
    if (rel === null) { codes.push(FAULT.ENTRY_REJECTED); continue; }
    if (reject) {
      const code = reject(rel);
      if (code) { codes.push(code); continue; }
    }
    if (!list.includes(rel)) list.push(rel);
  }
  return { list, truncated, codes };
}

/**
 * Прочитать запись о раскладке.
 *
 * @param {string} root      корень проекта
 * @param {object} options   `budget` — сквозной счётчик запроса
 * @returns {object} `{present, profile, version, date, placed, skipped, skippedCore,
 *                    truncated, faults}`
 */
export async function readDeployRecord(root, options = {}) {
  const budget = options.budget || null;
  const file = path.join(root, '.claude', DEPLOY_RECORD);

  const faults = [];
  const fault = (code) => {
    if (!faults.some((f) => f.field === 'deploy_record' && f.code === code)) {
      faults.push({ field: 'deploy_record', code });
    }
  };

  const result = {
    present: false,
    profile: null,
    version: null,
    date: null,
    placed: [],
    skipped: [],
    skippedCore: [],
    truncated: { placed: false, skipped: false, skipped_core: false },
    faults,
  };

  const res = await readTextCapped(file, MAX_TEXT_FILE, budget);
  if (!res.ok) {
    // Файла нет — штатное состояние, а не поломка: так выглядят все проекты до этой фазы.
    if (res.code !== FAULT.PATH_UNREACHABLE) fault(res.code);
    return result;
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    fault(FAULT.DEPLOY_RECORD_INVALID);
    return result;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fault(FAULT.DEPLOY_RECORD_INVALID);
    return result;
  }
  result.present = true;

  // Профиль — только совпадение с закрытым словарём. Чужая строка профилем не становится.
  result.profile = presetKey(data.profile);
  if (result.profile === null) fault(FAULT.ENUM_UNRECOGNISED);

  // Версия — только совпадение привязанной регулярки, как везде в пульте.
  if (typeof data.kit_version === 'string') {
    const m = data.kit_version.trim().match(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
    result.version = m ? m[0] : null;
    if (!m) fault(FAULT.VERSION_UNREADABLE);
  }

  // Дата — только как совпадение своего вида времени; «починки» негодного времени тут нет.
  if (typeof data.date === 'string' && data.date.length <= 64 && TIME_RE['utc-iso'].test(data.date)) {
    result.date = { value: data.date, kind: 'utc-iso' };
  } else if (data.date !== undefined) {
    fault(FAULT.TIME_UNRECOGNISED);
  }

  // ПОЛОЖЕННОЕ — потолок размера состава.
  const placed = pathList(data.placed, MAX_PLACED);
  result.placed = placed.list;
  result.truncated.placed = placed.truncated;
  for (const code of placed.codes) fault(code);
  if (placed.truncated) fault(FAULT.BUDGET_EXHAUSTED);

  // ПРОПУЩЕННОЕ — малый потолок И канал исключений: путь ядра здесь незаконен, его место
  // в третьем списке. Отбрасывается он ПОИМЁННО, с кодом, а не молча.
  const skipped = pathList(data.skipped, MAX_DEVIATIONS, (rel) => coreViolation(rel));
  result.skipped = skipped.list;
  result.truncated.skipped = skipped.truncated;
  for (const code of skipped.codes) fault(code);
  if (skipped.truncated) fault(FAULT.BUDGET_EXHAUSTED);

  // ПРОПУЩЕННОЕ ЯДРО — малый потолок и НИКАКОГО фильтра ядра: здесь пути ядра законны,
  // список для того и заведён. Из сверки он не выносит ничего.
  const core = pathList(data.skipped_core, MAX_DEVIATIONS);
  result.skippedCore = core.list;
  result.truncated.skipped_core = core.truncated;
  for (const code of core.codes) fault(code);
  if (core.truncated) fault(FAULT.BUDGET_EXHAUSTED);

  return result;
}

/** Короткая человеческая сводка для консольных инструментов. Наружу по HTTP не идёт. */
export function describeRecord(record) {
  if (!record.present) return 'записи о раскладке нет';
  const parts = [
    `профиль: ${capText(record.profile || '-').text}`,
    `версия набора: ${record.version || '-'}`,
    `положено: ${record.placed.length}${record.truncated.placed ? ' (обрезано)' : ''}`,
    `пропущено: ${record.skipped.length}${record.truncated.skipped ? ' (обрезано)' : ''}`,
    `пропущено ядра: ${record.skippedCore.length}${record.truncated.skipped_core ? ' (обрезано)' : ''}`,
  ];
  return parts.join(' · ');
}
