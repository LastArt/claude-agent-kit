#!/usr/bin/env node
/**
 * Эталон для сверки отпечатка — мастер-копия набора в домашнем каталоге.
 *
 *   <HOME>/.claude/agent-kit
 *
 * Домашний каталог берётся у рантайма (`os.homedir()`), нигде не хардкодится и в этот файл
 * не вписан.
 *
 * ПОРЯДОК ОБРАЩЕНИЯ К ПУТИ — ТОТ ЖЕ, ЧТО У ПРОЕКТОВ, И ПО ТОЙ ЖЕ ПРИЧИНЕ.
 *   1. Сначала ФОРМА пути: сетевая (UNC) отбрасывается без единого обращения к диску.
 *      Домашний каталог на сетевом ресурсе — перенаправленный профиль Windows, домашние
 *      каталоги по NFS — не выдумка, а обращение к такому пути уходит в сеть к чужому хосту
 *      с попыткой аутентификации. Проекты этот случай отбивают в реестре, и у эталона
 *      поблажки нет.
 *   2. Затем АСИНХРОННАЯ проба доступности в гонке с собственным таймаутом.
 *   3. И только после её успеха — синхронный обход.
 *
 * Собственный временной бюджет здесь не спасает: он проверяется МЕЖДУ путями обхода и один
 * зависший системный вызов не прерывает, а эталон трогается первым на каждом запросе — цикл
 * событий встал бы ДО маршрутизации, вместе с проверкой здоровья, которой протокол приёмки
 * велит отвечать всегда.
 *
 * ПОЧЕМУ ЭТАЛОН СЧИТАЕТСЯ ПЕРВЫМ И ПО СВОЕМУ БЮДЖЕТУ. Иначе проект, просканированный раньше,
 * выбирает сквозной бюджет целиком, эталон не считается, и `verdict: unknown` получают ВСЕ
 * проекты ответа — то есть сверку целостности кита гасит один чужой каталог в реестре.
 *
 * Недоступный эталон ведёт себя ровно как отсутствующий: это `verdict: unknown` и запись
 * в списке отказов, а не ошибка запроса. Различает их только код.
 *
 * УСЕЧЕНИЕ ОБХОДА ЭТАЛОНА значит, что эталона нет: значение не выдаётся, вердикт у всех
 * проектов — `unknown` с кодом «усечён обход эталона». Хеш от неполного состава эталоном
 * не считается.
 *
 * ПРИЗНАК НАЗЫВАЕТСЯ `scan_truncated` — ТЕМ ЖЕ ИМЕНЕМ, ЧТО У ПРОЕКТА, И ЗНАЧИТ ТО ЖЕ САМОЕ.
 * Сначала он звался здесь `truncated`, а у проекта это имя занято обрезкой списка расхождений,
 * то есть противоположным смыслом: «показано не всё» против «посчитано не по всему».
 * Потребитель фазы 2, читающий поле единообразно, обязан был ошибиться на одном из двух
 * объектов, — поэтому одинаковые имена оставлены только у одинаковых смыслов.
 *
 * Эталон читается ОДИН РАЗ на HTTP-запрос и передаётся читателям проектов аргументом;
 * между запросами не хранится ничего. Все чтения идут через примитивы
 * `pult/lib/fs-safe.mjs` — прямых обращений к `node:fs` в этом файле нет.
 */

import path from 'node:path';
import os from 'node:os';

import { statSafe, readTextCapped, isUncPath, makeBudget, faultFromError } from '../lib/fs-safe.mjs';
import { scan } from '../lib/fingerprint.mjs';
import { FAULT, BUDGET_REFERENCE, VERSION_RE, MAX_TEXT_FILE } from '../config.mjs';

/** Путь мастер-копии набора. */
export function referenceDir() {
  return path.join(os.homedir(), '.claude', 'agent-kit');
}

/**
 * Проба доступности в гонке с таймаутом. Возвращает `{ok, stat}` либо `{ok:false, code}`.
 *
 * Зависшая проба продолжает держать поток пула файловых операций даже после того, как гонка
 * вернула отказ, — это известная цена решения (риск 1 плана): прервать системный вызов
 * из JavaScript нельзя. Регулярный опрос по мёртвой букве сетевого диска на фазе 2 такие
 * пробы копит, и лечится это только выносом обхода в рабочий поток.
 */
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

/** Версия набора: первая строка файла версии и только как совпадение регулярки. */
async function readVersion(kitDir, budget) {
  const res = await readTextCapped(path.join(kitDir, 'VERSION'), MAX_TEXT_FILE, budget);
  if (!res.ok) return { version: null, code: res.code };
  const first = res.text.split(/\r?\n/)[0];
  if (typeof first !== 'string' || first.length > 32) {
    return { version: null, code: FAULT.VERSION_UNREADABLE };
  }
  const m = first.trim().match(VERSION_RE);
  if (!m) return { version: null, code: FAULT.VERSION_UNREADABLE };
  return { version: m[0], code: null };
}

/**
 * Прочитать эталон. Возвращает путь, версию и подробный отпечаток; ошибок наружу не бросает.
 *
 * @param {object} options `dir` — подменить путь эталона (нужно проверкам), `budget` — свой
 *                         счётчик; по умолчанию заводится собственный бюджет эталона.
 */
export async function readReference(options = {}) {
  const dir = options.dir === undefined ? referenceDir() : options.dir;
  const budget = options.budget || makeBudget(BUDGET_REFERENCE);
  const result = {
    path: dir,
    version: null,
    fingerprint: { value: null, scan_truncated: false, reason: null },
    faults: [],
  };

  const fault = (code) => {
    result.fingerprint.reason = code;
    if (!result.faults.some((f) => f.code === code)) result.faults.push({ field: 'reference', code });
    return result;
  };

  // 1. Форма пути — до любого обращения к диску.
  if (typeof dir !== 'string' || !dir) return fault(FAULT.REFERENCE_MISSING);
  if (isUncPath(dir)) return fault(FAULT.REFERENCE_UNREACHABLE);

  // 2. Асинхронная проба в гонке с собственным таймаутом.
  const st = await probe(dir, BUDGET_REFERENCE.ms);
  if (!st.ok) {
    return fault(st.code === FAULT.PATH_UNREACHABLE ? FAULT.REFERENCE_MISSING : FAULT.REFERENCE_UNREACHABLE);
  }
  if (!st.stat.isDirectory()) return fault(FAULT.REFERENCE_UNREACHABLE);

  // 3. Синхронный обход по собственному бюджету.
  let sc;
  try {
    sc = scan(dir, { budget, files: BUDGET_REFERENCE.files, bytes: BUDGET_REFERENCE.bytes });
  } catch (e) {
    return fault(faultFromError(e));
  }

  const v = await readVersion(dir, budget);
  result.version = v.version;
  if (v.code) result.faults.push({ field: 'reference.version', code: v.code });

  if (sc.truncated) {
    result.fingerprint = { value: null, scan_truncated: true, reason: FAULT.REFERENCE_SCAN_TRUNCATED };
    result.faults.push({ field: 'reference.fingerprint', code: FAULT.REFERENCE_SCAN_TRUNCATED });
    result.files = Object.create(null);
    return result;
  }

  result.fingerprint = { value: sc.value, scan_truncated: false, reason: sc.reason };
  if (sc.value === null) {
    result.faults.push({ field: 'reference.fingerprint', code: sc.reason || FAULT.FINGERPRINT_UNCOUNTABLE });
  }
  // Пофайловое отображение эталона нужно для списка расхождений и наружу само не идёт.
  result.files = sc.files;
  return result;
}
