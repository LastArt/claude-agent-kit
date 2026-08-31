#!/usr/bin/env node
/**
 * Копия алгоритма отпечатка набора — с ограждениями и подробным результатом.
 *
 * ПОЧЕМУ КОПИЯ, А НЕ ИМПОРТ. Демон никогда не импортирует и не запускает код читаемого
 * проекта. Две причины, обе жёсткие: кэш модулей ESM противоречит требованию «ничего
 * не кэшировать между запросами» из раздела 1.3 контракта (один раз загруженный чужой
 * `kit-fingerprint.mjs` остался бы в памяти навсегда), а исполнение кода из чужого каталога —
 * прямая дыра: в реестр добавляют клон чужого репозитория.
 *
 * ПОЧЕМУ КОПИЯ ОБЯЗАНА СОВПАДАТЬ. Число, которое печатает `banner.mjs` набора, и число
 * в ответе демона сравнивает человек. Разойдётся алгоритм — сравнивать станет нечего, и это
 * произойдёт молча. Стережёт совпадение `pult/tools/fingerprint-parity.mjs`.
 *
 * ЧЕГО СТОРОЖ НЕ ДЕЛАЕТ. Он стережёт АЛГОРИТМ, а не ограждения: строки с пометкой
 * `// pult:guard` он из сравнения выбрасывает. Ослабленное изнутри ограждение (скажем,
 * проверка вложенности, всегда возвращающая истину) пройдёт и сверку, и канарейку по числу
 * пометок. Ограждения держатся канарейкой и глазами человека — при правке этого файла
 * их перечитывают целиком, а не построчно.
 *
 * ЭТОТ ФАЙЛ — ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ ИЗ ПРАВИЛА «ТОЛЬКО ПРИМИТИВЫ `pult/lib/fs-safe.mjs`».
 * Алгоритм синхронный по построению, поэтому копия импортирует `node:fs` напрямую
 * (`lstatSync`, `readFileSync`, `readdirSync` — все под ограждениями). Переписывать её
 * на асинхронные примитивы нельзя: сторож сравнивает СТРОКИ. Для остальных модулей демона
 * (реестр, читатели, сборка проекта) правило «ни одного прямого вызова `node:fs`» действует
 * без исключений.
 *
 * ОГРАЖДЕНИЯ — их девять, и это нижняя граница, а не точное число. Каждое изменение внутри
 * области `ORIGIN` помечено `// pult:guard`, а заменённая строка оригинала лежит рядом
 * строкой `//= <оригинал>` дословно:
 *
 *   1. `lstat` вместо `stat` — за симлинком не идём, содержимое уедет в HTTP-ответ.
 *   2. проверка вложенности каждого пути в папку кита после `resolve` (`ctx.join`).
 *   3. читаем только обычный файл (`ctx.file` через `isPlainFileStat`): оригинал устроен как
 *      «не каталог — читаем», а на Windows `hooks/COM1` в чужом списке состава даёт синхронное
 *      чтение последовательного порта, которое может не вернуться; таймаут к синхронной работе
 *      неприменим.
 *   4. потолок размера ОДНОГО файла: размер берётся из `lstat` до чтения, потому что
 *      `readFileSync` втягивает файл целиком.
 *   5. потолки числа файлов, объёма, записей в одном каталоге и числа каталогов за обход;
 *      объём считается сразу в двух счётчиках — по проекту и во внешнем бюджете, переданном
 *      аргументом.
 *   6. подробный результат — значение, отображение «путь — хеш файла» и признак усечения
 *      обхода с кодом причины — вместо шести символов (`ctx.note` плюс обёртка `scan()`).
 *   7. `catch` вокруг `lstat`: в оригинале несостоявшийся `stat` молча возвращает управление,
 *      и путь исчезает из состава.
 *   8. `catch` вокруг перечисления каталога — то же для каталога, который не перечислился.
 *   9. `catch` вокруг чтения файла — тот самый, что снабжён в оригинале комментарием
 *      «нечитаемый файл в отпечаток не попадёт».
 *
 * Ограждения 7–9 — не следствие новых проверок, а СОБСТВЕННЫЕ молчаливые пропуски оригинала.
 * Посимвольный перенос сохранил бы их как есть, и вышел бы посчитанный хеш от неполного
 * состава со снятым признаком усечения, то есть ложный `mismatch`. Это не теория: демон читает
 * кит проекта, в котором прямо сейчас работают хуки, а на Windows файл, открытый на запись,
 * даёт `EBUSY`/`EPERM`.
 *
 * ПОТОЛКИ ОСТАНАВЛИВАЮТ НЕ ТОЛЬКО ЧТЕНИЕ, НО И ОБХОД. Первая редакция на исчерпанном бюджете
 * выходила из одного вызова `add()`, а циклы шли дальше по всему оставшемуся дереву: читался
 * один файл, но `lstatSync` и `readdirSync` звались тысячи раз, и синхронный обход держал
 * весь демон, включая `/health`. Теперь первое исчерпание взводит флаг останова (`ctx.halt`),
 * который проверяется в `ctx.join()` — она зовётся первой строкой `add()` для каждого пути.
 *
 * Взводят флаг ТРОЕ, и это существенно: одних потолков чтения мало. Каталог не стоит ни файла,
 * ни байта, поэтому дерево из одних каталогов их не тратит вовсе и проходится до конца —
 * замер на 18 000 пустых каталогов: 2090 мс обхода, столько же ждала проверка здоровья,
 * признак усечения не взведён. Поэтому кроме потолков чтения есть потолок числа каталогов
 * (`MAX_DIRS` в `ctx.dir()`) и опрос времени (`budget.tick()` в `ctx.join()`) — единственное
 * место, где синхронный обход вообще смотрит на часы. Подробности и причина выбора мест —
 * в докблоке `state.halt` ниже.
 *
 * ПРИЗНАК УСЕЧЕНИЯ И ОБРЕЗКА СПИСКА — РАЗНЫЕ ВЕЩИ. `truncated` здесь означает «состав
 * неполон», и потребитель обязан превратить его в `verdict: unknown`, а не в посчитанное
 * значение: отпечаток от неполного состава — не отпечаток. Обрезка списка расхождений живёт
 * в `pult/read/kit.mjs` и называется там по-другому.
 *
 * Копия огорожена строже оригинала намеренно: хук набора ходит по СВОЕМУ киту, для него это
 * не уязвимость, и правило 2 раздела OVERVIEW запрещает трогать его этой задачей.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { inside, isPlainFileStat, faultFromError } from './fs-safe.mjs';
import {
  FAULT, BUDGET_PROJECT, MAX_TEXT_FILE, MAX_SCAN_FILE, MAX_DIR_ENTRIES, MAX_DIRS,
  MAX_SHIP_ENTRIES, MAX_SHIP_ENTRY,
} from '../config.mjs';

/**
 * Контекст текущего обхода. Модульная переменная, а не аргумент, — намеренно: аргумент
 * менял бы сигнатуры функций внутри области `ORIGIN`, то есть строки, которые сторож
 * сравнивает. Гонки здесь быть не может: алгоритм синхронный от первой строки до последней,
 * и второй обход не начнётся, пока не кончится первый.
 */
let ctx = null;

function createCtx(kitDir, opts) {
  const budget = opts.budget || null;
  const maxFiles = opts.files;
  const maxBytes = opts.bytes;

  const state = {
    kitDir: path.resolve(kitDir),
    listText: '',
    map: Object.create(null),
    files: 0,
    bytes: 0,
    dirs: 0,
    truncated: false,
    stopped: false,
    reason: null,
    faults: [],
  };

  /** Любой пропуск взводит признак усечения и запоминает ПЕРВУЮ причину. */
  state.skip = (code) => {
    state.truncated = true;
    if (state.reason === null) state.reason = code;
    if (!state.faults.includes(code)) state.faults.push(code);
    return false;
  };

  state.fault = (code) => {
    if (state.reason === null) state.reason = code;
    if (!state.faults.includes(code)) state.faults.push(code);
    return false;
  };

  /**
   * ЖЁСТКИЙ ОСТАНОВ ОБХОДА на исчерпанном бюджете.
   *
   * Флаг взводят ТРИ разных исчерпания, и каждое своё: потолки чтения (`state.file()`
   * и внешний бюджет по файлам и объёму), потолок числа каталогов `MAX_DIRS` в `state.dir()`
   * и временной бюджет — `budget.tick()` в `state.join()`. Трое, потому что стоят они дёшево,
   * а закрывают разное: первое — тяжёлые файлы, второе — дерево из одних каталогов
   * (оно не стоит ни файла, ни байта, и до потолка каталогов его не считал никто), третье —
   * длинный запрос в целом, включая уже исчерпанный чужим проектом сквозной бюджет.
   *
   * Без останова отказ `state.file()` возвращал управление из одного вызова `add()`, а циклы
   * по именам каталога и по записям состава шли дальше: `lstatSync` и `readdirSync` звались
   * по всему оставшемуся дереву. Обход синхронный, таймаут его не прерывает — на разросшемся
   * или подготовленном дереве встаёт весь демон вместе с проверкой здоровья, которой протокол
   * приёмки велит отвечать всегда.
   *
   * Флаг проверяется в `state.join()`: она зовётся первой строкой `add()` для каждого пути,
   * поэтому обход умирает и вглубь, и вширь. Проверки стоят именно в `state.join()`
   * и `state.dir()`, а не новыми строками внутри области `ORIGIN`: сторож
   * (`pult/tools/fingerprint-parity.mjs`) сравнивает строки, и лишняя пометка ограждения
   * подняла бы канарейку без нужды.
   *
   * Результат обхода это не меняет: признак усечения уже взведён, значение не выдаётся,
   * вердикт `unknown`, а отображение «путь — хеш» при усечении никто не читает.
   */
  state.halt = (code) => {
    state.stopped = true;
    return state.skip(code);
  };

  /** Ограждения 1, 3, 4: список состава читается как обычный файл и с потолком размера. */
  state.openList = (list) => {
    let st;
    try {
      st = lstatSync(list);
    } catch (e) {
      // Списка нет — это не «обход усечён», а «состав неизвестен»: свой код, признак не взводим.
      const code = (e && e.code === 'ENOENT') ? FAULT.SHIP_LIST_MISSING : faultFromError(e);
      return state.fault(code);
    }
    if (!isPlainFileStat(st, list)) return state.skip(FAULT.NOT_PLAIN_FILE);
    if (st.size > MAX_TEXT_FILE) return state.skip(FAULT.FILE_TOO_BIG);
    if (budget) {
      const code = budget.take(st.size);
      if (code) return state.halt(code);
    }
    try {
      state.listText = readFileSync(list, 'utf8');
    } catch (e) {
      return state.skip(faultFromError(e));
    }
    return true;
  };

  // Нулевой байт и обратный слэш — через коды символов: в исходнике они выглядели бы
  // escape-последовательностями, а в этом файле любая правка строк опасна вдвойне.
  const NUL = String.fromCharCode(0);
  const BACKSLASH = String.fromCharCode(92);

  /**
   * Обёртка над списком состава: недоверенный вход из чужого проекта, он управляет обходом
   * файловой системы. Отбрасываются абсолютные записи, записи с двумя точками, с обратным
   * слэшем, с нулевым байтом, длиннее потолка и всё сверх потолка числа записей.
   */
  state.entries = (list) => {
    const out = [];
    for (const raw of list) {
      if (out.length >= MAX_SHIP_ENTRIES) { state.skip(FAULT.ENTRY_REJECTED); break; }
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SHIP_ENTRY) {
        state.skip(FAULT.ENTRY_REJECTED);
        continue;
      }
      if (raw.includes(NUL) || raw.includes(BACKSLASH) || path.isAbsolute(raw)
        || /^[A-Za-z]:/.test(raw) || raw.split('/').includes('..')) {
        state.skip(FAULT.ENTRY_REJECTED);
        continue;
      }
      out.push(raw);
    }
    return out;
  };

  /**
   * Ограждение 2: путь обязан лежать внутри папки кита после `resolve`.
   *
   * Здесь же — точка останова (`state.halt`): бюджет исчерпан, и дальше не идёт ни один путь,
   * ни вглубь, ни вширь. Код причины при останове — «исчерпан бюджет», а не «запись отбита»:
   * запись годная, кончился ход.
   *
   * Время спрашивается здесь же, `budget.tick()`, и именно на каждом пути: обход синхронный,
   * и это единственное место, где он вообще смотрит на часы. Каталог не стоит ни файла,
   * ни байта, поэтому по дереву из одних каталогов бюджет молчал бы до конца обхода.
   */
  state.join = (dir, rel) => {
    if (state.stopped) { state.skip(FAULT.BUDGET_EXHAUSTED); return null; }
    if (budget) {
      const code = budget.tick();
      if (code) { state.halt(code); return null; }
    }
    const abs = path.join(dir, rel);
    if (!inside(state.kitDir, abs)) { state.skip(FAULT.ENTRY_REJECTED); return null; }
    return abs;
  };

  /**
   * Ограждение 5 (каталоги): потолок записей в ОДНОМ каталоге и потолок числа каталогов
   * за весь обход. Второй потолок — про стоимость самого обхода, а не про состав: каталог
   * не читается, не считается ни файлом, ни байтом, и без него дерево из одних каталогов
   * проходится целиком. Счёт идёт ДО `readdirSync`, чтобы лишнего системного вызова
   * не случилось вовсе. Бросает — ловит оригинал.
   */
  state.dir = (abs) => {
    if (state.dirs + 1 > MAX_DIRS) { state.halt(FAULT.BUDGET_EXHAUSTED); return []; }
    state.dirs += 1;
    const names = readdirSync(abs);
    if (names.length > MAX_DIR_ENTRIES) {
      // Останов, а не обрезка: состав уже неполон, значение всё равно не выдаётся, а каталог
      // такой ширины — сам по себе признак дерева, которое нам не по бюджету.
      state.halt(FAULT.BUDGET_EXHAUSTED);
      return names.slice(0, MAX_DIR_ENTRIES);
    }
    return names;
  };

  /** Ограждения 3, 4, 5 (файлы): обычность, размер, счётчики по проекту и внешний бюджет. */
  state.file = (st, rel) => {
    if (!isPlainFileStat(st, rel)) return state.skip(FAULT.NOT_PLAIN_FILE);
    if (st.size > MAX_SCAN_FILE) return state.skip(FAULT.FILE_TOO_BIG);
    if (state.files + 1 > maxFiles || state.bytes + st.size > maxBytes) {
      return state.halt(FAULT.BUDGET_EXHAUSTED);
    }
    if (budget) {
      const code = budget.take(st.size);
      if (code) return state.halt(code);
    }
    state.files += 1;
    state.bytes += st.size;
    return true;
  };

  /** Ограждение 6: попутно копим отображение «путь — хеш файла». */
  state.note = (rel, hash) => {
    state.map[rel] = hash;
    return rel + '\t' + hash;
  };

  return state;
}

// >>> ORIGIN hooks/kit-fingerprint.mjs
const SKIP = new Set([
  'settings.json', 'settings.local.json',
  'PROJECT_PROFILE.md', 'PROJECT_PROFILE.template.md',
  'guide.html', 'map.html', '.cckit-manifest.json', '.init-mode',
]);

/** Пути из ship.list (без комментариев и пустых строк). null — списка нет. */
export function shipEntries(kitDir) {
  const list = path.join(kitDir, 'ship.list');
  if (!ctx.openList(list)) return null;                                         // pult:guard
  //=   if (!existsSync(list)) return null;
  const out = [];
  for (const raw of ctx.listText.split(/\r?\n/)) {                              // pult:guard
  //=   for (const raw of readFileSync(list, 'utf8').split(/\r?\n/)) {
    const entry = raw.split('#')[0].trim();
    if (entry) out.push(entry);
  }
  return ctx.entries(out);                                                      // pult:guard
  //=   return out;
}

/** Шесть символов sha256 от отсортированных пар «путь + хеш». null — считать не из чего. */
export function fingerprint(kitDir) {
  const list = shipEntries(kitDir);
  if (!list) return null;
  const files = [];
  const add = (rel) => {
    if (SKIP.has(rel)) return;
    const abs = ctx.join(kitDir, rel); if (abs === null) return;                // pult:guard
    //=     const abs = path.join(kitDir, rel);
    let st;
    try { st = lstatSync(abs); } catch { ctx.skip(FAULT.LSTAT_FAILED); return; } // pult:guard
    //=     try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      let names;
      try { names = ctx.dir(abs); } catch { ctx.skip(FAULT.DIR_UNREADABLE); return; } // pult:guard
      //=       try { names = readdirSync(abs); } catch { return; }
      for (const n of names.sort()) add(rel + '/' + n);
      return;
    }
    if (!ctx.file(st, rel)) return; try {                                       // pult:guard
    //=     try {
      files.push(ctx.note(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))); // pult:guard
      //=       files.push(rel + '\t' + createHash('sha256').update(readFileSync(abs)).digest('hex'));
    } catch { ctx.skip(FAULT.FILE_UNREADABLE); }                                // pult:guard
    //=     } catch { /* нечитаемый файл в отпечаток не попадёт */ }
  };
  for (const entry of list) add(entry.replace(/\/$/, ''));
  if (!files.length) return null;
  files.sort();
  return createHash('sha256').update(files.join('\n'), 'utf8').digest('hex').slice(0, 6);
}
// <<< ORIGIN

/**
 * Подробный обход: значение, отображение «путь — хеш файла», признак усечения и код причины.
 *
 * При усечении значение НЕ выдаётся (`value: null`) прямо здесь, не дожидаясь потребителя:
 * хеш от неполного состава — не отпечаток, и единственное, что он умеет, — это ложная тревога
 * на том самом сигнале, ради которого отпечаток заводили.
 *
 * @param {string} kitDir  папка кита (`<проект>/.claude`)
 * @param {object} options `budget` — внешний счётчик (сквозной по запросу либо собственный
 *                         бюджет эталона), `files` и `bytes` — потолки этого обхода.
 */
export function scan(kitDir, options = {}) {
  const opts = {
    budget: options.budget || null,
    files: Number.isFinite(options.files) ? options.files : BUDGET_PROJECT.files,
    bytes: Number.isFinite(options.bytes) ? options.bytes : BUDGET_PROJECT.bytes,
  };

  ctx = createCtx(kitDir, opts);
  let value = null;
  try {
    value = fingerprint(kitDir);
  } catch (e) {
    ctx.skip(faultFromError(e));
  }

  let reason = null;
  if (ctx.truncated) reason = ctx.reason || FAULT.SCAN_TRUNCATED;
  else if (value === null) reason = ctx.reason || FAULT.FINGERPRINT_UNCOUNTABLE;

  const result = {
    value: ctx.truncated ? null : value,
    files: ctx.map,
    truncated: ctx.truncated,
    reason,
    faults: ctx.faults.slice(),
  };
  ctx = null;
  return result;
}
