#!/usr/bin/env node
/**
 * СЛИЯНИЕ С ЧУЖИМ ФАЙЛОМ НАСТРОЕК — самая дорогая ошибка фазы: она платится через недели.
 *
 * Файл `settings.json` общий с проектом, вынести его нельзя (§4.4 контракта). Поэтому здесь
 * не «запись настроек», а слияние с уважением к чужому, и правил шесть.
 *
 * (а) РАЗБОР. Файла нет — заводим свой и помечаем `created_file`. Не разбирается как JSON
 *     (комментарии, хвостовая запятая, обрезанный хвост) — ОТКАЗ с человеческой причиной
 *     и БЕЗ ЕДИНОЙ ПРАВКИ. «Починить» чужой файл, который мы не смогли прочитать, нельзя
 *     ни при каких обстоятельствах: за скобкой, которую мы не поняли, стоят чужие правила.
 *
 * (б) ПРАВА. Добавляются недостающие строки набора. СТРОКА, УЖЕ БЫВШАЯ В ФАЙЛЕ, ВО ВЛАДЕНИЕ
 *     НЕ ЗАПИСЫВАЕТСЯ НИКОГДА — иначе снос унесёт правило, которое человек написал сам.
 *
 * (в) ХУКИ. Наши ставятся СВОЕЙ ГРУППОЙ отдельным элементом массива события; чужая группа
 *     не правится вовсе. Внутри нашей порядок задан ЯВНО: `session.mjs --start` первым,
 *     `banner.mjs --compact` вторым. Это не вкусовщина: хуки одной группы делят общий бюджет
 *     времени, баннер умеет выбрать его почти целиком, и при обратном порядке запись границы
 *     сессии гибнет МОЛЧА (проверено в наборе, см. `.claude/PROJECT_PROFILE.md` §3, `banner.mjs`).
 *
 * (г) ВЛАДЕНИЕ — ОБЪЕДИНЕНИЕ ПРЕЖНЕГО И ДОБАВЛЕННОГО. При повторной additive-раскладке наши
 *     строки уже в файле, то есть «не добавлены», — и без объединения они выпали бы из владения,
 *     а снос оставил бы их в чужом файле навсегда. Прежнее владение читается как НЕДОВЕРЕННЫЙ
 *     ВХОД: форма, потолки, незнакомое отбрасывается поимённо.
 *
 * (д) НАША ГРУППА ХУКОВ ЗАПИСЫВАЕТСЯ ВО ВЛАДЕНИЕ ДОСЛОВНО, а не номером в массиве: номер
 *     сдвигается от любой правки человека, и снос по номеру унёс бы чужую группу.
 *
 * (е) ЗАПИСЬ — через `writeWholeFile()`, то есть временный файл плюс переименование.
 *     ФОРМАТИРОВАНИЕ JSON ПРИ ЭТОМ НОРМАЛИЗУЕТСЯ, и это НАЗВАННОЕ СЛЕДСТВИЕ, а не сюрприз:
 *     объект пересобирается разбором и печатается с отступом в два пробела. Резервная копия
 *     папки набора к этому моменту уже лежит на диске (шаг 5 плана фазы 4).
 */

import path from 'node:path';

import { capText } from '../lib/fs-safe.mjs';
import { FAULT, MAX_PLACED, MAX_TEXT } from '../config.mjs';
import { readBytes, writeWholeFile } from './fs.mjs';
import { KIT_DIR_NAME } from './gate.mjs';

/** Имя файла настроек — одно на весь раскладчик. */
export const SETTINGS_NAME = 'settings.json';

/** Служебный ключ владения. Незнакомые ключи верхнего уровня платформа проглатывает (§4.4). */
export const OWNS_KEY = '_cckit';

/** Имя события хуков: латиница, до 32 знаков. Чужое имя во владение не попадает. */
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * ПОРЯДОК ВНУТРИ НАШЕЙ ГРУППЫ ХУКОВ — ЗАДАН ЯВНО, А НЕ УНАСЛЕДОВАН ИЗ ИСТОЧНИКА.
 *
 * Источник (мастер-копия) сегодня хранит верный порядок, но он там держится тем же самым
 * знанием, и правка мастер-копии, переставившая две строки, разъехалась бы с этим правилом
 * молча. Здесь порядок — код, и его стережёт отрицательная проба `hookorder`
 * инструмента `pult/tools/deploy-check.mjs`.
 */
const HOOK_ORDER = Object.freeze(['session.mjs --start', 'banner.mjs']);

function hookRank(entry) {
  const cmd = entry && typeof entry.command === 'string' ? entry.command : '';
  for (let i = 0; i < HOOK_ORDER.length; i += 1) {
    if (cmd.includes(HOOK_ORDER[i])) return i;
  }
  return HOOK_ORDER.length;
}

/** Наша группа с явно упорядоченными хуками. Устойчивая сортировка: незнакомые остаются как были. */
function orderGroup(group) {
  if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return group;
  const ranked = group.hooks.map((h, i) => ({ h, i, r: hookRank(h) }));
  ranked.sort((a, b) => (a.r - b.r) || (a.i - b.i));
  return { ...group, hooks: ranked.map((x) => x.h) };
}

/**
 * КАНОНИЧЕСКИЙ ВИД: рекурсивная сортировка ключей перед сравнением.
 *
 * Зачем он здесь (🟡 3 ревью 03.09.2026). Сравнение объектов через `JSON.stringify` зависит
 * от ПОРЯДКА КЛЮЧЕЙ: группа, записанная как `{hooks:[…], matcher:''}` — то есть прошедшая через
 * любой форматтер JSON или руку человека, — не узнаётся, и повторная раскладка добавляет ВТОРУЮ
 * копию нашей группы. Следствие видимое: старт сессии и баннер отрабатывают дважды и делят
 * общий бюджет времени, то есть возвращается ровно та поломка, ради которой задан порядок
 * внутри группы.
 *
 * В СНОСЕ сверка остаётся СТРОГОЙ, и это не забывчивость: там ошибка обязана быть в безопасную
 * сторону («не совпало — не трогаю»), а канонический вид сделал бы снос смелее.
 */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

/** Две группы хуков одинаковы, если одинаков их КАНОНИЧЕСКИЙ разбор. */
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * Строка прав, пригодная к записи: непустая, в пределах потолка, без управляющих символов.
 *
 * СТРОКА СВЕРХ ПОТОЛКА ОТБРАСЫВАЕТСЯ ЦЕЛИКОМ, А НЕ УКОРАЧИВАЕТСЯ (⚪ 3 ревью 03.09.2026).
 * Правило прав — не свободный текст: обрезанный образец разрешает не то, что исходный
 * (`Bash(git push origin …)` без хвоста — это уже другое правило), и попадал бы он в файл
 * человека. Обрезка уместна в заголовке задачи, здесь она меняет смысл.
 */
function ruleLine(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const { text, truncated } = capText(raw, MAX_TEXT);
  if (truncated) return null;
  return text || null;
}

/**
 * Прежнее владение — НЕДОВЕРЕННЫЙ ВХОД. Читается по форме, с потолками, незнакомое
 * отбрасывается поимённо: файл правят руками, он приезжает с копией чужой папки и переживает
 * порчу диска.
 */
export function readOwns(raw) {
  const owns = { allow: [], deny: [], hooks: {} };
  const dropped = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { owns, dropped };

  for (const key of ['allow', 'deny']) {
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    for (const item of list) {
      if (owns[key].length >= MAX_PLACED) { dropped.push(`${key}: сверх потолка`); break; }
      const line = ruleLine(item);
      if (!line) { dropped.push(`${key}: негодная строка`); continue; }
      if (!owns[key].includes(line)) owns[key].push(line);
    }
  }

  const hooks = raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (!EVENT_RE.test(event)) { dropped.push(`hooks: негодное имя события`); continue; }
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const group of groups) {
      if (kept.length >= MAX_PLACED) { dropped.push(`hooks.${event}: сверх потолка`); break; }
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        dropped.push(`hooks.${event}: негодная группа`);
        continue;
      }
      kept.push(group);
    }
    if (kept.length) owns.hooks[event] = kept;
  }
  return { owns, dropped };
}

/** Пути файла настроек проекта. */
export function settingsPath(root) {
  return path.join(root, KIT_DIR_NAME, SETTINGS_NAME);
}

/** Относительный путь для шлюза. */
export function settingsRel() {
  return `${KIT_DIR_NAME}/${SETTINGS_NAME}`;
}

/**
 * Слить наши строки с файлом настроек проекта.
 *
 * @param {object} ctx     контекст записи (`writeContext()` из `pult/deploy/fs.mjs`)
 * @param {object} source  РАЗОБРАННЫЙ `settings.json` мастер-копии — источник наших строк
 * @param {object} options `dry` — посчитать и ничего не записывать
 */
export async function mergeSettings(ctx, source, options = {}) {
  const dry = options.dry === true;
  const file = settingsPath(ctx.root);
  const report = {
    ok: false, code: null, message: '', createdFile: false, wrote: false,
    addedAllow: [], addedDeny: [], addedHooks: [], keptHooks: [], dropped: [], owns: null,
  };

  // (а) Разбор. Файла нет — заводим свой; не разобрался — отказ БЕЗ единой правки.
  const read = await readBytes(file);
  let current = null;
  if (read.ok) {
    let text;
    try {
      text = read.buf.toString('utf8');
    } catch {
      report.code = FAULT.SETTINGS_UNPARSED;
      report.message = 'файл настроек проекта не читается как текст — раскладка его не трогает';
      return report;
    }
    try {
      current = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      report.code = FAULT.SETTINGS_UNPARSED;
      report.message = 'файл настроек проекта не разбирается как JSON (комментарии, хвостовая'
        + ' запятая или обрезанный хвост) — раскладка его не трогает и не чинит';
      return report;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      report.code = FAULT.SETTINGS_UNPARSED;
      report.message = 'файл настроек проекта — не объект JSON: раскладка его не трогает';
      return report;
    }
  } else if (read.code === FAULT.PATH_UNREACHABLE) {
    current = {};
    report.createdFile = true;
  } else {
    report.code = read.code;
    report.message = 'файл настроек проекта недоступен — раскладка его не трогает';
    return report;
  }

  const next = { ...current };
  const prev = readOwns(current[OWNS_KEY] ? current[OWNS_KEY].owns : null);
  report.dropped = prev.dropped;

  // (б) Права: добавляем только недостающее; уже бывшее не становится нашим.
  const perms = next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions)
    ? { ...next.permissions } : {};
  const srcPerms = source && source.permissions && typeof source.permissions === 'object' ? source.permissions : {};
  for (const key of ['allow', 'deny']) {
    const have = Array.isArray(perms[key]) ? perms[key].slice() : [];
    const want = Array.isArray(srcPerms[key]) ? srcPerms[key] : [];
    const added = [];
    for (const raw of want) {
      const line = ruleLine(raw);
      if (!line) continue;
      if (have.includes(line)) continue;      // строка человека — не наша, во владение не идёт
      have.push(line);
      added.push(line);
    }
    if (have.length || Array.isArray(perms[key])) perms[key] = have;
    if (key === 'allow') report.addedAllow = added; else report.addedDeny = added;
  }
  if (Object.keys(perms).length) next.permissions = perms;

  // (в) Хуки: своя группа отдельным элементом; чужая группа не правится вовсе.
  const hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)
    ? { ...next.hooks } : {};
  const srcHooks = source && source.hooks && typeof source.hooks === 'object' && !Array.isArray(source.hooks)
    ? source.hooks : {};
  const ownHooks = {};
  for (const event of Object.keys(srcHooks)) {
    if (!EVENT_RE.test(event)) continue;
    const groups = Array.isArray(srcHooks[event]) ? srcHooks[event] : [];
    const list = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
    const mine = [];
    for (const raw of groups) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const group = orderGroup(raw);
      mine.push(group);
      if (list.some((existing) => same(existing, group))) {
        report.keptHooks.push(event);         // уже стоит — второй раз не добавляем
        continue;
      }
      list.push(group);
      report.addedHooks.push(event);
    }
    if (list.length) hooks[event] = list;
    if (mine.length) ownHooks[event] = mine;
  }
  if (Object.keys(hooks).length) next.hooks = hooks;

  // (г) и (д) Владение: объединение прежнего и добавленного; группы — дословно.
  const owns = {
    allow: [...prev.owns.allow],
    deny: [...prev.owns.deny],
    hooks: {},
  };
  for (const line of report.addedAllow) if (!owns.allow.includes(line)) owns.allow.push(line);
  for (const line of report.addedDeny) if (!owns.deny.includes(line)) owns.deny.push(line);
  for (const event of new Set([...Object.keys(prev.owns.hooks), ...Object.keys(ownHooks)])) {
    const list = [];
    for (const group of [...(prev.owns.hooks[event] || []), ...(ownHooks[event] || [])]) {
      if (!list.some((g) => same(g, group))) list.push(group);
    }
    if (list.length) owns.hooks[event] = list;
  }

  // `created_file` — прежняя правда сильнее сегодняшней: файл, который мы завели раньше,
  // остаётся нашим и при повторной раскладке.
  const prevCreated = current[OWNS_KEY] && current[OWNS_KEY].created_file === true;
  next[OWNS_KEY] = { created_file: prevCreated || report.createdFile, owns };
  report.owns = owns;

  if (dry) {
    report.ok = true;
    report.message = 'сухой прогон: файл настроек не тронут';
    return report;
  }

  const body = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
  const put = await writeWholeFile(ctx, settingsRel(), body);
  if (!put.ok) {
    report.code = put.code;
    report.message = 'файл настроек не записался';
    return report;
  }
  report.ok = true;
  report.wrote = true;
  report.message = report.createdFile
    ? 'файл настроек создан раскладкой'
    : `файл настроек дополнен: прав ${report.addedAllow.length + report.addedDeny.length},`
      + ` групп хуков ${report.addedHooks.length}`;
  return report;
}
