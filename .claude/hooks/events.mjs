#!/usr/bin/env node
/**
 * Журнал событий проекта (Claude Agent Kit): одна строка JSON на событие в
 * `.claude/artifacts/events.jsonl`. Файл ТОЛЬКО дописывается и никогда не перезаписывается —
 * из него потом собираются статистика, ретроспектива и дашборд. Кроссплатформенно,
 * БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 *   node .claude/hooks/events.mjs --emit <событие> [--task <id>] [--set ключ=значение ...]
 *   node .claude/hooks/events.mjs --selftest      путь, размер и последние строки журнала
 *
 * Пишут сюда не люди, а хуки: `task.mjs` (задача заведена, сменился статус, задача закрыта)
 * и `gate.mjs` (вердикт машинной приёмки). Оба зовут этот файл ОТДЕЛЬНЫМ процессом и глотают
 * любую ошибку: сбой журнала не имеет права помешать ни смене статуса, ни вердикту приёмки.
 * Поэтому и здесь любая ошибка записи — молчание и код 0.
 *
 * Формат строки — четыре ключа всегда и в этом порядке:
 * `{"ts":…,"task_id":…,"event":…,"payload":{…}}`. `ts` в UTC (ISO-8601 с миллисекундами):
 * без смещения строки нельзя сравнить между машинами, а без секунд два события одной минуты
 * неразличимы по порядку. `task_id` может быть пустым (гейт взводят и без задачи),
 * `payload` — пустым объектом.
 *
 * Две обязанности читателя. Первая: НЕЧИТАЕМУЮ строку пропускать, а не падать на ней — лока
 * здесь нет, и две параллельные сессии теоретически способны наложить запись. Вторая: считать
 * значения полей чужим текстом и экранировать их при выводе — очистка убирает управляющие
 * символы, но `<`, `>` и `&` не трогает.
 *
 * Журнал — рубеж ВИДИМОСТИ, а не доказательство. Правила `deny` в `settings.json` закрывают
 * прямую правку файла через `Write`/`Edit`, но не `Bash`, а сам `--emit` — санкционированный
 * способ дописать строку, байт в байт неотличимую от настоящей. Поэтому записи журнала
 * сверяют со `STATE.md` задачи и с `VERIFY.json`, а не заменяют их ими.
 */

import { appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = path.dirname(KIT_DIR);
const FILE = path.join(KIT_DIR, 'artifacts', 'events.jsonl');
const TAG = '[events]';

// Белый список событий. Имя события — ключ, по которому журнал потом группируют, и вольное
// имя из чужого текста сделало бы группировку невозможной: одна опечатка — и целая ветка
// истории выпадает из подсчёта молча. Новое событие добавляется сюда осознанно, вместе с тем,
// кто его пишет.
const EVENTS = new Set(['task_opened', 'status_changed', 'gate_result', 'task_closed']);

// Форма идентификатора задачи — та же, что в task.mjs и gate.mjs. Не подошла — пишем пустой
// `task_id`: «чинить» чужую строку хук не берётся, а пустое значение здесь законно.
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const ID_MAX = 80;

const KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
const NUM_RE = /^-?\d{1,9}$/;
const MAX_KEYS = 8;
const VALUE_MAX = 200;

// Диагностика не имеет права дорожать вместе с файлом: ротации у журнала нет, он растёт
// линейно, поэтому `--selftest` читает хвост, а не файл целиком.
const TAIL_BYTES = 64 * 1024;
const SHOW_LINES = 3;

// --- точка входа ------------------------------------------------------------

// Командная строка строго именованная: свободного текста хук не принимает нигде, всё
// непонятое молча пропускается.
const argv = process.argv.slice(2);

try {
  if (argv.includes('--selftest')) selftest();
  else if (argv.includes('--emit')) emit(argv);
  else usage();
} catch {
  // Журнал не повод ронять звавшего — см. шапку файла.
  process.exit(0);
}

// --- запись -----------------------------------------------------------------

/** Дописать одну строку. Событие не из белого списка — отказ и код 3, БЕЗ записи. */
function emit(list) {
  const opts = parseArgs(list);
  if (!EVENTS.has(opts.event)) {
    err(`не знаю событие «${clean(opts.event)}»`);
    err(`допустимые: ${[...EVENTS].join(', ')}`);
    process.exit(3);
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    task_id: opts.task,
    event: opts.event,
    payload: opts.payload,
  });

  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    // Дописывание, а не перезапись: файл — накопленная история проекта, восстановить её
    // нечем. `mode` действует только при создании (как у GATE_STATE.json) и на Windows
    // игнорируется — но там, где права работают, журнал остаётся приватным.
    appendFileSync(FILE, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Молчание намеренно: диагностика журнала живёт в `--selftest`, а не в выводе той
    // команды, которая его позвала.
  }
  process.exit(0);
}

/**
 * Разбор именованных аргументов. Всё, что приезжает снаружи, — чужой текст: значения чистятся
 * ПОВТОРНО, даже если звавший уже чистил (а он чистит: task.mjs и gate.mjs делают это до
 * `args.push`, чтобы не споткнуться о границу процессов). Две линии здесь намеренны — до хука
 * доезжают имена упавших проверок из блока CCKIT:VERIFY, который профиль §2 сам называет
 * чужим текстом.
 */
function parseArgs(list) {
  let event = '';
  let task = '';
  const payload = {};

  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--emit') {
      event = at(list, i + 1);
      i += 1;
    } else if (a === '--task') {
      const raw = at(list, i + 1);
      task = (raw.length <= ID_MAX && ID_RE.test(raw)) ? raw : '';
      i += 1;
    } else if (a === '--set') {
      addPair(payload, at(list, i + 1));
      i += 1;
    }
  }

  return { event, task, payload };
}

/** Одна пара `ключ=значение`. Ключ обязан пройти KEY_RE, значение — очистку; иначе пары нет. */
function addPair(payload, raw) {
  const eq = raw.indexOf('=');            // режем по ПЕРВОМУ `=`: внутри значения он законен
  if (eq <= 0) return;
  const key = raw.slice(0, eq);
  if (!KEY_RE.test(key)) return;
  if (Object.keys(payload).length >= MAX_KEYS && !(key in payload)) return;
  const value = clean(raw.slice(eq + 1));
  if (!value) return;                     // пустое значение — не факт, а шум
  // Числа остаются числами: иначе потребителю пришлось бы гадать, где `"3"`, а где 3.
  payload[key] = NUM_RE.test(value) ? Number(value) : value;
}

// --- диагностика ------------------------------------------------------------

/** Что в журнале сейчас. Всегда код 0: это справка, а не проверка. */
function selftest() {
  say(`журнал: ${rel(FILE)}`);

  let size = 0;
  try {
    size = statSync(FILE).size;
  } catch {
    say('журнала ещё нет — он появится при первом событии');
    process.exit(0);
  }

  const start = Math.max(0, size - TAIL_BYTES);
  let text = '';
  let fd = null;
  try {
    fd = openSync(FILE, 'r');
    const buf = Buffer.alloc(size - start);
    const got = readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8', 0, got);
  } catch (e) {
    say(`не смог прочитать журнал: ${clean(e && e.message)}`);
    process.exit(0);
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* уже закрыт — и хорошо */ } }
  }

  let lines = text.split('\n').filter((l) => l !== '');
  // Хвост начинается с обрывка строки, и на той же границе мог быть разрезан многобайтный
  // символ UTF-8. Первый кусок отбрасываем, а счётчик печатаем честно: врать про размер
  // истории нельзя.
  const partial = start > 0;
  if (partial && lines.length) lines = lines.slice(1);

  const count = partial
    ? `≥ ${lines.length} (прочитан хвост ${Math.round(TAIL_BYTES / 1024)} КБ)`
    : String(lines.length);
  say(`размер: ${size} Б · строк: ${count}`);

  const tail = lines.slice(-SHOW_LINES);
  if (!tail.length) {
    say('записей пока нет');
    process.exit(0);
  }

  say(`последние ${tail.length}:`);
  let broken = 0;
  for (const raw of tail) {
    // Порядок обратный интуиции: разбираем СЫРУЮ строку, печатаем очищенную. `clean` ломает
    // JSON (схлопывает пробелы и режет длину), поэтому чистить до разбора нельзя. А печатать
    // без очистки нельзя тем более: содержимое журнала — недоверенный вход, в нём бывают
    // ANSI-escape и управляющие символы, а вывод идёт в терминал человека и в контекст агента.
    let ok = true;
    try { JSON.parse(raw); } catch { ok = false; broken += 1; }
    out(`  ${ok ? '·' : '⚠'} ${show(raw)}`);
  }
  if (broken) say('нечитаемую строку читатель пропускает — лока у журнала нет, см. шапку файла');
  process.exit(0);
}

function usage() {
  err('журнал событий проекта — только дописывание');
  err('  node .claude/hooks/events.mjs --emit <событие> [--task <id>] [--set ключ=значение ...]');
  err(`  события: ${[...EVENTS].join(', ')}`);
  err('  node .claude/hooks/events.mjs --selftest');
  process.exit(3);
}

// --- вспомогательное --------------------------------------------------------

/** Значение аргумента по позиции. Нет его — пустая строка, а не `undefined`. */
function at(list, i) {
  const v = list[i];
  return String(v == null ? '' : v);
}

/**
 * Единственная очистка в файле — и для значений, и для печати. Управляющие символы (в том
 * числе нулевой байт, переводы строк и ANSI-escape) заменяются пробелом, пробелы схлопываются,
 * длина режется по VALUE_MAX. Чистим повторно, даже если звавший уже чистил: доверие к чужой
 * очистке — это отсутствие очистки.
 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VALUE_MAX);
}

/** Строка журнала для печати: тот же `clean` плюс честная отметка обрезки. */
function show(s) {
  const text = clean(s);
  return text.length === VALUE_MAX ? `${text} …` : text;
}

function rel(p) {
  const r = path.relative(PROJECT_ROOT, p);
  return (!r || r.startsWith('..')) ? p : r.split(path.sep).join('/');
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

function say(line) {
  console.log(`${TAG} ${line}`);
}

function err(line) {
  process.stderr.write(`${TAG} ${line}\n`);
}
