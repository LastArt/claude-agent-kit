#!/usr/bin/env node
/**
 * МАСТЕР УСТАНОВКИ СО СТОРОНЫ ОБОЛОЧКИ: осмотр, слот выбранного пути, раскладка и снос.
 *
 * Модуль по образцу `pult/shell/add-project.mjs`: сам он ничего не раскладывает и не удаляет —
 * он запускает готовые инструменты (`pult/tools/kit-deploy.mjs`, `pult/tools/kit-remove.mjs`)
 * подпроцессом системного Node и возвращает их отчёт. Вся санитария путей, шлюз записи,
 * резервная копия, маркерный отказ и проверка корня живут в инструментах; второй копии
 * этих правил здесь нет намеренно — разошлись бы.
 *
 * ПУТЬ НЕ ПРИХОДИТ СО СТРАНИЦЫ, И ЭТО ГЛАВНОЕ СВОЙСТВО МОДУЛЯ. Источников два, оба вне
 * страницы: системный диалог главного процесса и реестр по идентификатору. Диалог открывает
 * главный процесс (там окно), а сюда он приходит функцией выбора — так поток «выбрал →
 * осмотрел → развернул» остаётся в одном месте, а окно не переезжает из главного процесса.
 *
 * ВЫБРАННЫЙ ПУТЬ ВОЗВРАЩАЕТСЯ НА ЭКРАН, И ЭТО ПРОВЕРЕНО АУДИТОМ ФАЗЫ 4, А НЕ РЕШЕНО ЗДЕСЬ.
 * §4.2 требует показать человеку, куда ставим и где будет резервная копия; находку круга 1
 * аудита фазы 3 это не возвращает, потому что она была про НАПРАВЛЕНИЕ: страница не может
 * НАЗНАЧИТЬ корень. Маршрут проектов и так отдаёт путь каждого проекта.
 *
 * СЛОТ ВЫБРАННОГО ПУТИ — В ПАМЯТИ ГЛАВНОГО ПРОЦЕССА, СО СРОКОМ ЖИЗНИ И СБРОСОМ ПО СОБЫТИЯМ,
 * КОТОРЫЕ ПЕРЕЧИСЛЕНЫ ПОИМЁННО. Собственные системные окна из этого списка ИСКЛЮЧЕНЫ: диалог
 * выбора каталога и окно подтверждения забирают фокус сами, и сброс «по любой потере фокуса»
 * отказывал бы сразу после выбора папки — а первым же «лечением» сняли бы сам сброс.
 * Событий два, и оба означают «человек ушёл от мастера»: окно скрыто (свёрнуто в значок)
 * и страница перезагружена.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ ПОЯВИТСЯ: ключа подмены источника (`--from`). Оболочка его не передаёт
 * никогда, но защитой служит не это, а сам запрет ключа вне временного каталога системы
 * (`pult/tools/kit-deploy.mjs`): утверждение про оболочку — это утверждение про оболочку,
 * а не про того, кто может позвать оболочку машины.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { capText, isPlainFile, sanePath } from '../lib/fs-safe.mjs';
import { readRegistry } from '../lib/registry.mjs';
import { DEPLOY_SLOT_MS, MAX_TEXT, PROJECT_ID_RE } from '../config.mjs';
import { PRESET_KEYS, presetKey } from '../lib/profiles.mjs';
import { DAEMON_DIR, childEnv, findNode, percentUnsafe, runCapped } from './daemon.mjs';

// --- константы: живут рядом с потребителем -----------------------------------

/** Осмотр только читает — минуты ему не нужно. */
const INSPECT_TIMEOUT_MS = 60000;

/** Раскладка копирует весь состав и запускает два хука набора. */
const DEPLOY_TIMEOUT_MS = 180000;

/** Снос идёт по списку положенного: те же порядки, что у раскладки. */
const REMOVE_TIMEOUT_MS = 120000;

/** Потолок на КАЖДЫЙ поток инструмента по отдельности. */
const TOOL_MAX_BYTES = 256 * 1024;

/** Длина строки журнала — та же дисциплина, что у остальных запусков оболочки. */
const LOG_LINE_MAX = 500;

/** Потолок числа путей в списках, уезжающих на страницу. */
const MAX_LIST = 200;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DEPLOY = path.join(HERE, '..', 'tools', 'kit-deploy.mjs');
const TOOL_REMOVE = path.join(HERE, '..', 'tools', 'kit-remove.mjs');

const say = (s) => process.stdout.write(`[shell] ${s}\n`);
const fail = (code, message) => ({ ok: false, code, message });

/** Вывод инструмента — в журнал оболочки построчно и с потолком длины строки. */
function logStream(text, tag) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    say(`${tag}: ${line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}…` : line}`);
  }
}

/** Строка, пригодная к показу человеку: та же очистка, что у демона, и здесь она повторяется. */
const clean = (value) => (typeof value === 'string' ? capText(value, MAX_TEXT).text : null);

/** Список путей: очистка каждого элемента и потолок числа. */
function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_LIST) break;
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? item.path : item;
    const text = clean(raw);
    if (text) out.push(text);
  }
  return out;
}

// --- слот выбранного пути ----------------------------------------------------

/**
 * Слот живёт в памяти процесса и держит РОВНО один путь. Второго поля здесь нет и не нужно:
 * всё остальное мастер спрашивает у инструмента заново.
 */
const slot = { path: null, at: 0 };

/** Явный сброс. Причина уезжает в журнал: молчаливо протухший слот выглядит поломкой. */
export function dropSlot(why) {
  if (!slot.path) return;
  slot.path = null;
  slot.at = 0;
  say(`слот выбранного каталога сброшен: ${why}`);
}

/** Что в слоте: разрешённый путь либо код отказа. Истёкший слот сбрасывается сам. */
export function slotPath() {
  if (!slot.path) return fail('slot_empty', 'каталог не выбран — начните с осмотра');
  if (Date.now() - slot.at > DEPLOY_SLOT_MS) {
    dropSlot('истёк срок жизни');
    return fail('slot_expired', 'выбор устарел — выберите папку заново');
  }
  return { ok: true, path: slot.path };
}

/** Показать человеку, что в слоте (без пути наружу это делать нечем — путь показывается). */
export function slotView() {
  const state = slotPath();
  return state.ok ? { chosen: state.path, fresh: true } : { chosen: null, fresh: false };
}

// --- запуск инструментов ------------------------------------------------------

/**
 * Общий запуск инструмента пульта: форма целиком, знак процента по ВСЕМ аргументам,
 * таймаут, потолки, разделение потоков. Ровно та же дисциплина, что у инструмента реестра
 * в фазе 3, и второй её редакции здесь нет.
 */
async function runTool(tool, args, timeoutMs) {
  if (!(await isPlainFile(tool))) {
    return fail('tool_missing', 'инструмент пульта не найден рядом с оболочкой');
  }
  const node = await findNode();
  if (!node.ok) return node;

  const full = [tool, ...args];
  if (percentUnsafe(node.form, full)) {
    return fail('percent_in_path', [
      'В пути есть знак процента, а найденный Node запускается через командный файл.',
      '',
      'Интерпретатор команд подставляет значение переменной окружения по процентам даже',
      'внутри кавычек — инструмент получил бы другой путь. Отказываюсь молча портить путь.',
    ].join('\n'));
  }

  const run = await runCapped(node.form, full, {
    cwd: DAEMON_DIR,
    env: childEnv(),
    timeoutMs,
    maxBytes: TOOL_MAX_BYTES,
  });
  if (!run.ok) return run;
  logStream(run.stderr, path.basename(tool));
  if (run.killed) {
    return fail('tool_timeout', 'инструмент не уложился в отведённое время и снят');
  }
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  return { ok: true, code: run.code, report, stderr: run.stderr, stdout: run.stdout };
}

/**
 * Разобранный отчёт осмотра — ТОЛЬКО поимённо перенесённые поля, а не разворот чужого объекта.
 * Отчёт наш собственный, но правило то же, что у демона: в ответ уезжает то, что перенесли.
 */
function shapeInspect(report) {
  return {
    root: clean(report.root),
    marker: clean(report.marker),
    master: clean(report.master),
    masterVersion: clean(report.masterVersion),
    kitPresent: report.kitPresent === true,
    settingsPresent: report.settingsPresent === true,
    claudeMdPresent: report.claudeMdPresent === true,
    willPlace: cleanList(report.willPlace),
    willSkip: cleanList(report.willSkip),
    willSkipCore: cleanList(report.willSkipCore),
    hooksPresent: cleanList(report.hooksPresent),
    claudeMd: cleanList(report.claudeMd),
    notes: cleanList(report.notes),
    presets: PRESET_KEYS.slice(),
  };
}

/**
 * ОСМОТР: выбрать каталог системным диалогом и показать, что в нём нашлось.
 *
 * @param {Function} pick асинхронная функция главного процесса, открывающая диалог
 *                        и возвращающая абсолютный путь либо `null`. Другого источника
 *                        пути у мастера нет.
 */
export async function inspectChosen(pick) {
  const chosen = await pick();
  if (!chosen) return { cancelled: true };
  if (!sanePath(chosen) || !path.isAbsolute(chosen)) {
    return fail('bad_path', 'выбранный путь не годится: ожидается абсолютный путь к каталогу');
  }

  const res = await runTool(TOOL_DEPLOY, ['--report', '--into', chosen, '--json'], INSPECT_TIMEOUT_MS);
  if (!res.ok) return res;
  if (!res.report) {
    return fail('bad_report', 'инструмент не вернул разбираемый отчёт осмотра');
  }
  if (res.report.ok !== true) {
    // ОТКАЗ ПОКАЗЫВАЕТСЯ ДОСЛОВНО: инструмент объясняет его лучше, чем мог бы пересказ.
    const text = capText(res.stderr, MAX_TEXT).text.trim();
    return fail(clean(res.report.code) || 'inspect_refused', text || 'инструмент отказал в осмотре');
  }

  // Слот заводится ТОЛЬКО после удавшегося осмотра: раскладывать в каталог, который мы
  // не сумели даже прочитать, незачем.
  slot.path = chosen;
  slot.at = Date.now();
  say(`каталог выбран и осмотрен, слот жив ${Math.round(DEPLOY_SLOT_MS / 1000)} с`);
  return { ok: true, inspect: shapeInspect(res.report) };
}

/**
 * РАСКЛАДКА: профиль — ключ из закрытого словаря, путь — из слота.
 *
 * Полезной нагрузки с путём у этой функции нет по построению: второй параметр не объявлен.
 */
export async function deployFromSlot(preset) {
  const key = presetKey(preset);
  if (!key) return fail('bad_preset', 'профиль бывает только из закрытого словаря');
  const state = slotPath();
  if (!state.ok) return state;

  const res = await runTool(
    TOOL_DEPLOY, ['--into', state.path, '--profile', key, '--json'], DEPLOY_TIMEOUT_MS,
  );
  // Слот сбрасывается ПОСЛЕ использования в любом исходе: повторное нажатие обязано
  // начинаться с осмотра, а не разворачивать второй раз молча.
  dropSlot('раскладка выполнена');
  if (!res.ok) return res;
  if (!res.report) return fail('bad_report', 'инструмент не вернул разбираемый отчёт раскладки');

  const report = res.report;
  const shaped = {
    ok: report.ok === true,
    code: clean(report.code),
    preset: clean(report.preset),
    presetTitle: clean(report.presetTitle),
    root: clean(report.root),
    backup: report.backup && typeof report.backup === 'object'
      ? { dir: clean(report.backup.dir), message: clean(report.backup.message) } : null,
    placed: Array.isArray(report.placed) ? report.placed.length : 0,
    skipped: Array.isArray(report.skipped) ? report.skipped.length : 0,
    skippedCore: Array.isArray(report.skippedCore) ? report.skippedCore.length : 0,
    hooks: cleanList((report.hooks || []).map((h) => (h && h.ran ? `${h.path}: запущен` : `${h.path}: ${h.why || 'не запускался'}`))),
    notes: cleanList(report.notes),
    registry: report.registry && typeof report.registry === 'object'
      ? { ok: report.registry.ok === true, id: clean(report.registry.id) } : null,
    stderr: capText(res.stderr, MAX_TEXT).text,
  };
  return { ok: true, deploy: shaped };
}

/** Корень проекта по идентификатору — ТОЛЬКО из реестра. */
async function rootById(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) {
    return fail('bad_project', 'идентификатор проекта не той формы');
  }
  const reg = await readRegistry();
  const entry = reg.entries.find((e) => e.id === id);
  if (!entry) return fail('unknown_project', 'такого проекта нет в реестре пульта');
  if (entry.rejected) return fail('root_rejected', 'корень этого проекта отвергнут');
  return { ok: true, root: entry.path, name: entry.name };
}

/**
 * СУХОЙ ПРОГОН СНОСА — для окна подтверждения: сколько файлов уйдёт.
 *
 * Число берётся у самого инструмента, а не считается здесь: два счётчика разошлись бы,
 * и человек подтверждал бы одно, а получал другое.
 */
export async function removeDryRun(projectId) {
  const found = await rootById(projectId);
  if (!found.ok) return found;
  const res = await runTool(TOOL_REMOVE, ['--from', found.root, '--dry', '--json'], REMOVE_TIMEOUT_MS);
  if (!res.ok) return res;
  if (!res.report) return fail('bad_report', 'инструмент не вернул разбираемый отчёт сухого прогона');
  return {
    ok: res.report.ok === true,
    code: clean(res.report.code),
    name: clean(found.name),
    removed: Array.isArray(res.report.removed) ? res.report.removed.length : 0,
    kept: Array.isArray(res.report.keptSkipped) ? res.report.keptSkipped.length : 0,
    stderr: capText(res.stderr, MAX_TEXT).text,
  };
}

/** СНОС: единственный параметр — идентификатор проекта; путь берётся из реестра. */
export async function removeByProject(projectId) {
  const found = await rootById(projectId);
  if (!found.ok) return found;
  const res = await runTool(TOOL_REMOVE, ['--from', found.root, '--json'], REMOVE_TIMEOUT_MS);
  if (!res.ok) return res;
  if (!res.report) return fail('bad_report', 'инструмент не вернул разбираемый отчёт сноса');
  const report = res.report;
  return {
    ok: true,
    remove: {
      ok: report.ok === true,
      code: clean(report.code),
      removed: Array.isArray(report.removed) ? report.removed.length : 0,
      refused: cleanList((report.refused || []).map((r) => (r && r.path ? `${r.path}: ${r.code}` : null))),
      kept: Array.isArray(report.keptSkipped) ? report.keptSkipped.length : 0,
      settings: report.settings && typeof report.settings === 'object'
        ? clean(report.settings.why || `правил снято ${report.settings.rules}, групп хуков ${report.settings.groups}`)
        : null,
      notes: cleanList(report.notes),
      stderr: capText(res.stderr, MAX_TEXT).text,
    },
  };
}
