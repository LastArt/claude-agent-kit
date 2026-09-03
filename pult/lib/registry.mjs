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
 * ЗАПРЕЩЁННЫЙ КОРЕНЬ (фаза 3) — ПОМЕТКА ЗАПИСИ, А НЕ ФИЛЬТР РЕЕСТРА. Корень из реестра служит
 * границей ВСЕМ проверкам пути в демоне, поэтому «любой абсолютный путь» здесь и был дефектом:
 * корень, равный домашнему каталогу, отдаёт весь поддерев через дерево и файл, признаком
 * `reveal` — файлы под образцами секретов, а в режиме записи домашний каталог УДОВЛЕТВОРЯЕТ
 * условию «в корне есть папка набора» на любой машине с Claude Code. Следствие для чтения
 * называется прямо: `reveal` над произвольным корнем — это чтение секретов МАШИНЫ, а не одного
 * проекта человека.
 *
 * Форма выбрана ЗАКРЫТЫМ СПИСКОМ ОТКАЗОВ (`ROOT_DENY` в `pult/config.mjs`), и довод записан
 * здесь, а не в задаче. Белая альтернатива («корень обязан нести признак проекта») отвергнута
 * не из удобства: раздел 1.4 контракта ТРЕБУЕТ состояния «кит в проекте не установлен», такие
 * проекты законно живут в реестре, а §4.2 требует раскладки туда, где набора нет, — белое
 * условие закрыло бы и то и другое. Почему чёрный список допустим здесь, а в `.claude/ship.list`
 * нет: там забытая строка означает уехавший в чужой проект файл, то есть утечку, которой никто
 * не заметит; здесь забытая строка не открывает ничего нового — остаётся сегодняшнее поведение.
 * Чем это является, названо вслух: ЛЕЖАЧИЙ ПОЛИЦЕЙСКИЙ, А НЕ ГРАНИЦА, — тем же словом, каким
 * описаны правила `deny` на git в `.claude/CLAUDE.md`. Список ловит правдоподобную ошибку
 * человека в диалоге выбора папки, а не нападающего: у локального нападающего и так есть сессия
 * с оболочкой машины через `/ws/pty`.
 *
 * ГРАНИЦА УТВЕРЖДЕНИЯ `rootRejection()` — что она меряет и чего это НЕ доказывает. Сверка
 * СТРОКОВАЯ И СИНХРОННАЯ, поэтому она ловит путь в той форме, в какой он лежит в реестре,
 * и НЕ ЛОВИТ тот же каталог, записанный коротким именем Windows (`MANUKY~1`) или доставшийся
 * через точку соединения: Windows отдаёт короткие имена вперемешку с длинными, и распознать
 * их строкой нельзя. Третье в том же списке (замечание ревью 02.09.2026): РЕГИСТРОНЕЗАВИСИМЫЕ
 * ТОМА ВНЕ WINDOWS. `normalizeRoot()` приводит регистр только на Windows, а том macOS
 * по умолчанию регистр не различает — там `/users/x` пройдёт мимо строки `/Users/x`. Приводить
 * регистр на всех платформах нельзя: на POSIX `/Data` и `/data` бывают разными каталогами,
 * и общее приведение запрещало бы человеку чужой законный путь. Практического веса у этой
 * дырки почти нет (системный диалог отдаёт каноническую форму, а сам список объявлен лежачим
 * полицейским), но раз граница названа списком, список закрыт целиком.
 * Синхронность выбрана сознательно — `realpath` внутри сделал бы функцию
 * асинхронной и потянул за собой `pathAcceptable()`, `parseEntry()` и всех вызывающих. Путь
 * через инструмент этим НЕ ЗАДЕТ: `pult/tools/registry-add.mjs` зовёт `resolve` и `realPath`
 * до записи, то есть в реестр попадает уже канонизированная длинная форма; ограничение
 * касается записей, вписанных в файл руками мимо инструмента. Это НАЗВАННАЯ ГРАНИЦА,
 * а не долг (решение человека 02.09.2026).
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
  ROOT_DENY, ROOT_KIND, ROOT_MATCH, ROOT_MATCH_STRENGTH,
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
 * Нормализация пути — ОДНА НА ВЕСЬ МОДУЛЬ: `resolve`, единый разделитель, а на Windows ещё
 * и нижний регистр (там `C:\Work` и `c:\work` суть один каталог).
 *
 * Функция общая для `projectId()` и `rootRejection()` НАМЕРЕННО: две нормализации разойдутся,
 * и один и тот же корень будет отвергаться или приниматься в зависимости от того, кто спросил.
 */
function normalizeRoot(p) {
  const norm = path.resolve(p).split('\\').join('/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/**
 * Идентификатор проекта — первые восемь шестнадцатеричных знаков sha256 от нормализованного
 * пути. Без нормализации один проект попал бы в реестр дважды.
 */
export function projectId(p) {
  return createHash('sha256').update(normalizeRoot(p), 'utf8').digest('hex').slice(0, 8);
}

/** Совпадение пути с одной строкой списка: точно либо вместе с содержимым. */
function matches(norm, base, match) {
  if (!base) return false;
  if (norm === base) return true;
  if (match !== ROOT_MATCH.TREE) return false;
  return norm.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * Единственная реализация запрета корня: вид запрета либо пустота.
 *
 * Порядок строк ответа на вопрос «почему отвергнут» значения не имеет — важен сам факт, —
 * но вычисляемые корни стоят первыми, потому что перечислить их списком нельзя.
 */
function rootDenyMatch(abs) {
  if (typeof abs !== 'string' || !abs) return null;
  let norm;
  let root;
  try {
    norm = normalizeRoot(abs);
    root = path.parse(path.resolve(abs)).root;
  } catch {
    return null;                                  // негодную форму отобьёт `pathAcceptable()`
  }

  // 1. Корень диска и корень файловой системы — ВЫЧИСЛЯЮТСЯ, сверяются точно.
  if (root && normalizeRoot(root) === norm) return ROOT_KIND.DRIVE_ROOT;

  // 2. Каталог реестра самого пульта — вместе с содержимым. Дописывается ЗДЕСЬ, а не в списке
  //    констант: он вычисляется `registryDir()`, и обратный импорт замкнул бы модули в кольцо.
  try {
    if (matches(norm, normalizeRoot(registryDir()), ROOT_MATCH.TREE)) return ROOT_KIND.REGISTRY;
  } catch { /* домашнего каталога нет — запрещать нечего */ }

  // 3. Закрытый список из констант, у каждой строки СВОЙ вид сверки.
  //
  // ПРОХОДИМ ВЕСЬ СПИСОК И БЕРЁМ САМОЕ СТРОГОЕ СОВПАДЕНИЕ — И ЭТО ПРО ПРИЧИНУ, А НЕ ПРО
  // ГРАНИЦУ. Границу здесь не удержать в принципе: выбор идёт СРЕДИ УЖЕ СОВПАВШИХ строк,
  // а любое совпадение и так даёт отказ, — значит от этого выбора зависит только `kind`,
  // то есть человеческая формулировка причины в сообщении `pult/tools/registry-add.mjs`.
  // Проверено ревью 02.09.2026 разборкой: возврат к «первому совпадению» изменил один ответ
  // из 95, и только полем `kind`; ни один код отказа не изменился.
  //
  // Зачем тогда строгий выбор: причина перестаёт зависеть от ПОРЯДКА строк в чужом файле
  // констант, а порядок следующая правка переставит не задумываясь — и человек получил бы
  // «это домашний каталог» там, где на самом деле сработал системный.
  //
  // СИЛА ЗАПРЕТА ДЕРЖИТСЯ НЕ ЗДЕСЬ, А В `mergeRows()` (`pult/config.mjs`): этот цикл идёт
  // по УЖЕ СЛИТОМУ списку, и выброшенной слиянием строки для него не существует. Там же
  // стоит машинная сверка на загрузке, роняющая старт, если слияние ослабило список.
  let best = null;
  for (const row of ROOT_DENY) {
    if (!matches(norm, normalizeRoot(row.path), row.match)) continue;
    if (!best || ROOT_MATCH_STRENGTH[row.match] > ROOT_MATCH_STRENGTH[best.match]) best = row;
  }
  return best ? best.kind : null;
}

/**
 * Отвергнут ли путь как КОРЕНЬ ПРОЕКТА: код отказа либо пустота.
 *
 * ЕДИНАЯ ДВЕРЬ С ДВУМЯ РАЗНЫМИ ПОТРЕБИТЕЛЯМИ: `parseEntry()` этим кодом ПОМЕЧАЕТ запись
 * и оставляет её в списке, `addProject()` — ОТКАЗЫВАЕТ. Одна реализация, два поведения.
 *
 * ЗВАТЬ ЕЁ ИЗ `pathAcceptable()` ЗАПРЕЩЕНО, и это не вкусовщина: `parseEntry()` при ложном
 * ответе `pathAcceptable()` запись ВЫБРАСЫВАЕТ, а `writeRegistry()` переписывает файл целиком
 * из отфильтрованного списка — значит отвергнутая запись исчезла бы из файла человека при
 * первом же переходе по другому проекту, вопреки обещанию в шапке этого самого модуля
 * («пропавший путь помечается недоступным, но НИКОГДА не удаляется автоматически»).
 * Со второго раза это происходило бы уже молча.
 *
 * Граница утверждения (строковая синхронная сверка, короткие имена Windows и точки соединения)
 * названа в шапке модуля.
 */
export function rootRejection(abs) {
  return rootDenyMatch(abs) ? FAULT.ROOT_REJECTED : null;
}

/**
 * Вид запрета из закрытого словаря `ROOT_KIND` либо пустота.
 *
 * Нужна ровно одному потребителю — `pult/tools/registry-add.mjs`, который показывает человеку
 * ЧИТАЕМЫЙ отказ («это корень диска», «это домашний каталог»). Реализация та же самая, поэтому
 * разойтись с `rootRejection()` она не может.
 */
export function rootRejectionKind(abs) {
  return rootDenyMatch(abs);
}

/**
 * Годен ли путь для реестра: не UNC, не пуст, в пределах потолка, абсолютный.
 *
 * ЗАПРЕТА КОРНЯ ЗДЕСЬ НЕТ НАМЕРЕННО — причина записана у `rootRejection()`: ложный ответ этой
 * функции стоит записи в файле человека.
 */
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
 *
 * ПОЛЕ `rejected` — ПРОИЗВОДНОЕ, А НЕ ХРАНИМОЕ: оно считается заново при каждом чтении и
 * в файл не пишется (`writeRegistry()` пишет те же четыре поля, что и раньше). Второго
 * источника правды о корне не заводим — иначе устаревшая пометка на диске начала бы спорить
 * со списком запрещённых корней.
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

  // ПОМЕТКА, А НЕ ВЫБРАСЫВАНИЕ: запись остаётся в списке и переживает перезапись файла,
  // а отказываются работать с ней потребители — читатель проекта, мост сессии, маршруты пути
  // и лёгкий маршрут ожиданий. Каждый из них берёт готовое поле, а не считает корень заново:
  // два места, считающие одно и то же по-разному, сходятся по слабому.
  const rejected = rootRejection(abs);

  return { ok: true, entry: { id, name, path: abs, seen, rejected }, faults };
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

/**
 * Запись реестра целиком: атомарно, с режимом `0600` и явным каталогом `0700`.
 *
 * ПИШУТСЯ ЧЕТЫРЕ ПОЛЯ И НИ ОДНИМ БОЛЬШЕ. Пометка отвергнутого корня в файл не идёт: она
 * производная (см. `parseEntry()`), и запись с таким корнем обязана остаться в файле человека
 * ровно такой, какой он её завёл.
 *
 * Вызывающих у этой функции РОВНО ДВА — `addProject()` и `touchProject()`; появится третий,
 * правило то же: список берётся из свежего чтения, а не из прочитанного раньше.
 */
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
 *
 * ЗАПРЕЩЁННЫЙ КОРЕНЬ ЗДЕСЬ ОТКАЗЫВАЕТ, а не помечает: заведение такого корня — живое действие
 * человека, и остановить его надо на входе. Второй потребитель той же двери — `parseEntry()`,
 * и он ведёт себя иначе по причине, записанной у `rootRejection()`.
 */
export async function addProject(absPath, name) {
  if (!pathAcceptable(absPath)) {
    return { ok: false, code: FAULT.REGISTRY_ENTRY_INVALID };
  }
  const abs = path.resolve(absPath);
  const rejected = rootRejection(abs);
  if (rejected) return { ok: false, code: rejected, kind: rootRejectionKind(abs) };
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
    // Форма записи одна на оба пути её появления. Здесь пометка заведомо пуста: корень уже
    // проверен выше, и с отказом сюда не доходят.
    rejected: null,
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
 *
 * ТРЕБОВАНИЕ, КОТОРОЕ НАДО НЕ ВВЕСТИ, А НЕ ПОТЕРЯТЬ: ЧТЕНИЕ РЕЕСТРА ОТСЮДА НЕ ПЕРЕНОСИТСЯ ВЫШЕ
 * ПО ПОТОКУ и список, прочитанный раньше, не переиспользуется. Сегодня это уже так — синхронный
 * обход отпечатка лежит в `collect()` (`pult/server.mjs`) и отрабатывает ДО этой функции,
 * а она перечитывает реестр непосредственно перед записью, — и окно «чтение-правка-запись»
 * измеряется миллисекундами. Возьмите список у вызывающего, и окно раздуется до секунд обхода.
 * Машинного сторожа у этого правила нет и быть не может, поэтому оно стоит здесь, рядом с кодом.
 *
 * ОСТАТОЧНЫЙ РИСК НАЗВАН ПРЯМО: межпроцессной атомарности нет. Писателей у файла реестра ДВОЕ —
 * эта функция и `addProject()`, вызванная инструментом из другого процесса, — и запись,
 * добавленная ровно в это окно, будет затёрта. Лечится файлом-замком на каталоге настроек;
 * в фазу 3 замок не берётся: он вводит своё состояние на диске (снятие зависшего, возраст,
 * поведение при падении процесса), а цена промаха — «нажать „Добавить проект“ второй раз».
 *
 * ОТМЕТКА СТАВИТСЯ И ОТВЕРГНУТОЙ ЗАПИСИ, и это намеренно: обращения к диску проекта здесь нет
 * вовсе, а особый случай ради «правильности» вида завёл бы вторую ветвь на пустом месте.
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
