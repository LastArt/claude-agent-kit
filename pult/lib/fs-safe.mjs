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
 * ФАЗА 2 добавила сюда ЧЕТЫРЕ вещи, и все четыре живут здесь не случайно:
 *
 *   • `resolveTarget()` — единый шлюз пути: через него обязана проходить каждая запись
 *     в чужой проект и каждое обращение по клиентскому пути. Гарантия «в набор не пишем»
 *     с этой фазы ПРОВЕРОЧНАЯ, а не структурная: ослабление любой проверки шлюза открывает
 *     запись в кит, и снаружи это невидимо. Здесь же живёт правило имени секрета
 *     (`isSecretPath()`): у чтения оно даёт закрытое УМОЛЧАНИЕ, у записи — отказ НАСОВСЕМ.
 *   • `writeProjectFile()` — запись обычного файла проекта: временный файл рядом плюс
 *     переименование. ЖЁСТКАЯ ССЫЛКА внутри проекта на файл снаружи от обычного файла
 *     НЕОТЛИЧИМА: `lstat` показывает обычный файл, родитель честно внутри корня. Отбивает
 *     её не проверка, а СТРАТЕГИЯ ЗАПИСИ — переименование заменяет запись в каталоге
 *     и исходный inode не трогает. Поэтому запись «на месте» здесь запрещена, а «зачем
 *     временный файл, пишем прямо» — это возврат дыры.
 *   • `resolveCommand()` — единая дверь к подпроцессу: поиск исполняемого файла есть
 *     обращение к диску, а этот модуль и так единственное место с прямым `node:fs`. Имя
 *     разрешается ТОЛЬКО по `PATH`, рабочий каталог в поиске не участвует никогда.
 *     Форма запуска берётся потребителем ЦЕЛИКОМ; аргументы подставляются в неё
 *     функцией `withArgs()`, а не пересборкой формы по одному полю файла.
 *     ОГОВОРКА: `NoDefaultCurrentDirectoryInExePath=1` прикрывает поиск, который делает
 *     САМ РЕБЁНОК, а наш запуск libuv разрешает сам, просматривая `cwd` первым, — этой
 *     переменной он не спрашивает. Единственная защита здесь — абсолютный путь.
 *   • `gitEnv()` и `sessionEnv()` — ДВА окружения подпроцесса, а не одно: у служебного git
 *     и у живой сессии требования противоположные, и общая функция ломает терминал, а лечат
 *     такую поломку наследованием окружения целиком — то есть возвратом `CCKIT_GATE`.
 *
 *   node pult/lib/fs-safe.mjs --selftest    двадцать один случай на временных стендах
 *
 * Двадцать один — при полном прогоне. Там, где нет привилегии создания ссылок (обычная Windows),
 * случаи с симлинками пропускаются, и самотест говорит об этом строкой: пропуск не отказ,
 * и зелёный прогон на такой машине отсева симлинков не доказывает.
 *
 * САМОТЕСТ УМЕЕТ ПРОВАЛИТЬСЯ: несовпавший случай помечается строкой, а сумма показанных
 * и пропущенных сверяется с `SELFTEST_CASES`; расхождение — код 1. Раньше здесь стоял
 * безусловный `return 0`, и регрессия в отдельном случае давала другое число в итоговой
 * строке при зелёном коде возврата.
 */

import { lstat, readFile, readdir, open, mkdir, writeFile, rename, chmod, realpath, rm, mkdtemp, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  FAULT, ERROR_CODES, TIME_RE, MAX_TIME_RAW, MAX_TEXT, MAX_TEXT_FILE, MAX_DIR_ENTRIES, MAX_PATH,
  COUNTER_RE,
  MAX_REL_PATH, MAX_EDIT_FILE, SECRET_BASENAME_RE,
  GIT_ENV_ALLOW, GIT_ENV_ADD, SESSION_ENV_DROP, SESSION_ENV_DROP_PREFIX, SESSION_ENV_ADD,
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

// --- фаза 2: ЕДИНЫЙ ШЛЮЗ ПУТИ ------------------------------------------------
//
// Через `resolveTarget()` обязана проходить КАЖДАЯ запись в чужой проект и каждое обращение
// по клиентскому пути. Режима два, чтение и запись, и проверка «не в наборе» принадлежит
// режиму записи. Порядок проверок ниже — не украшение: перестановка любой пары превращает
// гарантию в совещательную.

/**
 * Обе базы папки набора: лексическая от УЖЕ канонизированного корня и её канонизация.
 *
 * Канонизировать базу обязательно: `.claude`, оказавшийся симлинком, развёл бы лексическую
 * и канонизированную проверки по двум разным базам, и сверка потеряла бы смысл. Проверяются
 * потом ОБЕ — это дешевле рассуждений о том, какая из них достаточна.
 *
 * `absent: true` означает ровно одно: папки `.claude` у проекта нет вовсе. Это штатное
 * состояние реестра (`no_kit` фазы 1), а не поломка, и обрабатывается оно отдельной ветвью
 * у вызывающего.
 */
async function kitBases(canonRoot) {
  const lex = path.join(canonRoot, '.claude');
  const st = await statSafe(lex);
  if (!st.ok) {
    if (st.code === FAULT.PATH_UNREACHABLE) return { ok: false, absent: true, bases: [lex] };
    return { ok: false, absent: false, bases: [lex], code: st.code };
  }
  const rp = await realPath(lex);
  if (!rp.ok) return { ok: false, absent: false, bases: [lex], code: rp.code };
  return { ok: true, absent: false, bases: lex === rp.path ? [lex] : [lex, rp.path] };
}

/**
 * Ведёт ли путь внутрь служебной папки `.git` — НА ЛЮБОМ УРОВНЕ, а не только в корне.
 *
 * Закрывается это в ШЛЮЗЕ, а не сокрытием имени в дереве, и разница здесь не косметическая:
 * сокрытие имени в списке доступом не управляет — читатель файла зовётся по пути, и `.git`,
 * не показанный в дереве, читался бы обычным запросом. В `.git/config` лежат учётные данные
 * (проверено на стенде ревью: чтение возвращало строку `url` с токеном), в `.git/hooks`
 * лежат исполняемые файлы, а запись в конфиг меняет поведение самого git — поэтому закрыты
 * ОБА режима, и чтение, и запись.
 *
 * Вложенный репозиторий закрывается тем же правилом: фильтр смотрит каждый сегмент
 * относительного пути, а не первый.
 *
 * Сравнение без учёта регистра только на Windows: там `.GIT` и `.git` — одна и та же папка,
 * а на POSIX это два разных каталога, и запрещать законный `.GIT` человека нам незачем.
 * Правило имени вынесено в `isGitDirName()` и берётся оттуда же деревом: список и шлюз
 * обязаны говорить одно и то же, иначе в дереве видна папка, которая ни на что не отвечает.
 */
export function isGitDirName(name) {
  const s = String(name == null ? '' : name);
  if (s === '.git') return true;
  return process.platform === 'win32' && s.toLowerCase() === '.git';
}

export function insideGitDir(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).some((seg) => isGitDirName(seg));
}

/**
 * Попал ли путь под образец имени секрета (`SECRET_BASENAME_RE` в `pult/config.mjs`) — те же
 * пять образцов, что стоят в `permissions.deny` набора.
 *
 * ПРАВИЛО ИМЕНИ ЖИВЁТ ЗДЕСЬ, В ШЛЮЗЕ, а не у читателя, ровно по той же причине, по которой
 * здесь живёт `isGitDirName()`: одним и тем же правилом обязаны пользоваться отказ режима
 * записи, признак `writable`, пометка в дереве и умолчание читателя. Пока функция лежала
 * у читателя, шлюз о секретах не знал вовсе — и запись в `.env` не ограничивалась ничем
 * (находка ревью фазы 2, круг по части C).
 *
 * Сверяется БАЗОВОЕ ИМЯ, и лучше всего — уже разрешённого пути: все пять образцов набора
 * по сути образцы базового имени, а сверка сырой присланной строки промахивается
 * на `sub/../.env` и `./.env`, то есть тихо снимает и умолчание, и строку следа в stdout.
 *
 * Известная граница (принятый риск 3 фазы 1): на Windows поток данных в имени
 * (`.env::$DATA`) мимо образца. На записи это не срабатывает — переименование в поток падает.
 */
export function isSecretPath(p) {
  const base = path.basename(String(p == null ? '' : p));
  return SECRET_BASENAME_RE.test(base);
}

/**
 * Разрешить клиентский относительный путь внутри корня проекта.
 *
 * Порядок строго такой:
 *   1. строки пригодны к обращению и не сетевые;
 *   2. корень канонизируется `realpath` ОДИН раз, и дальше канонизированное сравнивается
 *      только с канонизированным (иначе проект, лежащий по симлинку, получает отказ
 *      на каждую запись, а такие отказы лечат ослаблением проверки);
 *   3. режим записи: у проекта нет папки `.claude` — отказ `write_no_kit` ДО остальных
 *      проверок записи и независимо от того, куда указывает цель;
 *   4. после `path.resolve` цель лежит внутри канонизированного корня;
 *   5. ОБА режима: цель не лежит внутри служебной папки `.git` ни на каком уровне
 *      (`insideGitDir()`) — там учётные данные и исполняемые файлы;
 *   6. режим записи: цель не лежит внутри папки набора (обе базы) и не попадает под образец
 *      имени секрета (`isSecretPath()`) — второе закрыто НАСОВСЕМ, парного признаку `reveal`
 *      ключа у записи нет, обоснование выбора у `writeRefusal()` ниже;
 *   7. `realpath` каталога-РОДИТЕЛЯ с повторной проверкой ВСЕХ трёх условий по вернувшемуся
 *      пути: симлинк на родителя проверкой самой цели не ловится, а на Windows той же
 *      проверкой снимаются короткие имена 8.3 вида `CLAUD~1`;
 *   8. `lstat` цели ДО открытия: существующая цель обязана быть обычным файлом;
 *   9. размер присланного текста в пределах потолка.
 *
 * ОБЩИЙ ПРИНЦИП, который надо держать в голове при любой правке этого места: НЕСОСТОЯВШАЯСЯ
 * КАНОНИЗАЦИЯ НИКОГДА НЕ ОЗНАЧАЕТ «ПРОВЕРКУ ПРОПУСКАЕМ». Не канонизировался корень — это
 * отказ «недоступный путь», а не пропуск обеих проверок; не канонизировалась база набора
 * по причине, отличной от отсутствия (права, гонка), — тоже отказ, а не молчаливое разрешение.
 *
 * ПРОЕКТ БЕЗ НАБОРА ЗАКРЫТ НА ЗАПИСЬ ЦЕЛИКОМ (решение человека от 01.09.2026). Обе
 * «естественные» реализации ветви плохи: отказ «недоступный путь» ломает запись без
 * объяснения и лечится пропуском проверки, а пропуск проверки открывает демону право создать
 * `.claude/...` в чужом проекте. Поэтому ветвь решена ЯВНЫМ отказом со своей причиной:
 * пульт — панель НАД НАБОРОМ, а не общий редактор файлов на машине, реестр законно содержит
 * проекты без набора, и запись в них просто не предусмотрена. Режим чтения этим не задет
 * вовсе: дерево, файл и дифф в таком проекте работают как работали.
 *
 * Возвращается РАЗРЕШЁННЫЙ АБСОЛЮТНЫЙ ПУТЬ, и все последующие обращения (`lstat`, временный
 * файл, `chmod`, `rename`) идут по нему, а не по исходной строке: иначе между проверкой
 * и записью родитель подменяется симлинком и проверка становится совещательной.
 *
 * Рядом с путём возвращается ПРИЗНАК ЗАПИСИ (`writable`), посчитанный от исхода режима
 * записи, а не от одного признака «внутри набора»: читателям он нужен, чтобы кнопка
 * сохранения на странице не притворялась активной там, где запись отказывает всегда
 * (проект без набора, папка набора, служебная папка `.git`, файл под образцом секрета).
 *
 * @param {string} root     корень проекта из записи реестра
 * @param {string} rel      относительный путь от клиента (пустая строка — сам корень)
 * @param {object} options  `mode` — `read` (по умолчанию) или `write`; `kind` — `file`
 *                          (по умолчанию) или `dir`; `size` — размер присланного содержимого;
 *                          `limit` — потолок размера;
 *                          `allowMissing` — режим чтения разрешает путь отсутствующего
 *                          файла (нужен стороне `HEAD` у удалённого файла); ОСТАЛЬНЫЕ
 *                          проверки при этом не отключаются ни одна.
 */
export async function resolveTarget(root, rel, options = {}) {
  const mode = options.mode === 'write' ? 'write' : 'read';
  const kind = options.kind === 'dir' ? 'dir' : 'file';
  const size = typeof options.size === 'number' ? options.size : null;
  const limit = typeof options.limit === 'number' ? options.limit : MAX_EDIT_FILE;
  const outside = mode === 'write' ? FAULT.WRITE_OUTSIDE_ROOT : FAULT.PATH_UNREACHABLE;

  // 1. Пригодность строк. Сетевой путь отбивается ДО любого обращения к диску.
  if (!sanePath(root) || isUncPath(root) || !path.isAbsolute(root)) {
    return { ok: false, code: FAULT.PATH_UNREACHABLE };
  }
  const relRaw = String(rel == null ? '' : rel);
  if (relRaw.length > MAX_REL_PATH) return { ok: false, code: outside };
  if (relRaw !== '' && (!sanePath(relRaw) || isUncPath(relRaw))) {
    return { ok: false, code: outside };
  }

  // 2. Корень — один раз и навсегда.
  const rootReal = await realPath(root);
  if (!rootReal.ok) return { ok: false, code: FAULT.PATH_UNREACHABLE };
  const canonRoot = rootReal.path;

  // 3. Набор: базы считаются всегда (признак «внутри набора» нужен и чтению), но отказ
  //    по их отсутствию принадлежит ТОЛЬКО режиму записи.
  const kit = await kitBases(canonRoot);

  /**
   * ЕДИНСТВЕННЫЙ ИСТОЧНИК УСЛОВИЙ ЗАПИСИ: и отказ режима записи, и признак `writable`
   * у режима чтения считаются ЭТОЙ функцией, а не двумя списками условий по соседству.
   *
   * Так было не всегда, и разница не косметическая: пока признак перечислял те же условия
   * ПАРАЛЛЕЛЬНО, две стороны совпадали лишь до первой правки одной из них — добавили проверку
   * в отказ, забыли в признак, и страница рисует активную кнопку сохранения там, где запись
   * отказывает всегда. Замечание ревью фазы 2; сведено при шаге 17 плана.
   *
   * Порядок внутри сохранён ровно тот, что требует шаг 3 плана: «запись в проект без набора»
   * идёт ДО остальных проверок записи и не зависит от того, куда указывает цель.
   *
   * Кандидатов может быть несколько (сама цель и разрешённый путь): проверяются ВСЕ — это
   * дешевле рассуждений о том, какой из них достаточен.
   *
   * СЕКРЕТЫ ЗАКРЫТЫ НА ЗАПИСЬ НАСОВСЕМ, И ПАРНОГО ПРИЗНАКУ `reveal` КЛЮЧА У ЗАПИСИ НЕТ.
   * Выбор здесь был из двух защитимых («нельзя никогда» и «можно по явному признаку»), и он
   * сделан осознанно — решение человека после ревью части C; молчаливого третьего варианта
   * (запись открыта, как было) больше нет. Три довода, по которым выбрано «никогда»:
   *
   *   1. ЧТЕНИЕ ОБРАТИМО, ЗАПИСЬ НЕТ. Показ секрета — умолчание, которое снимается явным
   *      признаком и оставляет след строкой в stdout; перезапись `.env` следом не лечится.
   *   2. ПРИЗНАК `writable` ОБЯЗАН ОСТАВАТЬСЯ ОДНОЗНАЧНЫМ. Он считается ЭТОЙ ЖЕ функцией
   *      и уезжает в дерево и читателю ДО всякого запроса на запись. Будь запись возможна
   *      «по признаку», признак пришлось бы считать `true` — и страница части D нарисовала бы
   *      активную кнопку сохранения на файле секретов, то есть ровно ту кнопку-обманку,
   *      против которой написано правило `no_kit`, только вывернутую наизнанку.
   *   3. ПУЛЬТ — ПАНЕЛЬ НАД НАБОРОМ, А НЕ ОБЩИЙ РЕДАКТОР МАШИНЫ. Набор закрыл эти файлы
   *      правилами `deny` на ОБА режима; демон заводит к ним вторую дорогу, и открывать
   *      по ней то, что закрыто по первой, незачем: `.env` правится обычным редактором.
   *
   * Проверка стоит ПОСЛЕ `.git` и набора намеренно: у пути `.claude/x.key` причина отказа —
   * граница набора, и коды двух уже отревьюенных ветвей от этой правки не изменились.
   */
  const writeRefusal = (...candidates) => {
    if (kit.absent) return FAULT.WRITE_NO_KIT;
    if (!kit.ok) return FAULT.PATH_UNREACHABLE;
    for (const p of candidates) {
      if (insideGitDir(canonRoot, p)) return FAULT.GIT_DIR_CLOSED;
      if (kit.bases.some((b) => inside(b, p))) return FAULT.WRITE_INTO_KIT;
      if (isSecretPath(p)) return FAULT.WRITE_INTO_SECRET;
    }
    return null;
  };

  if (mode === 'write') {
    // Без кандидатов — только ветвь набора: цель ещё не посчитана, а «проект без набора»
    // закрыт на запись независимо от неё.
    const refusal = writeRefusal();
    if (refusal) return { ok: false, code: refusal };
  }

  // 4. Вложенность в корень.
  const target = path.resolve(canonRoot, relRaw);
  if (!inside(canonRoot, target)) return { ok: false, code: outside };
  if (insideGitDir(canonRoot, target)) return { ok: false, code: FAULT.GIT_DIR_CLOSED };
  if (mode === 'write') {
    const refusal = writeRefusal(target);
    if (refusal) return { ok: false, code: refusal };
  }

  // 5. Родитель и ПОВТОРНАЯ проверка обеих вложенностей по вернувшемуся пути.
  let resolved = target;
  if (path.resolve(target) !== path.resolve(canonRoot)) {
    const parentReal = await realPath(path.dirname(target));
    if (!parentReal.ok) return { ok: false, code: parentReal.code };
    resolved = path.join(parentReal.path, path.basename(target));
    if (!inside(canonRoot, resolved)) return { ok: false, code: outside };
    // Повторяется и фильтр `.git`: симлинк-родитель, ведущий в служебную папку, лексической
    // проверкой не ловится — ровно та же причина, по которой здесь повторяется вложенность.
    if (insideGitDir(canonRoot, resolved)) return { ok: false, code: FAULT.GIT_DIR_CLOSED };
    if (mode === 'write') {
      const refusal = writeRefusal(resolved);
      if (refusal) return { ok: false, code: refusal };
    }
  }

  // 6. Вид цели. Зарезервированное имя устройства отбивается и тогда, когда файла ещё нет:
  //    `lstat` по `COM1` его не покажет, а открытие на запись уйдёт в последовательный порт.
  if (isDeviceName(resolved)) {
    return { ok: false, code: mode === 'write' ? FAULT.TARGET_NOT_PLAIN_FILE : FAULT.NOT_PLAIN_FILE };
  }
  const st = await statSafe(resolved);
  if (st.ok) {
    if (kind === 'dir') {
      // Симлинк на каталог здесь ДОПУСКАЕТСЯ и разворачивается: клон такие переносит,
      // и запрещать их значило бы ломать законные проекты. Решает не тип записи, а то,
      // куда она ведёт, — поэтому сразу за этим стоит `realpath` и повторная сверка.
      if (!st.stat.isDirectory() && !st.stat.isSymbolicLink()) {
        return { ok: false, code: FAULT.NOT_PLAIN_FILE };
      }
      const dirReal = await realPath(resolved);
      if (!dirReal.ok) return { ok: false, code: dirReal.code };
      resolved = dirReal.path;
      if (!inside(canonRoot, resolved)) return { ok: false, code: outside };
      if (insideGitDir(canonRoot, resolved)) return { ok: false, code: FAULT.GIT_DIR_CLOSED };
      if (mode === 'write') {
        const refusal = writeRefusal(resolved);
        if (refusal) return { ok: false, code: refusal };
      }
      const dirStat = await statSafe(resolved);
      if (!dirStat.ok || !dirStat.stat.isDirectory()) {
        return { ok: false, code: FAULT.NOT_PLAIN_FILE };
      }
    } else if (!isPlainFileStat(st.stat, resolved)) {
      return { ok: false, code: mode === 'write' ? FAULT.TARGET_NOT_PLAIN_FILE : FAULT.NOT_PLAIN_FILE };
    }
  } else if (st.code !== FAULT.PATH_UNREACHABLE) {
    return { ok: false, code: st.code };
  } else if (mode === 'read' && options.allowMissing !== true) {
    return { ok: false, code: FAULT.PATH_UNREACHABLE };
  }

  // Признак «внутри набора» считается ПОСЛЕ ветви каталога: там `resolved` меняется на
  // канонизированный, и посчитанный раньше признак относился бы к другому пути.
  const inKit = kit.bases.some((b) => inside(b, target) || inside(b, resolved));

  // ПРИЗНАК ЗАПИСИ СЧИТАЕТСЯ ТОЙ ЖЕ ФУНКЦИЕЙ, что и отказ режима записи, — не «теми же
  // условиями», а буквально ею. Иначе проект БЕЗ набора (`no_kit`) выглядит доступным
  // на запись у обоих читателей, страница рисует активную кнопку сохранения, которая
  // отказывает всегда, и первый же человек читает штатное состояние как поломку демона.
  const writable = writeRefusal(target, resolved) === null;

  // 7. Размер присланного содержимого.
  if (mode === 'write' && size !== null && size > limit) {
    return { ok: false, code: FAULT.FILE_TOO_BIG };
  }

  return {
    ok: true, path: resolved, root: canonRoot, inKit, writable, stat: st.ok ? st.stat : null, code: null,
  };
}

/**
 * Запись ОБЫЧНОГО ФАЙЛА ПРОЕКТА по уже разрешённому пути: временный файл в том же каталоге,
 * перенос режима с существующего файла на временный ДО переименования, затем переименование.
 *
 * Режим переносится потому, что новый файл иначе получает режим по умолчанию, и сохранение
 * из пульта тихо меняло бы права чужого файла.
 *
 * `writeSecureAtomic()` для файлов проекта НЕ переиспользуется: режим `0600` уместен реестру
 * пульта и неуместен файлу человека.
 *
 * Содержимое пишется байт в байт (`Buffer`), окончания строк не «чинятся».
 */
export async function writeProjectFile(file, data) {
  const dir = path.dirname(file);
  const st = await statSafe(file);
  const mode = st.ok && st.stat.isFile() ? (st.stat.mode & 0o777) : null;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, data);
    if (mode !== null) { try { await chmod(tmp, mode); } catch { /* Windows */ } }
    await rename(tmp, file);
    return { ok: true, code: null };
  } catch (e) {
    try { await rm(tmp, { force: true }); } catch { /* временный файл уже убран */ }
    return { ok: false, code: faultFromError(e) };
  }
}

/** Байты файла с потолком размера. Нужны раздаче статики: прямой `node:fs` вне этого модуля запрещён. */
export async function readBytesCapped(file, limit) {
  const st = await isPlainFile(file);
  if (!st.ok) return { ok: false, buf: null, code: st.code };
  if (st.stat.size > limit) return { ok: false, buf: null, code: FAULT.FILE_TOO_BIG };
  try {
    return { ok: true, buf: await readFile(file), code: null };
  } catch (e) {
    return { ok: false, buf: null, code: faultFromError(e) };
  }
}

// --- фаза 2: ЕДИНАЯ ДВЕРЬ К ПОДПРОЦЕССУ --------------------------------------
//
// Здесь и намеренно: этот модуль и так единственное место с прямым `node:fs`, а поиск
// исполняемого файла есть обращение к диску. Правило пишется ОДИН раз, чтобы следующий
// подпроцесс унаследовал его механически.
//
// Имя команды ищется ТОЛЬКО по `PATH`; рабочий каталог в поиске не участвует НИКОГДА.
// Причина: libuv на Windows разрешает имя без разделителя, просматривая каталог `cwd`
// РАНЬШЕ `PATH`, а `cwd` у нас — корень чужого проекта из реестра, то есть подложенный туда
// `git.exe` или `powershell.exe` выполнился бы вместо системного, и триггером стало бы
// простое открытие проекта в левой колонке.
//
// ОГОВОРКА, которую нельзя потерять: `NoDefaultCurrentDirectoryInExePath=1` прикрывает поиск,
// который делает САМ РЕБЁНОК (`cmd.exe` и внуки), а наш запуск libuv разрешает сам, беря
// `PATH` из переданного окружения и просматривая `cwd` первым, — этой переменной он
// не спрашивает. Единственная защита здесь — АБСОЛЮТНЫЙ ПУТЬ; следующий читатель, решив,
// что переменная прикрывает и нас, ослабит правило.

/** Кандидат обязан быть обычным файлом; на POSIX — ещё и исполняемым. Возвращается канонизированный путь. */
async function plainExecutable(candidate) {
  const rp = await realPath(candidate);
  if (!rp.ok) return null;
  const st = await statSafe(rp.path);
  if (!st.ok || !isPlainFileStat(st.stat, rp.path)) return null;
  if (process.platform !== 'win32' && !(st.stat.mode & 0o111)) return null;
  return rp.path;
}

/** Имена-кандидаты в одном каталоге `PATH`. На Windows расширение подбирается по `PATHEXT`. */
function execCandidates(dir, name, win, pathext) {
  if (!win) return [path.join(dir, name)];
  const exts = String(pathext).split(';').map((s) => s.trim()).filter(Boolean);
  const own = path.extname(name);
  if (own && exts.some((e) => e.toLowerCase() === own.toLowerCase())) return [path.join(dir, name)];
  return exts.map((e) => path.join(dir, name + e));
}

/**
 * Имя команды в абсолютный путь. Не разрешилось — `null`, и вызывающий обязан отдать код
 * «исполняемый файл не разрешён», а не пробовать имя.
 *
 * Элементы `PATH`, не являющиеся абсолютными путями, ПРОПУСКАЮТСЯ: пустой элемент
 * (`C:\a;;C:\b`) означает текущий каталог и на Windows, и в POSIX.
 */
export async function resolveExecutable(name, env = process.env) {
  const raw = String(name == null ? '' : name);
  if (!sanePath(raw) || isUncPath(raw)) return null;
  if (path.isAbsolute(raw)) return plainExecutable(raw);
  // Имя с разделителем разрешалось бы ОТ РАБОЧЕГО КАТАЛОГА — ровно та дыра, ради которой
  // эта функция написана.
  if (/[\\/]/.test(raw)) return null;

  const win = process.platform === 'win32';
  const pathVar = env.PATH || env.Path || env.path || '';
  const pathext = win ? (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD') : '';
  for (const dir of String(pathVar).split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || isUncPath(dir)) continue;
    for (const cand of execCandidates(dir, raw, win, pathext)) {
      const found = await plainExecutable(cand);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Квотирование НАШЕЙ сборки. Кавычки ставим сами, всегда: MSVCRT добавляет их только при
 * пробеле, и путь вида `C:\tools&calc\claude.cmd` уехал бы в `cmd` голым, где `&` разделяет
 * команды. Кавычка внутри пути на Windows невозможна — встретили, значит вход не наш,
 * и форма не собирается вовсе.
 */
function quoteForCmd(s) {
  const v = String(s);
  if (v.includes('"')) return null;
  return `"${v}"`;
}

/**
 * Форма запуска командного файла (`.cmd`, `.bat`) через `%ComSpec%`.
 *
 * ЧЕСТНАЯ ФОРМУЛИРОВКА, и упрощать её нельзя: `cmd /c` ВСЕГДА разбирает свою командную
 * строку по правилам оболочки, иначе командный файл не запустить в принципе, и массив
 * аргументов от этого не спасает — он лишь способ построить ту же строку. Верно не
 * «оболочке ничего не отдаётся», а: ОБОЛОЧКЕ ОТДАЁТСЯ СТРОКА, КОТОРУЮ МЫ СОБРАЛИ САМИ
 * ИЗ КОНСТАНТ ДЕМОНА И РАЗРЕШЁННОГО АБСОЛЮТНОГО ПУТИ, И НИ ОДНОГО КЛИЕНТСКОГО БАЙТА В НЕЙ НЕТ.
 * Разница не косметическая: из неверной формулировки следует, что квотирование лишнее.
 *
 * Ключи выбраны не наугад и не сокращаются: `/c` — выполнить и выйти; `/s` — ровно то правило
 * разбора, ради которого мы ставим внешнюю пару кавычек сами (`cmd` снимает её и остальное
 * берёт как есть); `/d` — не только пропуск скриптов автозапуска, но и глушение `AutoRun`
 * из реестра (ветка `Command Processor` в `HKLM` и `HKCU`), то есть чужой команды, которую
 * иначе выполнял бы КАЖДЫЙ наш запуск командного файла.
 *
 * Строка передаётся ДОСЛОВНО: у `node-pty` аргументы отдаются строкой (`argline`), у
 * `child_process` — массивом вместе с `windowsVerbatimArguments: true` (`verbatim`). Массив
 * без этого ключа не работает и работать не может: и libuv, и `node-pty` приводят каждый
 * элемент по правилам MSVCRT, и элемент с кавычками превращается в `"\"C:\...\claude.cmd\""` —
 * `cmd.exe` получает обратные слэши перед кавычками, командного файла не находит,
 * и сессия не поднимается.
 */
export function cmdForm(comspec, file, args = []) {
  const parts = [quoteForCmd(file), ...args.map((a) => quoteForCmd(a))];
  if (parts.some((p) => p === null)) return null;
  const line = `"${parts.join(' ')}"`;
  return {
    file: comspec,
    args: ['/d', '/s', '/c', line],
    argline: `/d /s /c ${line}`,
    verbatim: true,
    shellFile: true,
    // Путь до самого командного файла хранится ОТДЕЛЬНО, потому что в `file` лежит `cmd.exe`.
    // Без него форму нельзя пересобрать под другие аргументы, не разрешая имя заново, —
    // а именно это и делает `withArgs()`.
    target: String(file),
  };
}

/**
 * Та же форма запуска с ДРУГИМИ аргументами. Дверь зовётся один раз, дальше аргументы
 * подставляются в запомненную форму.
 *
 * Зачем отдельная функция. Потребитель, запомнивший из формы одно поле файла, на машине
 * с git-шимом `.cmd` запоминает `cmd.exe`: путь до git вместе с ключами `/d /s /c` пропадает,
 * следующий вызов разрешает уже `cmd.exe` и получает форму БЕЗ `/c`. Отказ при этом тихий —
 * дерево теряет все метки, вкладка диффов пуста, и от «каталог не репозиторий» это
 * не отличить (находка ревью фазы 2). Поэтому форма берётся ЦЕЛИКОМ и по частям
 * не пересобирается.
 *
 * ОГОВОРКА ПРО ПРОЦЕНТЫ, которую нельзя потерять. В ветви командного файла аргументы уезжают
 * в командную строку `cmd /c`. Кавычки, которые мы ставим сами, обезвреживают `&`, `^` и `|`,
 * но подстановку переменной окружения по процентам `cmd` делает и ВНУТРИ кавычек: аргумент
 * с `%имя%` приедет в командный файл подставленным значением. Исполнения это не даёт,
 * подстановку значения — даёт. Единственный аргумент, куда попадает производная
 * от клиентского пути, — `HEAD:<путь>` в `fileSides()` (`pult/lib/git.mjs`); там это значит
 * «git не найдёт такой объект», то есть закрытый отказ, а не открытие.
 */
export function withArgs(form, args = []) {
  if (!form) return null;
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (form.shellFile === true) return cmdForm(form.file, form.target, list);
  return { ...form, args: list };
}

/** `%ComSpec%`: абсолютность и обычность проверяются; не прошло — `cmd.exe` ищется по `PATH`. */
async function resolveComSpec(env) {
  const raw = env.ComSpec || env.COMSPEC || env.comspec || '';
  if (raw && path.isAbsolute(raw) && !isUncPath(raw)) {
    const ok = await plainExecutable(raw);
    if (ok) return ok;
  }
  return resolveExecutable('cmd.exe', env);
}

/**
 * ЕДИНАЯ ДВЕРЬ: имя команды в ФОРМУ ЗАПУСКА. Потребители берут форму ЦЕЛИКОМ и не пересобирают
 * её по частям.
 *
 * Обычный исполняемый файл — простая форма: абсолютный путь плюс массив аргументов,
 * `shell: false`. Командный файл — форма `cmdForm()`: `CreateProcess`, а значит и conpty
 * внутри `node-pty`, командный файл напрямую не запускает.
 *
 * ГОТОВЫЙ ОТВЕТ НА «СЕССИЯ НЕ ПОДНИМАЕТСЯ». Лечений четыре, правильное одно:
 *   1. ВЕРНО — передать командную строку дословно (`verbatim` / `argline`) и кавычки
 *      поставить самим (это и делает `cmdForm()`);
 *   2. ЗАПРЕЩЕНО — `shell: true`: возвращает разбор всей строки оболочкой, и дверь перестаёт
 *      быть дверью;
 *   3. ЗАПРЕЩЕНО — снять кавычки: путь уедет голым, и метасимвол в имени каталога
 *      (`&`, `^`, `|`) станет разделителем команд;
 *   4. ЗАПРЕЩЕНО — `cmd /c claude` ПО ИМЕНИ: прямой возврат дыры с подменой через рабочий
 *      каталог, случай не гипотетический — на Windows `claude` это `claude.cmd`, шим npm.
 */
export async function resolveCommand(name, options = {}) {
  const env = options.env || process.env;
  const args = Array.isArray(options.args) ? options.args.map((a) => String(a)) : [];
  const abs = await resolveExecutable(name, env);
  if (!abs) return null;
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = await resolveComSpec(env);
    if (!comspec) return null;
    return cmdForm(comspec, abs, args);
  }
  return { file: abs, args, argline: null, verbatim: false, shellFile: false };
}

// --- фаза 2: ДВА ОКРУЖЕНИЯ ПОДПРОЦЕССА ---------------------------------------
//
// Функции две, а не одна, и слить их обратно нельзя: у служебного git и у живой сессии
// требования противоположные. Общая функция ломает терминал (`git commit` падает
// «Author identity unknown», `git push` — молча), а лечат такую поломку наследованием
// окружения целиком, то есть возвратом `CCKIT_GATE` в каждую сессию пульта.

/**
 * СЛУЖЕБНОЕ окружение git: строится ЯВНО из белого списка и ужесточает git.
 * `process.env` не мутируется — значит одно окружение не протекает в другое.
 */
export function gitEnv(base = process.env) {
  const env = {};
  for (const name of GIT_ENV_ALLOW) {
    const v = base[name];
    if (typeof v === 'string' && v.length) env[name] = v;
  }
  for (const [k, v] of Object.entries(GIT_ENV_ADD)) env[k] = v;
  return env;
}

/**
 * СЕССИОННОЕ окружение терминала: НАСЛЕДУЕТ окружение демона минус закрытый список.
 *
 * `CCKIT_*` из списка вычищаемых не уходит НИКОГДА: демон, запущенный человеком из терминала
 * с выставленной `CCKIT_GATE=off` (штатный ремонтный приём, описан в `CUSTOMIZE.md`), иначе
 * раздал бы её всем сессиям пульта, и каждая завершала бы ход без машинной приёмки —
 * `decide()` в `.claude/hooks/gate.mjs` читает эту переменную первой строкой. Правило 3
 * раздела OVERVIEW контракта говорит обратное: пульт не снимает остановку «СТОП».
 *
 * Сверка имён идёт БЕЗ УЧЁТА РЕГИСТРА: на Windows имена переменных регистронезависимы,
 * и `cckit_gate` иначе проскочил бы мимо списка.
 */
export function sessionEnv(base = process.env) {
  const drop = new Set(SESSION_ENV_DROP.map((n) => n.toUpperCase()));
  const prefixes = SESSION_ENV_DROP_PREFIX.map((p) => p.toUpperCase());
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue;
    const up = k.toUpperCase();
    if (drop.has(up)) continue;
    if (prefixes.some((p) => up.startsWith(p))) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(SESSION_ENV_ADD)) env[k] = v;
  return env;
}


// --- самопроверка ------------------------------------------------------------

/**
 * Каталожная ссылка для самопроверки: сначала символическая, при отказе — точка соединения.
 * На обычной Windows символическая ссылка требует привилегии, а junction нет, и для наших
 * проверок она равноценна: `lstat` видит репарс-пойнт, `realpath` его разворачивает.
 */
async function dirLink(target, link) {
  try {
    await symlink(target, link, 'dir');
  } catch {
    await symlink(target, link, 'junction');
  }
}

/**
 * Сколько случаев обязан ПОКАЗАТЬ полный прогон. Сумма показанных и пропущенных сверяется
 * с этим числом, и расхождение даёт код 1.
 *
 * Зачем сверка вообще. Раньше самотест печатал строки, считал успехи и ВСЕГДА возвращал 0:
 * регрессия в случае 8 («запись в набор») дала бы «отказов показано: 15» вместо 16 и зелёный
 * код возврата — заметить это мог только человек, вчитавшийся в число. Единственная машинная
 * проверка шлюза записи обязана уметь провалиться, иначе она не проверка.
 *
 * ПРОПУСК ОСТАЁТСЯ ПРОПУСКОМ, а не считается успехом: он идёт своим счётчиком и в сумме
 * закрывает место случая, но зелёным его не делает. Там, где нет привилегии создания ссылок,
 * прогон честно говорит, что отсева симлинков он не доказал.
 */
const SELFTEST_CASES = 21;

async function selftest() {
  const out = (s) => process.stdout.write(`${s}\n`);
  const base = await mkdtemp(path.join(os.tmpdir(), 'pult-fs-safe-'));
  const bare = await mkdtemp(path.join(os.tmpdir(), 'pult-fs-bare-'));
  const oldCwd = process.cwd();
  let shown = 0;
  let skipped = 0;
  const missed = [];
  /** Показать строку случая и засчитать его. Не сошлось — пометка расхождения, как в `origin.mjs`. */
  const hit = (n, ok, line) => {
    if (ok) shown += 1;
    else missed.push(n);
    out(`${line}${ok ? '' : '  <-- РАСХОЖДЕНИЕ'}`);
  };
  /** Случай не выполнялся. Пропуск занимает место случая, но успехом не становится. */
  const skip = (line) => {
    skipped += 1;
    out(line);
  };
  try {
    // 1. выход за базовый каталог
    const outside = path.join(base, '..', 'evil.txt');
    hit(1, inside(base, outside) === false,
      `1.  выход за базовый каталог      : inside() = ${inside(base, outside)} (ожидание false)`);

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
      hit(2, r.code === FAULT.NOT_PLAIN_FILE,
        `2.  симлинк                       : ok=${r.ok} code=${r.code} (ожидание ${FAULT.NOT_PLAIN_FILE})`);
    } else {
      skip('2.  симлинк                       : случай пропущен: нет привилегии');
    }

    // 3. файл сверх потолка
    const big = path.join(base, 'big.txt');
    await writeFile(big, 'x'.repeat(4096), 'utf8');
    const rBig = await readTextCapped(big, 100);
    hit(3, rBig.code === FAULT.FILE_TOO_BIG,
      `3.  файл сверх потолка            : ok=${rBig.ok} code=${rBig.code} (ожидание ${FAULT.FILE_TOO_BIG})`);

    // 4. не обычный файл: каталог и зарезервированное имя устройства
    const rDir = await readTextCapped(base, 1024);
    const deviceLike = isDeviceName('hooks/COM1') && isDeviceName('CON.') && isDeviceName('LPT9.txt');
    hit(4, rDir.code === FAULT.NOT_PLAIN_FILE && deviceLike,
      `4.  не обычный файл               : каталог code=${rDir.code}, имя устройства опознано=${deviceLike}`);

    // 5. исчерпанный бюджет
    const budget = makeBudget({ files: 1 });
    budget.take(10);
    const code = budget.take(10);
    hit(5, code === FAULT.BUDGET_EXHAUSTED,
      `5.  исчерпанный бюджет            : code=${code} (ожидание ${FAULT.BUDGET_EXHAUSTED})`);

    // 6. нераспознанное время
    const bad = timeField('вчера вечером', 'local-naive');
    const good = timeField('2026-08-31 16:13', 'local-naive');
    hit(6, bad === null && good !== null && good.value === '2026-08-31 16:13',
      `6.  нераспознанное время          : мусор -> ${JSON.stringify(bad)}, годное -> ${JSON.stringify(good)}`);

    // --- фаза 2: шлюз пути ---------------------------------------------------
    //
    // Стенд с набором: папка `.claude` и пара файлов в ней. Второй стенд (`bare`) заведён
    // БЕЗ набора намеренно — на стенде с набором ветвь `no_kit` не меряется вовсе.
    await mkdir(path.join(base, '.claude'), { recursive: true });
    await writeFile(path.join(base, '.claude', 'VERSION'), '1.0.0\n', 'utf8');
    await writeFile(path.join(bare, 'a.txt'), 'проект без набора', 'utf8');

    // 7. запись мимо корня проекта
    const r7 = await resolveTarget(base, '../evil.txt', { mode: 'write' });
    hit(7, r7.code === FAULT.WRITE_OUTSIDE_ROOT,
      `7.  запись мимо корня             : code=${r7.code} (ожидание ${FAULT.WRITE_OUTSIDE_ROOT})`);

    // 8. запись в набор
    const r8 = await resolveTarget(base, '.claude/VERSION', { mode: 'write' });
    hit(8, r8.code === FAULT.WRITE_INTO_KIT,
      `8.  запись в набор                : code=${r8.code} (ожидание ${FAULT.WRITE_INTO_KIT})`);

    // 9. симлинк-ЦЕЛЬ: `lstat` до открытия
    if (linked) {
      const r9 = await resolveTarget(base, 'link.txt', { mode: 'write' });
      hit(9, r9.code === FAULT.TARGET_NOT_PLAIN_FILE,
        `9.  симлинк-цель                  : code=${r9.code} (ожидание ${FAULT.TARGET_NOT_PLAIN_FILE})`);
    } else {
      skip('9.  симлинк-цель                  : случай пропущен: нет привилегии');
    }

    // 10. симлинк-РОДИТЕЛЬ: проверкой самой цели не ловится
    let parentLinked = false;
    const away = await mkdtemp(path.join(os.tmpdir(), 'pult-fs-away-'));
    try {
      // Точка соединения (junction) на Windows создаётся БЕЗ привилегии, а репарс-пойнтом
      // является таким же: клон переносит именно её.
      await dirLink(away, path.join(base, 'sub'));
      parentLinked = true;
    } catch { /* нет привилегии */ }
    if (parentLinked) {
      const r10 = await resolveTarget(base, 'sub/f.txt', { mode: 'write' });
      hit(10, r10.code === FAULT.WRITE_OUTSIDE_ROOT,
        `10. симлинк-родитель              : code=${r10.code} (ожидание ${FAULT.WRITE_OUTSIDE_ROOT})`);
    } else {
      skip('10. симлинк-родитель              : случай пропущен: нет привилегии');
    }

    // 11. база проверки «не в наборе» берётся от КАНОНИЗИРОВАННОГО корня: проект,
    //     до которого дошли по симлинку, всё равно закрыт на запись внутрь набора
    let rootLinked = false;
    const rootLink = path.join(away, 'root-link');
    try {
      await dirLink(base, rootLink);
      rootLinked = true;
    } catch { /* нет привилегии */ }
    if (rootLinked) {
      const r11 = await resolveTarget(rootLink, '.claude/VERSION', { mode: 'write' });
      hit(11, r11.code === FAULT.WRITE_INTO_KIT,
        `11. база от канонизированного корня: code=${r11.code} (ожидание ${FAULT.WRITE_INTO_KIT})`);
    } else {
      skip('11. база от канонизированного корня: случай пропущен: нет привилегии');
    }

    // 12. проект БЕЗ набора закрыт на запись целиком
    const r12 = await resolveTarget(bare, 'a.txt', { mode: 'write' });
    const r12read = await resolveTarget(bare, 'a.txt', { mode: 'read' });
    hit(12, r12.code === FAULT.WRITE_NO_KIT && r12read.ok === true,
      `12. запись в проект без набора    : code=${r12.code} (ожидание ${FAULT.WRITE_NO_KIT}), чтение ok=${r12read.ok}`);

    // --- фаза 2: дверь к подпроцессу -----------------------------------------
    const win = process.platform === 'win32';
    const cwdStand = path.join(base, 'cwd-stand');
    const emptyDir = path.join(base, 'empty-path');
    await mkdir(cwdStand, { recursive: true });
    await mkdir(emptyDir, { recursive: true });
    const probeName = win ? 'pultprobe.cmd' : 'pultprobe';
    const probeFile = path.join(cwdStand, probeName);
    await writeFile(probeFile, win ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
    try { await chmod(probeFile, 0o755); } catch { /* Windows */ }
    const probeEnv = (p) => ({ PATH: p, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

    process.chdir(cwdStand);
    const fromCwd = await resolveExecutable('pultprobe', probeEnv(emptyDir));
    const fromPath = await resolveExecutable('pultprobe', probeEnv(cwdStand));
    const fromRel = await resolveExecutable('pultprobe', probeEnv(`.${path.delimiter}cwd-stand`));
    process.chdir(oldCwd);

    // 13. рабочий каталог в поиске не участвует
    hit(13, fromCwd === null && Boolean(fromPath),
      `13. команда не из рабочего каталога: из cwd -> ${fromCwd === null ? 'null' : 'НАЙДЕНО'}, из PATH -> ${fromPath ? 'найдено' : 'null'}`);

    // 14. неабсолютный элемент PATH пропускается
    hit(14, fromRel === null,
      `14. неабсолютный элемент PATH     : ${fromRel === null ? 'пропущен' : 'ВЗЯТ'} (ожидание «пропущен»)`);

    // 15. форма запуска командного файла
    const comspec = win ? 'C:\\Windows\\System32\\cmd.exe' : '/c/Windows/System32/cmd.exe';
    const form = cmdForm(comspec, 'C:\\Program Files\\claude.cmd', []);
    const keysOk = form && form.file === comspec && form.args.slice(0, 3).join(' ') === '/d /s /c'
      && form.verbatim === true && form.argline === `/d /s /c ${form.args[3]}`;
    hit(15, keysOk,
      `15. командный файл через ComSpec  : ключи=${form ? form.args.slice(0, 3).join(' ') : '—'}, дословно=${form ? form.verbatim : '—'}, строка=${form ? form.args[3] : '—'}`);

    // 16. кавычки ставим МЫ — и вокруг пробела, и вокруг `&`
    const amp = cmdForm(comspec, 'C:\\tools&calc\\claude.cmd', []);
    const quoted = form && form.args[3] === '""C:\\Program Files\\claude.cmd""'
      && amp && amp.args[3] === '""C:\\tools&calc\\claude.cmd""';
    hit(16, quoted,
      `16. квотирование пути             : пробел -> ${form ? form.args[3] : '—'}, амперсанд -> ${amp ? amp.args[3] : '—'}`);

    // --- фаза 2: два окружения -----------------------------------------------

    // 17. служебное окружение
    const g = gitEnv({ CCKIT_GATE: 'off', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'секрет', HOME: '/home/u' });
    const gOk = g.CCKIT_GATE === undefined && g.ANTHROPIC_API_KEY === undefined
      && typeof g.GIT_CONFIG_GLOBAL === 'string' && g.GIT_CONFIG_GLOBAL.length > 0
      && g.GIT_TERMINAL_PROMPT === '0';
    hit(17, gOk,
      `17. служебное окружение           : CCKIT_GATE=${String(g.CCKIT_GATE)}, GIT_CONFIG_GLOBAL=${JSON.stringify(g.GIT_CONFIG_GLOBAL)}, имён=${Object.keys(g).length}`);

    // 18. сессионное окружение
    const s = sessionEnv({
      CCKIT_GATE: 'off', cckit_gate: 'off', NODE_OPTIONS: '--require /tmp/x.js',
      PATH: '/usr/bin', PSModulePath: '/mod', GIT_DIR: '/g',
    });
    const sOk = s.CCKIT_GATE === undefined && s.cckit_gate === undefined && s.NODE_OPTIONS === undefined
      && s.GIT_DIR === undefined && s.PATH === '/usr/bin' && s.PSModulePath === '/mod'
      && s.NoDefaultCurrentDirectoryInExePath === '1';
    hit(18, sOk,
      `18. сессионное окружение          : CCKIT_GATE=${String(s.CCKIT_GATE)}, NODE_OPTIONS=${String(s.NODE_OPTIONS)}, PATH=${String(s.PATH)}, PSModulePath=${String(s.PSModulePath)}`);

    // --- фаза 2, круг доработки: закрытая `.git` и признак записи -------------

    // 19. служебная папка `.git` закрыта в ШЛЮЗЕ — на чтение, на запись и НА ЛЮБОМ УРОВНЕ.
    //     Сокрытие имени в дереве доступом не управляет: читатель файла зовётся по пути,
    //     а в `.git/config` лежат учётные данные.
    await mkdir(path.join(base, '.git'), { recursive: true });
    await writeFile(path.join(base, '.git', 'config'), '[remote "origin"]\n', 'utf8');
    await mkdir(path.join(base, 'sub-repo', '.git'), { recursive: true });
    await writeFile(path.join(base, 'sub-repo', '.git', 'config'), '[remote "origin"]\n', 'utf8');
    const gRead = await resolveTarget(base, '.git/config', { mode: 'read' });
    const gWrite = await resolveTarget(base, '.git/config', { mode: 'write' });
    const gNested = await resolveTarget(base, 'sub-repo/.git/config', { mode: 'read' });
    hit(19, gRead.code === FAULT.GIT_DIR_CLOSED && gWrite.code === FAULT.GIT_DIR_CLOSED
      && gNested.code === FAULT.GIT_DIR_CLOSED,
    `19. папка .git закрыта в шлюзе    : чтение=${gRead.code}, запись=${gWrite.code}, вложенный репозиторий=${gNested.code}`);

    // 20. ПРИЗНАК ЗАПИСИ считается от исхода режима записи, а не от одного «внутри набора»:
    //     у проекта без набора он ложный везде, иначе страница рисует активную кнопку
    //     сохранения, которая отказывает всегда.
    const wBare = await resolveTarget(bare, 'a.txt', { mode: 'read' });
    const wKit = await resolveTarget(base, '.claude/VERSION', { mode: 'read' });
    const wPlain = await resolveTarget(base, 'target.txt', { mode: 'read' });
    hit(20, wBare.writable === false && wKit.writable === false && wPlain.writable === true,
      `20. признак записи у читателей    : без набора=${wBare.writable}, в наборе=${wKit.writable}, обычный файл=${wPlain.writable} (ожидание false/false/true)`);

    // 21. ФАЙЛ ПОД ОБРАЗЦОМ СЕКРЕТА: чтение остаётся возможным (умолчание закрывает его
    //     этажом выше, у читателя), запись отбита СВОИМ кодом, а признак записи ложный —
    //     иначе страница рисует активную кнопку сохранения на файле секретов.
    await writeFile(path.join(base, '.env'), 'TOKEN=строка-пустышка\n', 'utf8');
    const sWrite = await resolveTarget(base, '.env', { mode: 'write' });
    const sRead = await resolveTarget(base, '.env', { mode: 'read' });
    const sNested = await resolveTarget(base, 'sub-repo/keys.pem', { mode: 'write' });
    hit(21, sWrite.code === FAULT.WRITE_INTO_SECRET && sRead.ok === true
      && sRead.writable === false && sNested.code === FAULT.WRITE_INTO_SECRET,
    `21. запись в файл-секрет          : .env=${sWrite.code} (ожидание ${FAULT.WRITE_INTO_SECRET}), вложенный .pem=${sNested.code}, чтение ok=${sRead.ok}, writable=${sRead.writable}`);

    await rm(away, { recursive: true, force: true });
  } finally {
    try { process.chdir(oldCwd); } catch { /* каталог уже убран */ }
    await rm(base, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
  out('');
  out(`отказов показано: ${shown}${skipped ? `, пропусков: ${skipped}` : ''}, случаев всего: ${SELFTEST_CASES}`);
  if (skipped) {
    out('пропуск — не отказ: зелёный самотест на платформе без привилегии создания ссылок');
    out('доказательством отсева симлинков не является.');
  }
  if (missed.length) out(`РАСХОЖДЕНИЕ в случаях: ${missed.join(', ')}`);
  // Считаются ВСЕ отработавшие случаи, включая несовпавшие: иначе одно расхождение
  // докладывалось бы дважды — и как расхождение, и как «случай пропал».
  const seen = shown + skipped + missed.length;
  if (seen !== SELFTEST_CASES) {
    out(`случаев отработало ${seen}, ожидалось ${SELFTEST_CASES}: случай пропал из прогона`);
  }
  out('временные каталоги удалены');
  // Код 1 — и на расхождении, и на пропавшем случае. Самотест, который не умеет провалиться,
  // проверкой не является: до этой правки здесь стоял безусловный `return 0`.
  return missed.length === 0 && seen === SELFTEST_CASES ? 0 : 1;
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
