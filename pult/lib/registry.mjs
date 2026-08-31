#!/usr/bin/env node
/**
 * Реестр путей к проектам — единственное, что пульт хранит у себя.
 *
 *   %APPDATA%\cckit\registry.json      Windows
 *   ~/.config/cckit/registry.json      POSIX (с уважением к XDG_CONFIG_HOME)
 *
 * Хранится ТОЛЬКО путь, имя и время последнего просмотра — ничего о содержимом проекта
 * (раздел 1.2 контракта). Версия, отпечаток, задачи и статусы вычитываются с диска на каждый
 * запрос: кэш здесь был бы вторым источником правды, то есть ровно той болезнью, от которой
 * в ките завели отпечаток.
 *
 * Права. Реестр — это список абсолютных путей с именем пользователя, поэтому режим доступа
 * ставится ЯВНО: каталог `0700`, файл `0600`. На Windows смена режима пропускается мягко —
 * так же поступает `writeSecure()` в `.claude/hooks/verify.mjs`.
 *
 * Файл реестра — НЕДОВЕРЕННЫЙ вход наравне с чужим проектом: его правят редактором, он
 * переживает порчу диска и приезжает с чужой машины при переносе профиля. Поэтому успешный
 * разбор JSON годности не означает: каждая запись проверяется по форме, негодная
 * отбрасывается с кодом, годные остаются. Разобранный объект в ответ не разворачивается —
 * поля переносятся поимённо.
 *
 * Пропавший путь помечается недоступным, но НИКОГДА не удаляется автоматически: удаление —
 * решение человека, а исчезнувший каталог бывает отключённым диском.
 *
 * Все файловые вызовы идут через примитивы `pult/lib/fs-safe.mjs`: прямых обращений
 * к `node:fs` в этом файле нет.
 */

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';

import {
  readTextCapped, writeSecureAtomic, mkdirSecure, capText, timeField, isUncPath, sanePath,
  faultFromError,
} from './fs-safe.mjs';
import {
  FAULT, MAX_REGISTRY_ENTRIES, MAX_PATH, MAX_TEXT_FILE, PROJECT_ID_RE,
} from '../config.mjs';

const SCHEMA = 1;

/**
 * Каталог реестра. Домашний каталог берётся у рантайма и нигде не хардкодится:
 * на Windows сначала `APPDATA`, при пустой переменной — через домашний каталог.
 */
export function registryDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.trim()) return path.join(appData, 'cckit');
    return path.join(os.homedir(), 'AppData', 'Roaming', 'cckit');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, 'cckit');
  return path.join(os.homedir(), '.config', 'cckit');
}

export function registryFile() {
  return path.join(registryDir(), 'registry.json');
}

/**
 * Идентификатор проекта — первые восемь шестнадцатеричных знаков sha256 от нормализованного
 * пути. Нормализация: `resolve`, единый разделитель, а на Windows ещё и нижний регистр —
 * там `C:\Work` и `c:\work` суть один каталог, и без этого один проект попал бы в реестр дважды.
 */
export function projectId(p) {
  let norm = path.resolve(p).split('\\').join('/');
  if (process.platform === 'win32') norm = norm.toLowerCase();
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 8);
}

/** Годен ли путь для реестра: не UNC, не пуст, в пределах потолка, абсолютный. */
export function pathAcceptable(p) {
  if (typeof p !== 'string') return false;
  if (!sanePath(p)) return false;
  if (p.length > MAX_PATH) return false;
  if (isUncPath(p)) return false;
  return path.isAbsolute(p);
}

/**
 * Одна запись из файла — в запись реестра либо в отказ.
 *
 * Проверяется всё: `path` обязан быть строкой (не объектом и не массивом), абсолютным после
 * `resolve`, без нулевого байта и управляющих символов, в пределах потолка длины; `id` — ровно
 * восемь шестнадцатеричных знаков; `name` — через очистку свободного текста; время последнего
 * просмотра — через единственную дверь к временам в виде `utc-iso`, и не совпало — `null`
 * с кодом, а не сырая строка.
 */
function parseEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: FAULT.REGISTRY_ENTRY_INVALID };
  }
  const p = raw.path;
  if (!pathAcceptable(p)) return { ok: false, code: FAULT.REGISTRY_ENTRY_INVALID };
  const abs = path.resolve(p);

  const id = typeof raw.id === 'string' && PROJECT_ID_RE.test(raw.id) ? raw.id : projectId(abs);

  const nameSrc = typeof raw.name === 'string' ? raw.name : path.basename(abs);
  const name = capText(nameSrc).text || path.basename(abs);

  const faults = [];
  let seen = null;
  if (typeof raw.seen === 'string' && raw.seen.length > 0) {
    seen = timeField(raw.seen, 'utc-iso');
    if (!seen) faults.push({ field: 'seen', code: FAULT.TIME_UNRECOGNISED });
  }

  return { ok: true, entry: { id, name, path: abs, seen }, faults };
}

/**
 * Прочитать реестр. Файла нет — пустой список, и это НЕ ошибка: пульт без проектов законен.
 * Битый JSON — пустой список и признак порчи в ответе, а не исключение: так же читает своё
 * состояние `readState()` в `.claude/hooks/gate.mjs`.
 */
export async function readRegistry() {
  const file = registryFile();
  const res = await readTextCapped(file, MAX_TEXT_FILE);
  if (!res.ok) {
    if (res.code === FAULT.PATH_UNREACHABLE) {
      return { entries: [], faults: [], corrupt: false, file };
    }
    return { entries: [], faults: [{ field: 'registry', code: res.code }], corrupt: true, file };
  }

  let data = null;
  try {
    data = JSON.parse(res.text);
  } catch {
    return {
      entries: [], corrupt: true, file,
      faults: [{ field: 'registry', code: FAULT.REGISTRY_ENTRY_INVALID }],
    };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
    return {
      entries: [], corrupt: true, file,
      faults: [{ field: 'registry', code: FAULT.REGISTRY_ENTRY_INVALID }],
    };
  }

  const entries = [];
  const faults = [];
  const seenIds = new Set();
  for (const raw of data.projects) {
    if (entries.length >= MAX_REGISTRY_ENTRIES) {
      faults.push({ field: 'registry', code: FAULT.BUDGET_EXHAUSTED });
      break;
    }
    const parsed = parseEntry(raw);
    if (!parsed.ok) {
      faults.push({ field: 'registry', code: parsed.code });
      continue;
    }
    if (seenIds.has(parsed.entry.id)) continue;
    seenIds.add(parsed.entry.id);
    entries.push(parsed.entry);
    for (const f of parsed.faults) faults.push({ field: `registry.${f.field}`, code: f.code });
  }
  return { entries, faults, corrupt: false, file };
}

/** Запись реестра целиком: атомарно, с режимом `0600` и явным каталогом `0700`. */
export async function writeRegistry(entries) {
  const file = registryFile();
  await mkdirSecure(path.dirname(file));
  const body = {
    version: SCHEMA,
    projects: entries.slice(0, MAX_REGISTRY_ENTRIES).map((e) => ({
      id: e.id,
      name: e.name,
      path: e.path,
      seen: e.seen && e.seen.value ? e.seen.value : null,
    })),
  };
  await writeSecureAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

/**
 * Добавить проект. Повторный вызов с тем же путём дубля не создаёт — идентификатор считается
 * от нормализованного пути, и он же служит ключом.
 */
export async function addProject(absPath, name) {
  if (!pathAcceptable(absPath)) {
    return { ok: false, code: FAULT.REGISTRY_ENTRY_INVALID };
  }
  const abs = path.resolve(absPath);
  const { entries, faults } = await readRegistry();
  const id = projectId(abs);
  const already = entries.find((e) => e.id === id);
  if (already) return { ok: true, added: false, entry: already, entries, faults };

  if (entries.length >= MAX_REGISTRY_ENTRIES) {
    return { ok: false, code: FAULT.BUDGET_EXHAUSTED };
  }
  const entry = {
    id,
    name: capText(name || path.basename(abs)).text || path.basename(abs),
    path: abs,
    seen: null,
  };
  entries.push(entry);
  try {
    await writeRegistry(entries);
  } catch (e) {
    return { ok: false, code: faultFromError(e) };
  }
  return { ok: true, added: true, entry, entries, faults };
}

/**
 * Отметить просмотр проекта. Время пишется в виде `utc-iso` и проверяется той же дверью,
 * что и чтение: собственное время демона машинное по построению, но проверка стоит дёшево,
 * а «пометка вида поставлена только там, где значение проверено» — обещание контракта.
 *
 * Это единственная запись пульта на диск во время обслуживания запроса, и она идёт в реестр
 * пульта, а не в кит: запрет фазы 1 — про `.claude/` читаемого проекта.
 */
export async function touchProject(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) return { ok: false, code: FAULT.REGISTRY_ENTRY_INVALID };
  const { entries } = await readRegistry();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, code: FAULT.PATH_UNREACHABLE };
  const now = timeField(new Date().toISOString(), 'utc-iso');
  entry.seen = now;
  try {
    await writeRegistry(entries);
  } catch (e) {
    return { ok: false, code: faultFromError(e) };
  }
  return { ok: true, entry };
}
