#!/usr/bin/env node
/**
 * Единственная дверь демона к диску и к чужому тексту.
 *
 * Все прочие модули пульта `node:fs` не импортируют вовсе — единственное объявленное
 * исключение — копия алгоритма отпечатка (`pult/lib/fingerprint.mjs`), она синхронная
 * по построению и это записано в её шапке. Правило проверяется глазами и поиском строки
 * импорта, машинного крючка на него нет.
 *
 * Чем эта дверь отличается от обычного чтения файла:
 *
 *   • `lstat` вместо `stat` везде. За симлинком демон не идёт никогда: содержимое уедет
 *     в HTTP-ответ, то есть покинет процесс навсегда, а подложить ссылку на чужой файл
 *     внутрь своей `.claude/` может кто угодно, у кого есть эта папка. Тот же порядок держит
 *     кит — `readTaskFile()` в `.claude/hooks/map.mjs`.
 *   • Обычность файла проверяется ДО открытия дескриптора и по двум признакам сразу:
 *     `lstat().isFile()` и имя. Каталоги, симлинки, FIFO и сокеты отсекает первый признак,
 *     зарезервированные имена устройств Windows — второй: `hooks/COM1` в чужом списке состава
 *     даёт чтение последовательного порта, которое может не вернуться, а таймаут к синхронной
 *     работе неприменим.
 *   • У каждого чтения есть потолок, и он проверяется по размеру из `lstat` ДО чтения.
 *   • Ошибка наружу уходит кодом из закрытого словаря, а не текстом: сообщение об ошибке
 *     в современном Node цитирует разбираемое содержимое.
 *
 * Времена проходят только через `timeField()` — «починки» негодного времени до машинного
 * вида здесь нет и не будет: не совпало с привязанной регуляркой своего вида, значит `null`
 * и код отказа.
 *
 *   node pult/lib/fs-safe.mjs --selftest    показать шесть отказов на временном каталоге
 *
 * Шесть — при полном прогоне. Там, где нет привилегии создания ссылок (обычная Windows),
 * случай с симлинком пропускается, и самотест говорит об этом строкой: пропуск не отказ,
 * и зелёный прогон на такой машине отсева симлинков не доказывает.
 */

import { lstat, readFile, readdir, open, mkdir, writeFile, rename, chmod, realpath, rm, mkdtemp, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  FAULT, ERROR_CODES, TIME_RE, MAX_TIME_RAW, MAX_TEXT, MAX_TEXT_FILE, MAX_DIR_ENTRIES, MAX_PATH,
  COUNTER_RE,
} from '../config.mjs';

// Зарезервированные имена устройств Windows: с расширением и без, в любом каталоге.
// Хвостовые точки и пробелы Windows отбрасывает сам («CON.» и «COM1 » — то же устройство),
// поэтому сравнение идёт после их отсечения.
const DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

// --- ошибки ------------------------------------------------------------------

/**
 * Имя системной ошибки в код из закрытого словаря. Ни `message`, ни `stack`, ни путь
 * наружу не идут: первое цитирует чужое содержимое, третье несёт имя пользователя.
 */
export function faultFromError(e) {
  const key = (e && (e.code || e.name)) || '';
  return ERROR_CODES[key] || FAULT.UNKNOWN;
}

// --- пути --------------------------------------------------------------------

/**
 * Лежит ли `target` внутри `base`.
 *
 * Оба пути прогоняются через `resolve` ДО всякого сравнения: диск-относительная форма
 * Windows (`C:foo` — «foo относительно текущего каталога диска C») ловится только так.
 * Вложенность проверяется по относительному пути, а не по префиксу строки, иначе
 * `/a/bc` считался бы вложенным в `/a/b`. Абсолютный результат `path.relative` означает
 * разные диски на Windows — это «снаружи» наравне с двумя точками.
 */
export function inside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (b === t) return true;
  const rel = path.relative(b, t);
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}

/**
 * Сетевой путь (`\\host\share`, `\\?\UNC\...`, `//host/share`).
 *
 * Отбивается ДО любого обращения к диску: `stat` по такому пути уходит в сеть к чужому хосту
 * с попыткой аутентификации — это и зависание на десятки секунд, и утечка учётных данных.
 * Поддержка сетевых путей на фазе 1 не предусмотрена намеренно.
 */
export function isUncPath(p) {
  const s = String(p == null ? '' : p);
  if (/^[\\/]{2}/.test(s)) return true;
  return /^\\\\\?\\UNC\\/i.test(s);
}

/** Имя из списка зарезервированных устройств Windows. */
export function isDeviceName(name) {
  const base = path.basename(String(name == null ? '' : name)).replace(/[. ]+$/, '');
  return DEVICE_RE.test(base);
}

/**
 * Обычный ли это файл — по уже полученному `lstat` и по имени.
 *
 * Вынесено отдельно, потому что этой же проверкой пользуется синхронная копия алгоритма
 * отпечатка: у неё `lstat` уже в руках, а второй вызов был бы и лишней работой, и окном
 * между проверкой и чтением.
 */
export function isPlainFileStat(st, name) {
  if (!st || !st.isFile()) return false;
  return !isDeviceName(name);
}

// --- чтение ------------------------------------------------------------------

/** `lstat` без исключения: `{ok:true, stat}` либо `{ok:false, code}`. */
export async function statSafe(p) {
  try {
    return { ok: true, stat: await lstat(p) };
  } catch (e) {
    return { ok: false, code: faultFromError(e) };
  }
}

/** Обычный ли файл: `{ok:true, stat}` либо `{ok:false, code}`. */
export async function isPlainFile(p) {
  const st = await statSafe(p);
  if (!st.ok) return st;
  if (!isPlainFileStat(st.stat, p)) return { ok: false, code: FAULT.NOT_PLAIN_FILE };
  return st;
}

/**
 * Текст файла с потолком размера. Порядок жёсткий: обычность файла, затем размер из `lstat`,
 * и только потом чтение. `readFile` втягивает файл целиком, поэтому проверять размер после
 * чтения бессмысленно.
 */
export async function readTextCapped(file, limit = MAX_TEXT_FILE, budget = null) {
  const st = await isPlainFile(file);
  if (!st.ok) return { ok: false, text: '', code: st.code };
  if (st.stat.size > limit) return { ok: false, text: '', code: FAULT.FILE_TOO_BIG };
  if (budget) {
    const code = budget.take(st.stat.size);
    if (code) return { ok: false, text: '', code };
  }
  try {
    return { ok: true, text: await readFile(file, 'utf8'), code: null };
  } catch (e) {
    return { ok: false, text: '', code: faultFromError(e) };
  }
}

/** Имена в каталоге с потолком числа записей. Признак обрезки возвращается, а не глотается. */
export async function readDirCapped(dir, cap = MAX_DIR_ENTRIES) {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    return { ok: false, names: [], truncated: false, code: faultFromError(e) };
  }
  const truncated = names.length > cap;
  return { ok: true, names: truncated ? names.slice(0, cap) : names, truncated, code: truncated ? FAULT.BUDGET_EXHAUSTED : null };
}

/**
 * Хвост файла в байтах. Журнал событий растёт без ротации, и читать его целиком нельзя:
 * диагностика не имеет права дорожать вместе с файлом (тот же приём — в `selftest()`
 * в `.claude/hooks/events.mjs`).
 *
 * Обычность файла проверяется ДО открытия дескриптора; сам дескриптор закрывается
 * в `finally`, иначе одна ошибка чтения оставляет его висеть на всё время жизни демона.
 * `partial` означает «читали не с начала»: первая строка буфера может быть обрублена
 * посередине, в том числе посреди многобайтного символа.
 *
 * СКВОЗНОЙ БЮДЖЕТ ЗДЕСЬ ТРАТИТСЯ, как и у всякого другого чтения. Без этого журналы всех
 * проектов ответа (по 64 КБ на проект при потолке в 64 проекта) читались бы за границей
 * всех бюджетов — величина не страшная, но фраза «бюджет тратится всеми читателями проекта»
 * была бы неправдой. Списывается РАЗМЕР ХВОСТА, а не размер файла: читаем ровно столько,
 * а гасить бюджет неограниченно растущим журналом, который мы намеренно не читаем целиком,
 * значило бы наказывать за чужую историю.
 */
export async function tailBytes(file, bytes, budget = null) {
  const st = await isPlainFile(file);
  if (!st.ok) return { ok: false, buf: Buffer.alloc(0), partial: false, code: st.code };
  const size = st.stat.size;
  const take = Math.min(size, bytes);
  if (budget) {
    const code = budget.take(take);
    if (code) return { ok: false, buf: Buffer.alloc(0), partial: false, code };
  }
  const from = size - take;
  let fh = null;
  try {
    fh = await open(file, 'r');
    const buf = Buffer.alloc(take);
    if (take > 0) await fh.read(buf, 0, take, from);
    return { ok: true, buf, partial: from > 0, code: null };
  } catch (e) {
    return { ok: false, buf: Buffer.alloc(0), partial: false, code: faultFromError(e) };
  } finally {
    if (fh) { try { await fh.close(); } catch { /* дескриптор уже закрыт */ } }
  }
}

// --- текст -------------------------------------------------------------------

/**
 * Строка свободного текста, пригодная к выдаче наружу.
 *
 * Что вырезается и почему:
 *   • управляющие символы C0 (кроме табуляции и перевода строки) и DEL — образец очистки
 *     в ките `clean()` в `.claude/hooks/events.mjs`;
 *   • `U+2028` и `U+2029` — ломают JSON, встроенный в `<script>`, а такой JSON заведёт фаза 2;
 *   • bidi-override `U+202A`…`U+202E` — подменяют вид заголовка задачи в списке.
 *
 * Дальше обрезка по потолку. Экранирование НЕ делается: `<`, `>` и `&` остаются живыми,
 * и экранировать их обязан потребитель (пункт 16 раздела 1.5 контракта).
 */
export function capText(s, limit = MAX_TEXT) {
  const raw = String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u202A-\u202E]/g, '');
  if (raw.length <= limit) return { text: raw, truncated: false };
  return { text: raw.slice(0, limit), truncated: true };
}

/**
 * Единственная дверь к временам.
 *
 * Строка длиннее потолка отбрасывается без разбора; затем — проверка привязанной регуляркой
 * своего вида. Совпало — `{value, kind}`, где `value` есть СОВПАДЕНИЕ регулярки, а не исходная
 * строка. Не совпало — `null`, и вызывающий кладёт в `faults[]` код «нераспознанное время».
 *
 * `capText()` к временам не применяется намеренно: негодное время не «чинится» до вида
 * машинного, оно исчезает. Пометку `kind` не ставит больше никто — поэтому она не обещает
 * больше, чем проверено.
 */
export function timeField(raw, kind) {
  const re = TIME_RE[kind];
  if (!re) return null;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_TIME_RAW) return null;
  const m = raw.match(re);
  if (!m) return null;
  return { value: m[0], kind };
}

/**
 * Перечислимое поле: значение отдаётся ТОЛЬКО как совпадение с закрытым словарём кита.
 *
 * Ровно то же правило, что у версии и у времён, и по той же причине: подготовленный проект
 * в реестре кладёт в `status:` что угодно длиной до потолка строки, а фаза 2 вставит поле
 * в разметку как машинное. Не совпало — `null`, и вызывающий кладёт в `faults[]` код
 * «нераспознанное значение перечислимого поля».
 */
export function enumField(raw, list) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENUM_RAW) return null;
  return list.includes(raw) ? raw : null;
}

// Длиннее этого до словаря не доходит: самое длинное значение всех словарей — 19 знаков.
const MAX_ENUM_RAW = 64;

/**
 * Счётчик: целое без знака либо `null`. Правило написано в `iters()`
 * в `.claude/hooks/task.mjs`, здесь оно повторено, а не изобретено заново.
 */
export function counterField(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return COUNTER_RE.test(raw) ? Number(raw) : null;
}

// --- бюджет ------------------------------------------------------------------

/**
 * Счётчик файлов, байтов и времени, который читатели принимают аргументом.
 *
 * Экземпляров за запрос несколько (сквозной для проектов и отдельный для эталона), поэтому
 * бюджет заводится вызовом, а не живёт модульной переменной: общая переменная означала бы,
 * что тяжёлый проект гасит сверку эталона у всех остальных.
 *
 * На исчерпании возвращается КОД из словаря, а не исключение с текстом: исключение пришлось бы
 * ловить в каждом читателе и превращать обратно в код, а по дороге в `message` попал бы путь.
 */
export function makeBudget({ files = Infinity, bytes = Infinity, ms = Infinity } = {}) {
  const started = Date.now();
  let usedFiles = 0;
  let usedBytes = 0;
  let code = null;

  const overtime = () => Date.now() - started > ms;

  return {
    get code() { return code; },
    get exhausted() { return code !== null; },
    used() { return { files: usedFiles, bytes: usedBytes, ms: Date.now() - started }; },
    /** Только время: для проверок между шагами, где файлы не читаются. */
    tick() {
      if (code) return code;
      if (overtime()) code = FAULT.BUDGET_EXHAUSTED;
      return code;
    },
    /** Счесть файл размера `size`. Вернёт код при исчерпании любого из трёх пределов. */
    take(size = 0) {
      if (code) return code;
      if (overtime() || usedFiles + 1 > files || usedBytes + size > bytes) {
        code = FAULT.BUDGET_EXHAUSTED;
        return code;
      }
      usedFiles += 1;
      usedBytes += size;
      return null;
    },
  };
}

// --- запись (только свои файлы пульта) ---------------------------------------
//
// В чужой `.claude/` не пишется ни байта — это критерий готовности фазы. Здесь пишется
// собственный реестр пульта в профиле пользователя, и режим доступа ставится явно: реестр —
// это список абсолютных путей с именем пользователя.

/** Каталог с режимом `0700`. На Windows смена режима пропускается мягко. */
export async function mkdirSecure(dir) {
  await mkdir(dir, { recursive: true });
  try { await chmod(dir, 0o700); } catch { /* Windows — прав такого вида нет, это не ошибка */ }
}

/**
 * Атомарная запись с режимом `0600`: временный файл В САМОМ каталоге назначения
 * и переименование. Общий временный каталог не годится — переименование через границу
 * файловой системы не атомарно, а сам файл по дороге полежал бы с чужими правами.
 * Режим ставится ДО переименования, как это делает `writeSecure()` в `.claude/hooks/verify.mjs`.
 */
export async function writeSecureAtomic(file, text) {
  const dir = path.dirname(file);
  await mkdirSecure(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, text, { mode: 0o600 });
  try { await chmod(tmp, 0o600); } catch { /* Windows */ }
  await rename(tmp, file);
}

/** `realpath` без исключения. */
export async function realPath(p) {
  try {
    return { ok: true, path: await realpath(p), code: null };
  } catch (e) {
    return { ok: false, path: '', code: faultFromError(e) };
  }
}

/** Путь пригоден к обращению: не пуст, не длиннее потолка, без нулевого байта. */
export function sanePath(p) {
  const s = String(p == null ? '' : p);
  if (!s || s.length > MAX_PATH) return false;
  return !/[\u0000-\u001F\u007F]/.test(s);
}

// --- самопроверка ------------------------------------------------------------

async function selftest() {
  const out = (s) => process.stdout.write(`${s}\n`);
  const base = await mkdtemp(path.join(os.tmpdir(), 'pult-fs-safe-'));
  let shown = 0;
  let skipped = 0;
  try {
    // 1. выход за базовый каталог
    const outside = path.join(base, '..', 'evil.txt');
    out(`1. выход за базовый каталог      : inside() = ${inside(base, outside)} (ожидание false)`);
    if (inside(base, outside) === false) shown += 1;

    // 2. симлинк
    const target = path.join(base, 'target.txt');
    await writeFile(target, 'секрет', 'utf8');
    const link = path.join(base, 'link.txt');
    let linked = true;
    try {
      await symlink(target, link, 'file');
    } catch {
      linked = false;
    }
    if (linked) {
      const r = await readTextCapped(link, 1024);
      out(`2. симлинк                       : ok=${r.ok} code=${r.code} (ожидание ${FAULT.NOT_PLAIN_FILE})`);
      if (r.code === FAULT.NOT_PLAIN_FILE) shown += 1;
    } else {
      out('2. симлинк                       : случай пропущен: нет привилегии');
      skipped += 1;
    }

    // 3. файл сверх потолка
    const big = path.join(base, 'big.txt');
    await writeFile(big, 'x'.repeat(4096), 'utf8');
    const rBig = await readTextCapped(big, 100);
    out(`3. файл сверх потолка            : ok=${rBig.ok} code=${rBig.code} (ожидание ${FAULT.FILE_TOO_BIG})`);
    if (rBig.code === FAULT.FILE_TOO_BIG) shown += 1;

    // 4. не обычный файл: каталог и зарезервированное имя устройства
    const rDir = await readTextCapped(base, 1024);
    const deviceLike = isDeviceName('hooks/COM1') && isDeviceName('CON.') && isDeviceName('LPT9.txt');
    out(`4. не обычный файл               : каталог code=${rDir.code}, имя устройства опознано=${deviceLike}`);
    if (rDir.code === FAULT.NOT_PLAIN_FILE && deviceLike) shown += 1;

    // 5. исчерпанный бюджет
    const budget = makeBudget({ files: 1 });
    budget.take(10);
    const code = budget.take(10);
    out(`5. исчерпанный бюджет            : code=${code} (ожидание ${FAULT.BUDGET_EXHAUSTED})`);
    if (code === FAULT.BUDGET_EXHAUSTED) shown += 1;

    // 6. нераспознанное время
    const bad = timeField('вчера вечером', 'local-naive');
    const good = timeField('2026-08-31 16:13', 'local-naive');
    out(`6. нераспознанное время          : мусор -> ${JSON.stringify(bad)}, годное -> ${JSON.stringify(good)}`);
    if (bad === null && good && good.value === '2026-08-31 16:13') shown += 1;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  out('');
  out(`отказов показано: ${shown}${skipped ? `, пропусков: ${skipped}` : ''}`);
  if (skipped) {
    out('пропуск — не отказ: зелёный самотест на платформе без привилегии создания ссылок');
    out('доказательством отсева симлинков не является.');
  }
  out('временный каталог удалён');
  return 0;
}

/**
 * Самопроверка запускается ТОЛЬКО при прямом запуске этого файла.
 *
 * Условие «третий аргумент командной строки равен `--selftest`» срабатывало при ИМПОРТЕ:
 * `node pult/tools/registry-add.mjs --selftest` поднимал самотест примитивов побочным
 * эффектом и уходил в `process.exit` вместо подсказки по использованию. Точка входа
 * определяется сравнением `import.meta.url` с `process.argv[1]`; абсолютный путь Windows
 * приводится к `file://` — иначе буква диска читается как схема адреса.
 */
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entryPoint && process.argv[2] === '--selftest') {
  selftest().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`[pult] самопроверка не состоялась: ${faultFromError(e)}\n`);
    process.exit(1);
  });
}
