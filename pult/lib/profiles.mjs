#!/usr/bin/env node
/**
 * Профили состава набора, правило ядра и формула отпечатка по составу — ЧИСТЫЙ модуль.
 *
 * ПОЧЕМУ ОН ЛЕЖИТ ЗДЕСЬ, А НЕ В КАТАЛОГЕ РАСКЛАДКИ (находка A круга 2 аудита фазы 4).
 * Эти функции зовут ЧИТАТЕЛИ ДЕМОНА: `pult/server.mjs` → `pult/read/project.mjs` →
 * `pult/read/kit.mjs`. Положи их в `pult/deploy/`, и каталог пишущей раскладки войдёт в граф
 * импортов демона — то есть покрасит собственную проверку каталожного правила (проверка 2
 * в `pult/tools/deploy-check.mjs`), а самым дешёвым выходом из красной проверки стало бы
 * её ослабление. Поэтому чистое живёт здесь, рядом с копией алгоритма отпечатка
 * (`pult/lib/fingerprint.mjs`), а в `pult/deploy/` остаётся только пишущее.
 *
 * ОТСЮДА ГЛАВНОЕ ОГРАНИЧЕНИЕ МОДУЛЯ: НИ ОДНОГО ОБРАЩЕНИЯ К ДИСКУ И НИ ОДНОГО ПОДПРОЦЕССА.
 * Ни `node:fs`, ни `node:child_process`, ни импортов из `pult/deploy`. Это проверяется машинно
 * (та же проверка 2), и правило держится не аккуратностью, а тем, что нарушение красит прогон.
 *
 * ФОРМУЛА ОТПЕЧАТКА ПОЯВЛЯЕТСЯ ВТОРЫМ ЭКЗЕМПЛЯРОМ, и это названо вслух — ровно как у сторожа
 * копии алгоритма. `valueFromMap()` обязана на ПОЛНОЙ карте без фильтра давать в точности то,
 * что вернул `scan()` из `pult/lib/fingerprint.mjs`; расхождение копий — молчаливое, поэтому
 * равенство проверяется машинно (проверка 1 инструмента `pult/tools/deploy-check.mjs`).
 *
 * ЯДРО ЗАДАНО ПРАВИЛОМ, А НЕ ПЕРЕЧНЕМ ИМЁН, и это решение аудита (круг 1, находка 3). Перечень
 * имён охранял бы `PROJECT_PROFILE.md`, которого в составе не бывает вовсе: в списке состава
 * лежит `PROJECT_PROFILE.template.md`. Правило же формулируется от РЕАЛЬНЫХ СТРОК состава:
 * исключать можно только пути внутри `agents/` и `commands/`, всё прочее — ядро.
 *
 * КАНАЛ `coreViolation()` — ИСКЛЮЧЕНИЯ ИЗ СВЕРКИ, И ТОЛЬКО ОНИ (уточнение круга 3). Она
 * не решает, что записывать в отчёт о раскладке: «путь ядра пропущен, потому что файл уже был
 * у человека» — это объяснение, а не исключение, и живёт оно отдельным списком в записи.
 */

import { createHash } from 'node:crypto';

import { FAULT } from '../config.mjs';

/**
 * ЗАКРЫТЫЙ СЛОВАРЬ ПРОФИЛЕЙ. Три и только три (§4.3 контракта: свободных тумблеров не заводить —
 * тридцать уникальных конфигураций делают статистику поперёк проектов бессмысленной).
 *
 * Состав описывается СПИСКОМ ИСКЛЮЧЕНИЙ ОТ ПОЛНОГО СОСТАВА, а не своим перечнем файлов: полный
 * состав приходит из `.claude/ship.list` мастер-копии (договор с фазой 4, пункт 1), и второй
 * перечень разошёлся бы с ним молча при первом же добавлении файла в набор.
 *
 * ИСКЛЮЧЕНИЯ — ТОЧНЫЕ ОТНОСИТЕЛЬНЫЕ ПУТИ ИЛИ КАТАЛОГИ, БЕЗ ЗВЁЗДОЧЕК И ОБРАЗЦОВ. Образец
 * промахивается молча: переименовали файл — образец перестал совпадать, и в проект уехало то,
 * что человек просил не класть, без единой строки об этом. Каталог обозначается слэшем в конце.
 *
 * ЧТО ОСТАЁТСЯ ДАЖЕ В САМОМ УЗКОМ ПРОФИЛЕ: хуки, настройки, промт оркестратора, шаблон профиля,
 * заготовки рабочих мест и команды установки, обновления, снятия, помощи и разведки — то есть
 * всё, чем набор проверяет проект и обслуживает сам себя.
 */
export const PRESETS = Object.freeze({
  full: Object.freeze({
    title: 'полный',
    exclude: Object.freeze([]),
  }),
  'no-docs': Object.freeze({
    title: 'без документации',
    exclude: Object.freeze([
      'agents/documenter.md',
      'agents/faq-writer.md',
      'agents/changelog-writer.md',
      'commands/cckit_docs.md',
      'commands/cckit_faq.md',
      'commands/cckit_release.md',
    ]),
  }),
  'checks-only': Object.freeze({
    title: 'только проверки',
    exclude: Object.freeze([
      // Каталог целиком: в этом профиле конвейера нет вовсе, есть проверки и обслуживание.
      'agents/',
      'commands/cckit_audit.md',
      'commands/cckit_commits.md',
      'commands/cckit_docs.md',
      'commands/cckit_explore.md',
      'commands/cckit_explore_parallel.md',
      'commands/cckit_faq.md',
      'commands/cckit_feature.md',
      'commands/cckit_implement.md',
      'commands/cckit_plan.md',
      'commands/cckit_quick.md',
      'commands/cckit_recall.md',
      'commands/cckit_release.md',
      'commands/cckit_review.md',
      'commands/cckit_what_plan.md',
    ]),
  }),
});

/** Ключи профилей в порядке от полного к узкому. Порядок показа человеком берётся отсюда. */
export const PRESET_KEYS = Object.freeze(Object.keys(PRESETS));

/** Полный профиль: значение по умолчанию везде, где профиль не назван. */
export const PRESET_DEFAULT = 'full';

/** Ключ из закрытого словаря либо `null`. Чужая строка профилем не становится никогда. */
export function presetKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 32) return null;
  return Object.prototype.hasOwnProperty.call(PRESETS, raw) ? raw : null;
}

/** Русское имя профиля для показа человеком. Неизвестный ключ — пустая строка, а не догадка. */
export function presetTitle(key) {
  const k = presetKey(key);
  return k ? PRESETS[k].title : '';
}

/** Список исключений профиля. Неизвестный ключ — пустой список: «ничего не исключаем». */
export function presetExcludes(key) {
  const k = presetKey(key);
  return k ? PRESETS[k].exclude.slice() : [];
}

/**
 * Два каталога, внутри которых исключение законно. Всё прочее в составе — ЯДРО.
 *
 * Список короткий и закрытый намеренно: он и есть определение ядра. Добавление сюда третьего
 * каталога — это решение человека о том, что ещё разрешено выносить из сверки целостности.
 */
const EXCLUDABLE_DIRS = Object.freeze(['agents/', 'commands/']);

/** Путь в форме состава: относительный, со слэшами, без двух точек и ведущего слэша. */
function shipRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (rel.includes(String.fromCharCode(92))) return null;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  if (rel.split('/').includes('..')) return null;
  return rel.replace(/\/+$/, '');
}

/**
 * Метит ли путь в ЯДРО: код отказа либо `null`.
 *
 * КАНАЛ ЭТОЙ ФУНКЦИИ — ИСКЛЮЧЕНИЯ ИЗ СВЕРКИ, И ТОЛЬКО ОНИ. Ею проверяются списки исключений
 * профилей (на загрузке модуля) и список исключённого, приехавший из записи о раскладке
 * (`pult/read/deploy-record.mjs`, шаг 11). Она НЕ решает, что записывать в отчёт: путь ядра,
 * пропущенный additive-копией, потому что файл уже был у человека, — законный факт, который
 * обязан быть записан и показан, а не отброшен как «попытка исключить ядро».
 *
 * Негодная форма пути считается ЯДРОМ: направление отказа безопасное — непонятное не выносится
 * из сверки.
 */
export function coreViolation(rel) {
  const clean = shipRel(rel);
  if (clean === null) return FAULT.EXCLUDE_HITS_CORE;
  for (const dir of EXCLUDABLE_DIRS) {
    if (clean === dir.slice(0, -1)) return null;          // сам каталог целиком
    if (clean.startsWith(dir)) return null;               // путь внутри каталога
  }
  return FAULT.EXCLUDE_HITS_CORE;
}

/**
 * Входит ли путь в состав профиля.
 *
 * Сверка точная: либо путь равен строке исключения, либо лежит внутри исключённого каталога.
 * Никаких образцов — см. довод у `PRESETS`.
 */
export function allows(preset, rel) {
  const clean = shipRel(rel);
  if (clean === null) return false;
  for (const raw of presetExcludes(preset)) {
    const ex = shipRel(raw);
    if (ex === null) continue;
    if (clean === ex) return false;
    if (raw.endsWith('/') && clean.startsWith(`${ex}/`)) return false;
  }
  return true;
}

/**
 * ЗНАЧЕНИЕ ОТПЕЧАТКА ПО КАРТЕ «путь — хеш файла», отфильтрованной предикатом.
 *
 * Формула — та же, что в `fingerprint()` (`pult/lib/fingerprint.mjs`): строки «путь, знак
 * табуляции, хеш», сортировка, склейка переводом строки, sha256, шесть знаков. Копия названа
 * в шапке; равенство копий на ПОЛНОЙ карте проверяется машинно.
 *
 * Пустая карта даёт `null`, а не хеш пустой строки, — ровно как оригинал: «считать не из чего»
 * и «состав пуст» здесь одно и то же, и выдавать за отпечаток шесть знаков от пустоты нельзя.
 *
 * @param {object}   map     карта `путь → хеш`, как её возвращает `scan()`
 * @param {Function} filter  предикат `(rel) => boolean`; по умолчанию берётся всё
 */
export function valueFromMap(map, filter = null) {
  if (!map || typeof map !== 'object') return null;
  const lines = [];
  for (const rel of Object.keys(map)) {
    if (typeof filter === 'function' && !filter(rel)) continue;
    const hash = map[rel];
    if (typeof hash !== 'string' || !hash) continue;
    lines.push(`${rel}\t${hash}`);
  }
  if (!lines.length) return null;
  lines.sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 6);
}

/**
 * Карта эталона, суженная профилем, — то же самое, но списком путей: он нужен сверке ядра
 * (шаг 12) и показу исключённого на карточке.
 */
export function presetPaths(preset, map) {
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map).filter((rel) => allows(preset, rel)).sort();
}

// СВЕРКА НА ЗАГРУЗКЕ: НИ ОДНО ИСКЛЮЧЕНИЕ НИ ОДНОГО ПРОФИЛЯ НЕ ИМЕЕТ ПРАВА МЕТИТЬ В ЯДРО.
//
// Обещание «исключать можно только `agents/` и `commands/`» иначе держалось бы на внимательности
// того, кто правит список выше, — а список правят как раз тогда, когда хотят вынести из сверки
// что-нибудь ещё. Файл — константы без ввода-вывода, поэтому расхождение возможно только при
// правке ЭТОГО файла, и падение на старте здесь дешевле, чем профиль, молча выносящий из сверки
// хук приёмки. Тот же приём стоит в `pult/config.mjs` у списка запрещённых корней.
for (const key of PRESET_KEYS) {
  for (const rel of PRESETS[key].exclude) {
    if (coreViolation(rel)) {
      throw new Error(`pult/lib/profiles.mjs: исключение профиля «${key}» метит в ядро`);
    }
  }
}
