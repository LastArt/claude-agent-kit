#!/usr/bin/env node
/**
 * Перенос старой памяти проекта в задачи с идентификаторами (Claude Agent Kit).
 *
 *   node .claude/hooks/migrate-tasks.mjs           предпросмотр: что перенеслось бы (по умолчанию)
 *   node .claude/hooks/migrate-tasks.mjs --apply   выполнить перенос
 *
 * До версии 1.10 всё про задачу лежало в единственных на проект `artifacts/PLAN.md`,
 * `SECURITY.md` и `REVIEW.md`, а завершённое уносил `archive-task.mjs` в
 * `artifacts/history/<дата>-<имя>.md`. С 1.10 у каждой задачи своя папка
 * `.claude/tasks/<ГГГГ-ММ-ДД-имя>/`. Этот хук раскладывает старое по новым папкам — один раз,
 * при обновлении уже развёрнутой копии (его показывает и запускает `/cckit_update`).
 *
 * Кроссплатформенно, БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 * Четыре правила, на которых он держится:
 *
 *   • **Копирует и никогда не удаляет.** `.claude/artifacts/` в проектах выведен из-под git,
 *     отката нет, история невосстановима. Оригиналы остаются на месте всегда, а указатель
 *     `tasks/ACTIVE` хук не трогает вовсе: какая задача активна — решает человек.
 *   • **`STATE.md` пишется последним.** Он и есть признак завершённости переноса: папка без
 *     него — оборванный прогон, он повторяется вслух при следующем `--apply`. Временных
 *     `.migrate-*.tmp` хук не создаёт вовсе — обрыв оставил бы осиротевший каталог СО
 *     `STATE.md` внутри, и все читатели `tasks/` увидели бы его как вторую копию задачи.
 *   • **Чужой markdown — недоверенный вход.** Заголовок и дата приезжают из файла, который
 *     мог прийти клоном чужого репозитория. Дата берётся строгим `(\d{4}-\d{2}-\d{2})` из
 *     ПЕРВОЙ строки `**Дата:**`, имя собирает та же `slug()`, что и в `task.mjs`,
 *     а идентификатор становится путём только через `taskDir()`. Не разобралось — источник
 *     пропускается строкой «не разобрал, оставляю как есть», а не «чинится».
 *   • **Каждый источник — в своём try/catch.** Сбой одного даёт строку и переход к следующему,
 *     а не остановку посреди работы: половина перенесённой памяти хуже, чем понятный отказ.
 *
 * `--apply` намеренно НЕ значится в `permissions.allow`: у операции нет отката, и каждый
 * запуск обязан спрашивать человека.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = path.dirname(KIT_DIR);
const TASKS = path.join(KIT_DIR, 'tasks');
const ARTIFACTS = path.join(KIT_DIR, 'artifacts');
const HISTORY = path.join(ARTIFACTS, 'history');
const STUBS = path.join(KIT_DIR, 'assets', 'stubs');
const TAG = '[migrate]';

const APPLY = process.argv.slice(2).includes('--apply');

// Форма идентификатора и потолок длины — копия из task.mjs, и копия намеренная: два хука
// обязаны считать задачей ровно одно и то же. Регэксп проверяет ФОРМУ, а не календарь.
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const ID_MAX = 80;

// Нетронутый шаблон плана/ревью/аудита переносить нечего — это не задача, а форма.
const TEMPLATE_MARK = '<название задачи>';

const counts = { moved: 0, resumed: 0, skipped: 0, unparsed: 0 };
const seen = new Map();   // id -> источник, который его уже занял в этом прогоне

main();

// --- ход работы -------------------------------------------------------------

function main() {
  if (!existsSync(ARTIFACTS)) {
    say('переносить нечего: папки .claude/artifacts/ нет');
    process.exit(0);
  }
  say(APPLY
    ? 'переношу старую память в .claude/tasks/ — оригиналы остаются на месте'
    : 'предпросмотр: показываю, что перенеслось бы, и ничего не меняю');
  noticeTmp();

  const list = collect();
  if (!list.length) {
    say('переносить нечего: ни плана текущей задачи, ни записей в artifacts/history/');
    process.exit(0);
  }

  for (const src of list) {
    try {
      handle(src);
    } catch (e) {
      counts.unparsed += 1;
      say(`${rel(src.abs)}: не разобрал, оставляю как есть (${msg(e)})`);
    }
  }
  report();
  process.exit(0);
}

/** Что вообще может быть источником: план текущей задачи и записи архива. */
function collect() {
  const list = [];
  const plan = path.join(ARTIFACTS, 'PLAN.md');
  if (plainFileExists(plan)) list.push({ kind: 'plan', abs: plan });
  try {
    if (existsSync(HISTORY)) {
      for (const name of readdirSync(HISTORY).sort()) {
        if (!name.endsWith('.md') || name === 'INDEX.md') continue;
        const abs = path.join(HISTORY, name);
        // Только обычные файлы: lstat не идёт по симлинку, поэтому подложенная ссылка
        // источником не становится и в папку задачи не вшивается.
        if (!plainFileExists(abs)) continue;
        list.push({ kind: 'history', abs, name });
      }
    }
  } catch (e) {
    say(`не смог прочитать artifacts/history/: ${msg(e)}`);
  }
  return list;
}

/** Один источник: разобрать, классифицировать состояние папки и (в --apply) перенести. */
function handle(src) {
  const from = rel(src.abs);
  const parsed = src.kind === 'plan' ? readPlan(src.abs) : readRecord(src.abs, src.name);
  if (!parsed) {
    counts.unparsed += 1;
    say(`${from}: не разобрал, оставляю как есть`);
    return;
  }
  if (parsed.nothing) { say(`${from}: ${parsed.nothing}`); return; }

  const id = `${parsed.date}-${slug(parsed.title)}`;
  const dir = taskDir(id);
  if (!dir) {
    counts.unparsed += 1;
    say(`${from}: не разобрал, оставляю как есть (идентификатор «${clean(id).slice(0, 80)}» не прошёл проверку)`);
    return;
  }

  // Два источника с одинаковой датой и одинаковым заголовком дали бы одно имя папки, и второй
  // молча лёг бы поверх первого. Молчать здесь нельзя: это потеря памяти, а не идемпотентность.
  const taken = seen.get(id);
  if (taken) {
    counts.skipped += 1;
    say(`${from}: идентификатор ${id} уже занял ${taken} — пропускаю, оригинал на месте`);
    return;
  }
  seen.set(id, from);

  // Папка задачи и её файлы обязаны быть обычными папкой и файлами. Проверка идентификатора
  // отвечает за ИМЯ; за то, что по этому имени лежит на диске, отвечает только lstat: запись
  // в подложенный симлинк — это запись за пределы .claude/tasks/ при полностью законном id.
  if (!plainDirOrFree(dir)) {
    counts.unparsed += 1;
    say(`${from} → ${id}: на месте папки задачи лежит не папка (симлинк?) — оставляю как есть`);
    return;
  }

  const state = path.join(dir, 'STATE.md');
  const dirThere = existsSync(dir);
  const stateThere = plainFileExists(state);
  if (stateThere) {
    counts.skipped += 1;
    say(`${from} → ${id}: пропускаю (уже перенесена)`);
    return;
  }

  const files = Object.entries(parsed.files).filter(([, body]) => body);
  const names = files.map(([name]) => name);
  const bad = [...names, 'STATE.md'].find((name) => !plainFileOrFree(path.join(dir, name)));
  if (bad) {
    counts.unparsed += 1;
    say(`${from} → ${id}: в папке задачи ${bad} — не обычный файл (симлинк?), оставляю как есть`);
    return;
  }

  // Папка есть, а STATE.md нет — прошлый прогон оборвался. Говорим об этом строкой: человек
  // должен знать, что часть файлов перезаписывается, а не просто «всё прошло гладко».
  const resume = dirThere;
  if (resume) say(`${from} → ${id}: папка есть, а STATE.md нет — незавершённый перенос, переношу заново`);

  const what = names.map((n) => n.replace(/\.md$/, '')).join(', ') || 'ничего';
  if (!APPLY) {
    counts[resume ? 'resumed' : 'moved'] += 1;
    say(`${from} → ${id}: ${resume ? 'дозаписал бы' : 'перенёс бы'} (${what})`);
    return;
  }

  mkdirSync(TASKS, { recursive: true });
  // recursive здесь уместен, в отличие от `task.mjs new`: там EEXIST — защита от гонки двух
  // сессий, а тут существующая папка уже классифицирована выше как незавершённый перенос.
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of files) {
    writeFileSync(path.join(dir, name), body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  }
  // STATE.md — последним и только после всего остального: см. врезку в шапке файла.
  writeFileSync(state, buildState(id, parsed.title, parsed.date, from), 'utf8');
  counts[resume ? 'resumed' : 'moved'] += 1;
  say(`${from} → ${id}: ${resume ? 'дозаписана' : 'перенесена'} (${what})`);
}

function report() {
  say(APPLY
    ? `итог: перенесено ${counts.moved}, дозаписано незавершённых ${counts.resumed}, `
      + `пропущено ${counts.skipped} (уже есть), не разобрано ${counts.unparsed}`
    : `предпросмотр: перенесу ${counts.moved}, дозапишу незавершённых ${counts.resumed}, `
      + `пропущу ${counts.skipped} (уже есть), не разобрал ${counts.unparsed}`);
  say('оригиналы в artifacts/ и artifacts/history/ остаются на месте — хук ничего не удаляет');
  say(APPLY
    ? 'указатель tasks/ACTIVE не тронут: какая задача активна — решает человек'
    : 'выполнить перенос: node .claude/hooks/migrate-tasks.mjs --apply');
}

/** Следы чужой реализации переноса. Не наши — не трогаем, но и не молчим. */
function noticeTmp() {
  let names = [];
  try { names = readdirSync(TASKS); } catch { return; }
  const tmp = names.filter((n) => n.startsWith('.migrate-') || n.endsWith('.tmp'));
  if (!tmp.length) return;
  const shown = tmp.slice(0, 5).join(', ') + (tmp.length > 5 ? ', …' : '');
  say(`⚠ в .claude/tasks/ лежат временные каталоги (${shown}) — этот хук их не создаёт `
    + 'и не трогает; читатели задач их пропускают, разберите руками');
}

// --- разбор источников ------------------------------------------------------

/** План текущей задачи + лежащие рядом аудит и ревью. */
function readPlan(abs) {
  const text = readFileSync(abs, 'utf8');
  if (!text.trim() || text.includes(TEMPLATE_MARK)) {
    return { nothing: 'пусто или нетронутый шаблон — переносить нечего' };
  }
  const title = clean((text.match(/^#\s*PLAN\s*[—-]\s*(.+)$/m) || [, ''])[1]) || 'без названия';
  // Дата: строгим регэкспом из шапки; не вышло — время файла; нет и его — сегодня. Такая
  // лесенка допустима только здесь: это план ЖИВОЙ задачи, он и правда мог остаться без даты.
  const date = dateFrom(text) || mtimeDate(abs) || today();
  return {
    title,
    date,
    files: {
      'PLAN.md': text.trim(),
      'SECURITY.md': sideFile(path.join(ARTIFACTS, 'SECURITY.md')),
      'REVIEW.md': sideFile(path.join(ARTIFACTS, 'REVIEW.md')),
    },
  };
}

/** Запись архива: разбирается по её же заголовкам, дата — только из шапки. */
function readRecord(abs, name) {
  const text = readFileSync(abs, 'utf8');
  if (!text.trim()) return null;
  const title = clean((text.match(/^#\s+(.+)$/m) || [, ''])[1])
    || name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  // Никакой лесенки, в отличие от плана: у записи архива дата стоит в шапке всегда, а её
  // отсутствие или подмена (`**Дата:** ../../../../tmp`) означает чужой формат — такую
  // запись честнее оставить как есть, чем достроить ей дату из mtime и завести папку.
  const date = dateFrom(text);
  if (!date || !title) return null;
  return { title, date, files: splitRecord(text) || { 'PLAN.md': text.trim() } };
}

/** Три раздела записи архива → три файла задачи. Не нашлось ни одного — вернём null. */
function splitRecord(text) {
  const heads = [
    ['PLAN.md', /^##\s+План\s*$/m],
    ['SECURITY.md', /^##\s+Аудит безопасности\s*$/m],
    ['REVIEW.md', /^##\s+Ревью\s*$/m],
  ];
  const found = [];
  for (const [name, re] of heads) {
    const m = text.match(re);
    if (m) found.push({ name, at: m.index, from: m.index + m[0].length });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.at - b.at);
  const parts = {};
  for (let i = 0; i < found.length; i += 1) {
    const to = i + 1 < found.length ? found[i + 1].at : text.length;
    parts[found[i].name] = tidy(text.slice(found[i].from, to));
  }
  return parts;
}

/** Текст раздела без хвостового разделителя `---`, которым запись отбивает разделы. */
function tidy(s) {
  let t = String(s).trim();
  while (/\n-{3,}$/.test(t)) t = t.replace(/\n-{3,}$/, '').trim();
  return t;
}

/** Соседний файл задачи: пустой или нетронутый шаблон переносить незачем. */
function sideFile(abs) {
  const text = readOr(abs, '').trim();
  return !text || text.includes(TEMPLATE_MARK) ? '' : text;
}

/**
 * Дата из ПЕРВОЙ строки `**Дата:**` и только с её начала. Искать регэкспом по всему тексту
 * нельзя: запись архива несёт внутри себя целый план со своей строкой `**Дата:**`, и поиск
 * «где-нибудь» тихо взял бы дату из вложенного плана вместо подменённой в шапке.
 */
function dateFrom(src) {
  const line = String(src).match(/^\*\*Дата:\*\*(.*)$/m);
  if (!line) return '';
  const m = line[1].match(/^\s*_?\(?(\d{4}-\d{2}-\d{2})\)?/);
  return m ? m[1] : '';
}

// --- состояние задачи -------------------------------------------------------

/** STATE.md перенесённой задачи: тот же эталон, что у `task.mjs new`, плюс `migrated_from`. */
function buildState(id, title, date, from) {
  const fields = {
    id,
    title: title || '(без названия)',
    status: 'done',
    mode: 'full',
    created: date,
    updated: stamp(),
    review_iterations: '0',
    branch: '-',
    migrated_from: from,
  };
  const stub = readOr(path.join(STUBS, 'STATE.md'), '');
  const body = (stub && editFront(stub, fields)) || fallbackState(fields);
  const line = `- ${hhmm()} перенесена из ${from} (оригинал остался на месте)\n`;
  const i = body.indexOf('## Журнал');
  return i === -1
    ? `${body.trimEnd()}\n\n## Журнал\n\n${line}`
    : `${body.slice(0, i)}## Журнал\n\n${line}`;
}

/** Заглушки нет (кит просто распакован) — состояние всё равно должно быть записано. */
function fallbackState(fields) {
  const front = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${front}\n---\n\n# STATE — состояние задачи\n\n`
    + '> Задача перенесена из старой памяти проекта хуком `migrate-tasks.mjs`.\n'
    + '> Оригинал остался на месте.\n';
}

/** Правит поля во front-matter, не трогая тело. Нет front-matter — null (сами не выдумываем). */
function editFront(src, fields) {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  let front = m[1];
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (re.test(front)) front = front.replace(re, `${key}: ${value}`);
    else front += `\n${key}: ${value}`;
  }
  return `${src.slice(0, m.index)}---\n${front}\n---${src.slice(m.index + m[0].length)}`;
}

// --- идентификаторы и пути --------------------------------------------------

/**
 * ЕДИНСТВЕННОЕ место, где идентификатор превращается в путь. Копия из `task.mjs` — так же
 * намеренная, как копия `slug()`: белый список и граница каталога здесь часть контракта
 * безопасности, а не стиль. Возвращает абсолютный путь или null («не разобрал»).
 */
function taskDir(id) {
  const s = String(id == null ? '' : id);
  if (s.length > ID_MAX) return null;   // ENAMETOOLONG — плохая замена внятному отказу
  if (!ID_RE.test(s)) return null;
  const dir = path.resolve(TASKS, s);
  if (!dir.startsWith(TASKS + path.sep)) return null;   // граница каталога, а не вера в регэксп
  return dir;
}

/**
 * Имя папки из названия задачи. Кириллица переводится в латиницу: так имя остаётся читаемым
 * и не ломается при переносе между системами и архиваторами.
 *
 * Белый список `[^a-z0-9]+ → '-'` и фолбэк 'zadacha' — часть контракта безопасности: именно
 * на них держится защита от `../`, двоеточий, нулевых байтов и омоглифов в чужом markdown.
 * Копия из `task.mjs`/`archive-task.mjs` намеренная: имя должно получаться одно и то же.
 */
function slug(title) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  return [...String(title).toLowerCase()]
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'zadacha';
}

// --- файловые проверки ------------------------------------------------------

/** Обычный файл на диске (симлинк — нет). */
function plainFileExists(p) {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

/** Писать сюда можно: либо обычный файл, либо ничего. */
function plainFileOrFree(p) {
  try { return lstatSync(p).isFile(); } catch { return true; }
}

/** Создавать/наполнять можно: либо обычная папка, либо ничего. */
function plainDirOrFree(p) {
  try { return lstatSync(p).isDirectory(); } catch { return true; }
}

// --- вспомогательное --------------------------------------------------------

function readOr(file, fallback) {
  try { return readFileSync(file, 'utf8'); } catch { return fallback; }
}

function mtimeDate(abs) {
  try {
    const d = statSync(abs).mtime;
    return d && !Number.isNaN(d.getTime()) ? ymd(d) : '';
  } catch {
    return '';
  }
}

/**
 * Текст из чужого файла, который попадёт в наш файл и в терминал. Управляющие символы
 * (включая нулевой байт, переводы строк и ANSI-escape) заменяются пробелом, длина режется
 * по лимиту заголовка. Копия из `task.mjs`: чистить обязаны все, кто пишет чужой текст.
 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today() {
  return ymd(new Date());
}

function hhmm() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp() {
  return `${today()} ${hhmm()}`;
}

function rel(p) {
  const r = path.relative(PROJECT_ROOT, p);
  return (!r || r.startsWith('..')) ? p : r.split(path.sep).join('/');
}

function msg(e) {
  return clean(e && e.message ? e.message : e);
}

function say(line) {
  process.stdout.write(`${TAG} ${line}\n`);
}
