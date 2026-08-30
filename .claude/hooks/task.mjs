#!/usr/bin/env node
/**
 * Задачи с идентификаторами (Claude Agent Kit): всё про одну задачу лежит в
 * `.claude/tasks/<ГГГГ-ММ-ДД-имя>/` — STATE.md, PLAN.md, SECURITY.md, REVIEW.md.
 * Какая задача идёт прямо сейчас, говорит однострочный `.claude/tasks/ACTIVE`.
 * Кроссплатформенно, БЕЗ внешних зависимостей: только встроенные модули `node:*`.
 *
 *   node .claude/hooks/task.mjs new "<название>"   завести задачу и сделать её активной
 *   node .claude/hooks/task.mjs status <статус>    сменить статус активной задачи
 *   node .claude/hooks/task.mjs log "<строка>"     дописать строку в журнал
 *   node .claude/hooks/task.mjs close              закрыть задачу и снять указатель
 *   node .claude/hooks/task.mjs list               все задачи: id, дата, статус, заголовок
 *   node .claude/hooks/task.mjs path               абсолютный путь активной задачи, и только он
 *
 * Про журнал. Обязательные записи делают `status` (смена статуса) и Stop-хук `gate.mjs`
 * (вердикт приёмки) — специально логировать ничего не нужно. `log` остаётся редким ручным
 * инструментом: он несёт произвольный текст человека, поэтому в `permissions.allow`
 * не попадает никогда и спрашивает подтверждения намеренно.
 *
 * Три границы доверия — из-за них хук устроен строже, чем «создать папку»:
 *   • название задачи — текст человека. Берётся ТОЛЬКО первый позиционный аргумент и чистится
 *     повторно (`clean`), даже если его уже чистил тот, кто звал хук;
 *   • идентификатор становится путём только через `taskDir()` — с проверкой формы, потолком
 *     длины и сверкой, что путь лежит внутри `tasks/`. `ACTIVE` — обычный текстовый файл,
 *     его правят руками и через `echo >`, поэтому доверия к нему ровно столько же, сколько
 *     к аргументу командной строки;
 *   • испорченный `ACTIVE` не должен давать примитив записи: `status`, `log` и `close` ничего
 *     не создают — нет папки или нет `STATE.md`, значит сообщение и код 3.
 *
 * Хук не бросает исключений и не «чинит» кривые данные: непонятная запись при перечислении —
 * строка «пропускаю» и продолжение, непонятный запрос — сообщение в stderr и код 3.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const KIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ROOT = path.dirname(KIT_DIR);
const TASKS = path.join(KIT_DIR, 'tasks');
const ACTIVE = path.join(TASKS, 'ACTIVE');
const STUBS = path.join(KIT_DIR, 'assets', 'stubs');
const GATE_STATE = path.join(KIT_DIR, 'artifacts', 'GATE_STATE.json');
const EVENTS_MJS = path.join(KIT_DIR, 'hooks', 'events.mjs');
const TAG = '[task]';

// Форма идентификатора — дата и строчное латинское имя. Регэксп проверяет ФОРМУ, а не
// календарь: `2026-13-99-x` он принимает, и это правильно — безопасным именем каталога такая
// строка быть не перестаёт, а проверка календаря к безопасности отношения не имеет.
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const ID_MAX = 80;

// Порядок статусов — тот же, что в эталоне assets/stubs/STATE.md.
const STATUSES = [
  'exploring', 'planning', 'awaiting_approval', 'implementing',
  'reviewing', 'reworking', 'done', 'blocked',
];

// Потолок итераций ревью, контракт §3.2: без него связка «ревьюер придирается — исполнитель
// правит» крутится, пока не кончится контекст.
const REVIEW_LIMIT = 3;

// Событие, которое уже заслужено записью на диск, но ещё не доехало до журнала: между
// `writeFileSync` и `emit(...)` есть код, и он может упасть. Выставляет `pend()` сразу после
// удавшейся записи, обнуляет `emit()` первым же действием, а из верхнеуровневого `catch`
// незаписанное досылает `flushPending()` с парой `crashed=yes`.
//
// Объявление стоит ЗДЕСЬ, выше точки входа, а не внизу рядом с `emit`: `let` на верхнем уровне
// модуля до своей строки лежит в мёртвой зоне, а команды выполняются из блока ниже — перенос
// объявления к остальному коду журнала дал бы ReferenceError на первой же команде.
let pending = null;

// --- точка входа ------------------------------------------------------------

// Позиционные аргументы — всё, что не начинается с `--`: так же, как в gate.mjs.
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((a) => !a.startsWith('--'));

try {
  if (cmd === 'new') cmdNew(args[0]);
  else if (cmd === 'status') cmdStatus(args);
  else if (cmd === 'log') cmdLog(args);
  else if (cmd === 'close') cmdClose();
  else if (cmd === 'list') cmdList();
  else if (cmd === 'path') cmdPath();
  else usage();
} catch (e) {
  // Действие могло состояться, а событие — не доехать: между записью на диск и `emit(...)`
  // стоит код, и падает именно он. Досылаем незаписанное ДО `die`, потому что `die` уходит
  // через `process.exit(3)` и возврата из него нет. Собственный `try/catch` — чтобы падение
  // самого досыла не подменило собой исходное сообщение об ошибке, ради которого человек
  // сюда и смотрит.
  //
  // Отказы через `die()` (исчерпанный лимит ревью, неизвестный статус, испорченный ACTIVE)
  // событий не пишут и писать не должны: отказ — не падение, а запись о несостоявшемся
  // действии была бы враньём. Держится это механически, а не по договорённости: `die()`
  // уходит через `process.exit(3)` и сюда не попадает, а во всех точках отказа `pending`
  // ещё пуст — запись до них не дошла. Не «чините» это, добавляя событие в `die()`.
  try { flushPending(); } catch { /* журнал не повод потерять сообщение об ошибке */ }
  die(`внутренняя ошибка: ${e && e.message ? e.message : e}`);
}

// --- подкоманды -------------------------------------------------------------

/** Завести задачу: папка с формами, заполненный STATE.md, указатель ACTIVE. */
function cmdNew(rawTitle) {
  if (rawTitle === undefined) die('нужно название: node .claude/hooks/task.mjs new "<название>"');
  const title = clean(rawTitle);
  const base = `${today()}-${slug(title)}`;

  // Корень tasks/ создаётся ЗАРАНЕЕ и с recursive: его может не быть вовсе (свежий клон, где
  // не отрабатывал stubs.mjs), и первая же задача падала бы с ENOENT.
  mkdirSync(TASKS, { recursive: true });

  // А папка САМОЙ задачи создаётся БЕЗ recursive — и это не небрежность. Без него mkdir
  // падает с EEXIST на существующей папке, и именно этот отказ превращает гонку двух сессий
  // в безобидную коллизию имён (-2, -3). Верните сюда recursive: true — и вторая сессия молча
  // получит чужую папку и перезапишет чужой PLAN.md. Не «чинить» при первом ENOENT: ENOENT
  // лечится строкой выше, а не флагом здесь.
  let id = base;
  let dir = taskDir(id);
  if (!dir) die(`не смог собрать идентификатор из названия «${title}»`);
  for (let n = 1; ; n += 1) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') die(`не смог создать папку задачи: ${e.message}`);
      if (n > 99) die('слишком много задач с таким названием за один день — назовите иначе');
      id = `${base}-${n + 1}`;
      dir = taskDir(id);
      if (!dir) die(`не смог подобрать свободный идентификатор для «${title}»`);
    }
  }

  // Про перехват указателя говорим вслух: незакрытая задача никуда не делась, но активной
  // стала новая, и человек должен заметить это сейчас, а не обнаружить потом.
  const prev = activeId();
  if (prev && prev !== id) {
    const fm = frontMatter(readOr(path.join(TASKS, prev, 'STATE.md'), ''));
    const status = fm ? clean(fm.get('status')) : '';
    if (!['done', 'blocked'].includes(status)) {
      say(`⚠ активной была ${prev}${status ? ` (${status})` : ''} — переключаю на ${id}`);
    }
  }
  const gate = readGate();
  if (gate && gate.task_id && gate.task_id !== id) {
    say(`⚠ гейт взведён на задачу ${clean(gate.task_id)} — приёмка считается по ней, пока её не перевзведут`);
  }

  placeStub('STATE.md', path.join(dir, 'STATE.md'), (src) => fillState(src, id, title));
  placeStub('PLAN.md', path.join(dir, 'PLAN.md'));
  placeStub('SECURITY.md', path.join(dir, 'SECURITY.md'));
  placeStub('REVIEW.md', path.join(dir, 'REVIEW.md'));

  try {
    writeFileSync(ACTIVE, `${id}\n`, 'utf8');
    pend('task_opened', id, { title });   // указатель на диске — событие заслужено
  } catch (e) {
    say(`⚠ не смог записать указатель ACTIVE: ${e.message} — задача создана, но активной не стала`);
  }
  emit('task_opened', id, { title });
  say(`задача заведена: ${id}`);
  say(`папка: ${dir}`);
}

/** Сменить статус активной задачи. Ровно один аргумент и ровно из списка. */
function cmdStatus(list) {
  if (list.length !== 1) die(`нужен ровно один статус\nдопустимые: ${STATUSES.join(', ')}`);
  const value = list[0];
  if (!STATUSES.includes(value)) {
    die(`не знаю статус «${clean(value)}»\nдопустимые: ${STATUSES.join(', ')}`);
  }
  const { id, dir } = requireActive();
  const file = path.join(dir, 'STATE.md');
  // Читаем файл ОТДЕЛЬНО от правки: старое значение статуса нужно журналу событий, а
  // `editFront` его не возвращает — переход «из чего во что» иначе терялся бы.
  const src = readOr(file, '');
  const fm = frontMatter(src);
  const from = fm ? clean(fm.get('status')) : '';

  // Лимит итераций ревью держит КОД, а не текст промта. Раньше на этом месте стоял человек,
  // и заменять его абзацем в промте оркестратора значило бы не заменять вовсе: промт можно
  // не дочитать, а отказ команды не обойти. Поэтому механизм — отказ ДО какой-либо записи,
  // а печатная строка «итерация N из 3» ниже осталась диагностикой, и только.
  //
  // Счётчик растёт только на ВХОДЕ в статус (`from !== 'reworking'`): оркестратор, дёрнувший
  // команду дважды подряд, не теряет и не удваивает круг. И он не сбрасывается нигде — ни
  // возвратом в `reviewing`, ни закрытием задачи: он считает ВОЗВРАТЫ на доработку, а не
  // текущее состояние, и сброс превратил бы лимит в формальность — его обходили бы
  // переключением статусов туда-обратно. Единственный законный сброс — новая задача.
  const fields = { status: value, updated: stamp() };
  let grew = false;          // счётчик увеличился именно сейчас
  let iteration = null;      // номер итерации для вывода; null — статус не reworking
  if (value === 'reworking') {
    const iters = reviewIters(fm);
    if (iters === null) {
      die(`⚠ review_iterations в STATE.md не разобран («${clean(fm && fm.get('review_iterations'))}») — считаю лимит исчерпанным`);
    }
    grew = from !== 'reworking';
    if (grew && iters + 1 > REVIEW_LIMIT) {
      die([
        `лимит итераций ревью исчерпан (${iters} из ${REVIEW_LIMIT}): дальше`,
        '  node .claude/hooks/task.mjs status blocked, решает человек',
      ].join('\n'));
    }
    iteration = grew ? iters + 1 : iters;
    if (grew) fields.review_iterations = String(iteration);
  }

  const next = editFront(src, fields);
  if (!next) die(`в ${rel(file)} нет front-matter — статус записать некуда, ничего не меняю`);
  // Payload собирается ДО записи намеренно: между `writeFileSync` и `pend` не должно стоять
  // ничего, что умеет упасть, — иначе окно «действие состоялось, события нет» останется
  // открытым ровно там, где его и закрывают.
  const payload = { from, to: value };
  if (grew) payload.iteration = String(iteration);   // ключ только на переходе — новых событий не заводим
  writeFileSync(file, next, 'utf8');
  pend('status_changed', id, payload);               // статус на диске — событие заслужено
  journal(file, grew ? `статус → ${value} · итерация ревью ${iteration}` : `статус → ${value}`);
  emit('status_changed', id, payload);
  say(iteration === null
    ? `${id}: статус ${value}`
    : `${id}: статус ${value} · итерация ревью ${iteration} из ${REVIEW_LIMIT}`);
}

/** Дописать строку в журнал активной задачи. Ручной инструмент — см. шапку файла. */
function cmdLog(list) {
  if (!list.length) die('нужна строка: node .claude/hooks/task.mjs log "<строка>"');
  const text = clean(list[0]);
  if (!text) die('строка пустая — записывать нечего');
  const { id, dir } = requireActive();
  journal(path.join(dir, 'STATE.md'), text);
  say(`${id}: записано в журнал`);
}

/** Закрыть задачу: статус done и пустой указатель. Испорченный ACTIVE — отказ, а не «починка». */
function cmdClose() {
  const { id, dir } = requireActive();
  const file = path.join(dir, 'STATE.md');
  // То же чтение, что в cmdStatus, плюс `created`: полное время жизни задачи считается
  // только здесь и только один раз. Не разобралось (старая задача из миграции, чужой
  // формат) — поля просто не будет, ноль вместо факта не выдумываем.
  const src = readOr(file, '');
  const fm = frontMatter(src);
  const from = fm ? clean(fm.get('status')) : '';
  const started = fm ? parseStamp(fm.get('created')) : null;
  const next = editFront(src, { status: 'done', updated: stamp() });
  if (!next) die(`в ${rel(file)} нет front-matter — закрывать нечего, ничего не меняю`);
  // Как в cmdStatus: payload собран до записи, чтобы `pend` стоял к ней вплотную.
  const payload = {
    from,
    duration_min: started ? Math.max(0, Math.round((Date.now() - started) / 60000)) : '',
  };
  writeFileSync(file, next, 'utf8');
  pend('task_closed', id, payload);   // статус done на диске — событие заслужено
  journal(file, 'задача закрыта');
  emit('task_closed', id, payload);
  try {
    writeFileSync(ACTIVE, '\n', 'utf8');
  } catch (e) {
    say(`⚠ не смог очистить указатель ACTIVE: ${e.message}`);
  }
  say(`${id}: закрыта, активной задачи больше нет`);
  // Гейт переживает закрытие задачи намеренно — молчать об этом нельзя.
  // Условие «состояние есть и оно не verified», а не «implementing»: blocked (три неудачи
  // или подмена набора проверок) — как раз то состояние, где человек нужен обязательно,
  // и промолчать о нём было бы хуже всего.
  // Рецепт снятия печатаем только живому терминалу: `task.mjs close` лежит в allow
  // (settings.json), выполняется без вопроса, и его stdout попадает прямо в контекст модели.
  // Та же дисциплина, что в gate.mjs (--selftest, строки 215–226).
  try {
    const g = readGate();
    const gs = g ? clean(g.status) : '';
    if (g && clean(g.task_id) === id && gs && gs !== 'verified') {
      say(`⚠ гейт остался на задаче ${id}, состояние «${gs}» — приёмка не пройдена`);
      if (process.stdin.isTTY) {
        say('  снять взвод может только человек: node .claude/hooks/gate.mjs --disarm');
        say('  зелёный прогон приёмки снимает взвод сам');
      } else {
        say('  как снять — .claude/CUSTOMIZE.md, раздел «Машинная приёмка»');
      }
    }
  } catch { /* подсказка best-effort: ломать закрытие задачи она не имеет права */ }
}

/** Список задач. Что считается задачей — правило Р11, см. taskDir() + hasState(). */
function cmdList() {
  const active = activeId();
  const gate = readGate();
  let entries;
  try {
    entries = readdirSync(TASKS, { withFileTypes: true });
  } catch {
    say('папки .claude/tasks/ ещё нет — задач пока нет');
    return;
  }

  const rows = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = taskDir(e.name);
    if (!dir || !hasState(dir)) continue;   // Р11: всё прочее пропускается молча
    const fm = frontMatter(readOr(path.join(dir, 'STATE.md'), ''));
    if (!fm) { say(`${e.name}: STATE.md не разобрал — пропускаю`); continue; }
    rows.push({
      id: e.name,
      date: e.name.slice(0, 10),
      // Заголовок мог приехать миграцией из чужого markdown, поэтому чистим и на выводе тоже.
      title: clean(fm.get('title')) || '(без названия)',
      status: clean(fm.get('status')).slice(0, 20) || '?',
      iters: reviewIters(fm),
    });
  }
  if (!rows.length) { say('задач пока нет'); return; }

  rows.sort((a, b) => (a.id < b.id ? 1 : -1));   // новые сверху: id начинается с даты
  const wId = Math.max(...rows.map((r) => r.id.length));
  const wStatus = Math.max(...rows.map((r) => r.status.length));
  say(`задач: ${rows.length}`);
  const gateStopped = gate && clean(gate.status) === 'blocked';
  let unparsed = false;
  for (const r of rows) {
    const mark = r.id === active ? '→' : ' ';
    // Итерации ревью показываем, только когда они были: «0/3» у каждой свежей задачи — шум.
    // Неразобранное значение отмечаем вопросом, а объясняем ОДНОЙ строкой после таблицы:
    // шуметь предупреждением на каждой строке списка ни к чему.
    let iters = '';
    if (r.iters === null) { iters = '  · ревью: ?'; unparsed = true; }
    else if (r.iters > 0) iters = `  · ревью: ${r.iters}/${REVIEW_LIMIT}`;
    // Приёмка — из GATE_STATE.json и только при совпадении task_id: проверки гоняются по всему
    // рабочему дереву, и приписать чужой вердикт соседней задаче было бы прямой ложью.
    let verdict = '';
    if (gate && gate.task_id === r.id) {
      const where = `по дереву на ${clean(gate.armed_at) || '?'}`;
      verdict = gateStopped
        ? `  · приёмка: остановлена (${clean(gate.verify) || 'нет'}) — ${where}`
        : `  · приёмка: ${clean(gate.verify) || 'нет'} (${where})`;
    }
    out(`  ${mark} ${r.id.padEnd(wId)}  ${r.date}  ${r.status.padEnd(wStatus)}  ${r.title}${iters}${verdict}`);
  }
  if (unparsed) {
    say('⚠ у задач с «ревью: ?» поле review_iterations в STATE.md не разобрано — status reworking по ним откажет');
  }

  // Памятка про два разных «blocked». Слово одно, смыслов два, и стоят они рядом в одном
  // выводе — перепутать их проще всего именно здесь.
  if (gateStopped || rows.some((r) => r.status === 'blocked')) {
    say('`blocked` у задачи и «приёмка остановлена» — разное: первое про итерации ревью, второе про красные прогоны проверок');
  }

  // Расхождение показываем строкой, а не пустой ячейкой: пустая ячейка читается как
  // «приёмки не было», хотя гейт в это время следит за другой задачей.
  if (gate && gate.task_id && gate.task_id !== active) {
    say(`⚠ гейт взведён на задачу ${clean(gate.task_id)}, а активная — ${active || 'нет'}: приёмка считается по гейту`);
  } else if (gate && !gate.task_id) {
    say('⚠ гейт взведён без id задачи (взводили руками или до перехода на tasks/) — с задачами его не сопоставляю');
  }
}

/** Только путь и ничего кроме: команду зовут как `$(task.mjs path)`. */
function cmdPath() {
  const { dir } = requireActive();
  out(dir);
}

function usage() {
  die([
    'подкоманды:',
    '  new "<название>"   завести задачу и сделать её активной',
    `  status <статус>    ${STATUSES.join(', ')}`,
    '  log "<строка>"     дописать строку в журнал',
    '  close              закрыть задачу и снять указатель',
    '  list               все задачи',
    '  path               абсолютный путь активной задачи',
  ].join('\n'));
}

// --- идентификаторы и пути --------------------------------------------------

/**
 * ЕДИНСТВЕННОЕ место, где идентификатор превращается в путь. Через него обязаны ходить все
 * подкоманды, чтение ACTIVE и всё, что придёт позже: `id` приходит из файла, который правят
 * руками, из чужого markdown при миграции и из командной строки — то есть отовсюду.
 *
 * Возвращает абсолютный путь или null («не разобрал»). Что делать с отказом, решает
 * вызывающий: подкоманды заканчиваются кодом 3, а перечисление и миграция просто пропускают
 * такую запись. Никаких попыток «починить» строку здесь нет и быть не должно.
 */
function taskDir(id) {
  const s = String(id == null ? '' : id);
  if (s.length > ID_MAX) return null;   // ENAMETOOLONG — плохая замена внятному отказу
  if (!ID_RE.test(s)) return null;
  const dir = path.resolve(TASKS, s);
  if (!dir.startsWith(TASKS + path.sep)) return null;   // граница каталога, а не вера в регэксп
  return dir;
}

/** Правило Р11 на одного кандидата: имя прошло taskDir() и внутри есть STATE.md. */
function hasState(dir) {
  try { return statSync(path.join(dir, 'STATE.md')).isFile(); } catch { return false; }
}

/** id из ACTIVE, если он вообще похож на идентификатор; иначе null. Мягкая форма. */
function activeId() {
  const raw = activeRaw();
  return raw && taskDir(raw) ? raw : null;
}

function activeRaw() {
  try {
    return String(readFileSync(ACTIVE, 'utf8')).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

/**
 * Активная задача целиком — для подкоманд, которые пишут. Ничего не создаёт и не достраивает:
 * `echo ../../../tmp > ACTIVE` обязан заканчиваться отказом, а не свежесозданной папкой.
 */
function requireActive() {
  const raw = activeRaw();
  if (!raw) die('активной задачи нет: .claude/tasks/ACTIVE пуст');
  const dir = taskDir(raw);
  if (!dir) die(`в ACTIVE не идентификатор задачи: «${clean(raw).slice(0, 80)}» — путь по нему не строю`);
  if (!hasState(dir)) die(`задачи ${raw} нет на диске (нет папки или нет STATE.md) — ничего не создаю`);
  return { id: raw, dir };
}

// --- файлы задачи -----------------------------------------------------------

/** Кладёт форму из assets/stubs. Существующее не перезаписывается никогда. */
function placeStub(name, to, transform) {
  if (existsSync(to)) { say(`${path.basename(to)} уже на месте — не трогаю`); return; }
  const from = path.join(STUBS, name);
  if (!existsSync(from)) { say(`нет заглушки assets/stubs/${name} — пропускаю`); return; }
  try {
    const src = readFileSync(from, 'utf8');
    writeFileSync(to, transform ? transform(src) : src, 'utf8');
  } catch (e) {
    say(`не смог положить ${path.basename(to)}: ${e.message}`);
  }
}

/** Эталон STATE.md → состояние конкретной задачи. */
function fillState(src, id, title) {
  const now = stamp();
  const filled = editFront(src, {
    id,
    title: title || '(без названия)',
    status: STATUSES[0],
    mode: 'full',
    created: now,
    updated: now,
    review_iterations: '0',
    branch: gitBranch(),
  }) || src;
  // Строка-пример из эталона заменяется настоящей первой записью: журнал с выдуманной
  // строкой хуже пустого — по нему потом восстанавливают ход работы.
  const i = filled.indexOf('## Журнал');
  return i === -1 ? filled : `${filled.slice(0, i)}## Журнал\n\n- ${hhmm()} задача заведена\n`;
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

function frontMatter(src) {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (f) map.set(f[1], f[2].trim());
  }
  return map;
}

/**
 * Сколько раз ревью уже возвращало задачу исполнителю. Ровно ТРИ исхода и ни одного больше:
 *   поля нет вовсе         → 0. Законный ноль: задача заведена копией набора до 1.15.0,
 *                            и `editFront` допишет поле при первом же переходе;
 *   целое и не меньше нуля → оно само;
 *   всё остальное          → null, «не разобрано», и вызывающий отказывает.
 *
 * Зажимать значение в ноль (`Math.max(0, …)`) здесь ЗАПРЕЩЕНО. Это единственная функция,
 * на которой держится лимит, и двух трактовок одного значения в ней быть не должно:
 * отрицательное обязано давать отказ, а не тихий ноль. `parseInt('-5')` даёт -5, сравнение
 * «меньше трёх» не наступило бы очень долго, а поле можно удалить `Bash`-ом — правила `deny`
 * закрывают по STATE.md только `Write`/`Edit`.
 *
 * Пустая строка отсекается ОТДЕЛЬНО от нуля намеренно: `Number('')` — это 0, и пустое поле
 * иначе притворилось бы законным нулём, молча сбросив лимит.
 */
function reviewIters(fm) {
  if (!fm || !fm.has('review_iterations')) return 0;
  const raw = clean(fm.get('review_iterations'));
  if (raw === '') return null;
  const n = Number(raw);
  return (Number.isInteger(n) && n >= 0) ? n : null;
}

/** Журнал — хвост STATE.md. Дата стоит в `updated:`, поэтому в строке только время. */
function journal(file, text) {
  try {
    const src = readFileSync(file, 'utf8');
    const line = `- ${hhmm()} ${clean(text)}\n`;
    const sep = src.endsWith('\n') ? '' : '\n';
    appendFileSync(file, src.includes('## Журнал') ? sep + line : `${sep}\n## Журнал\n\n${line}`, 'utf8');
  } catch (e) {
    say(`не смог дописать журнал: ${e.message}`);   // журнал не повод ронять команду
  }
}

/**
 * Событие в машинный журнал `.claude/artifacts/events.jsonl` — best-effort и молча.
 *
 * Отдельным процессом, а не импортом: статический импорт ESM нельзя обернуть в `try/catch`,
 * и сломанный или недоехавший `events.mjs` уронил бы загрузку самого хука — то есть журнал
 * отнял бы у человека смену статуса. Цена решения — один процесс Node на событие.
 *
 * Значения чистятся ЗДЕСЬ, до `args.push`, а не только внутри `events.mjs`: очистка внутри
 * хука работает уже после границы процессов, а ломается именно граница. Node отвергает `argv`
 * с нулевым байтом целиком — `spawnSync` бросит, пустой `catch` проглотит, и событие пропадёт
 * молча. Тот же вызов закрывает длину: огромное значение раздувает `argv` за лимит ОС
 * (на Windows 32 767 символов) с тем же молчаливым исходом. Очистка в `events.mjs` при этом
 * остаётся — две линии здесь намеренны.
 *
 * `String(v)` перед `clean` обязателен: числа в payload бывают (`duration_min`), а версия
 * `clean` в gate.mjs написана как `String(s || '')` и превратила бы `0` в пустую строку, то
 * есть выбросила бы пару. Пишем одинаково в обоих файлах, чтобы разница реализаций `clean`
 * вообще не имела значения. Ключи не чистим — это литералы в коде, за них отвечает `KEY_RE`
 * в `events.mjs`.
 *
 * Ни `say`, ни `die` внутри: молчание намеренно, диагностика журнала живёт
 * в `events.mjs --selftest`, а не в выводе каждой команды.
 *
 * Первым действием обнуляет `pending`: с этой секунды событие взято в работу, и аварийный
 * досыл из верхнеуровневого `catch` его не повторит. Обнуление стоит ДО `existsSync`
 * намеренно — если `events.mjs` в наборе нет, повторять вызов из `catch` тем более незачем.
 */
function emit(event, id, payload) {
  pending = null;   // событие взято в работу — flushPending его больше не продублирует
  try {
    if (!existsSync(EVENTS_MJS)) return;
    const args = [EVENTS_MJS, '--emit', event, '--task', String(id || '')];
    for (const [k, v] of Object.entries(payload || {})) {
      if (v === undefined || v === null) continue;   // нет значения — нет пары
      const sv = clean(String(v));                   // String() обязателен: см. комментарий выше
      if (!sv) continue;                             // после чистки пусто — пары нет
      args.push('--set', `${k}=${sv}`);
    }
    spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, timeout: 10000, stdio: 'ignore' });
  } catch { /* молча: журнал не повод ломать команду */ }
}

/**
 * «Событие заслужено»: изменение уже лежит на диске, а в журнал ещё не попало. Вызывается
 * СРАЗУ после удавшегося `writeFileSync` и ничего не пишет — только запоминает, что должно
 * быть записано. Дальше нормальным путём его пишет `emit`, а если до `emit` дело не дойдёт
 * (исключение между записью и вызовом) — `flushPending` из верхнеуровневого `catch`.
 *
 * Порядок «действие → событие» этим не меняется: событие по-прежнему отражает случившееся,
 * а не намерение. Переставить `emit` перед записью значило бы врать журналу, когда запись
 * не удалась.
 *
 * Payload копируется, а не берётся по ссылке: вызывающий волен дополнять свой объект после
 * вызова, и в аварийную запись не должно попасть то, чего в обычной не было бы.
 */
function pend(event, id, payload) {
  pending = { event, id, payload: { ...(payload || {}) } };
}

/**
 * Досыл незаписанного события из верхнеуровневого `catch`. Пара `crashed=yes` отличает его от
 * обычного: действие состоялось, но команда после этого упала, и остальному её выводу верить
 * нельзя. Новых имён под падение не заводим — оно видно по паре, а имя события остаётся тем
 * же, каким было бы при нормальном ходе дел.
 *
 * Текста ошибки в payload нет намеренно: `e.message` — свободный текст (в современном Node он
 * цитирует разбираемое содержимое), а журнал с фазы 1 контроллера отдаётся по HTTP. Полное
 * сообщение никуда не девается — его печатает человеку `die` в stderr.
 */
function flushPending() {
  const p = pending;
  if (!p) return;
  emit(p.event, p.id, { ...p.payload, crashed: 'yes' });
}

// --- вспомогательное --------------------------------------------------------

function readOr(file, fallback) {
  try { return readFileSync(file, 'utf8'); } catch { return fallback; }
}

/** Состояние приёмки. Оно живёт отдельно от задачи, и намеренно: см. врезку в STATE.md. */
function readGate() {
  try {
    const j = JSON.parse(readFileSync(GATE_STATE, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function gitBranch() {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
    });
    if (r.error || r.status !== 0) return '-';
    return clean(r.stdout).slice(0, 60) || '-';
  } catch {
    return '-';
  }
}

/**
 * Текст человека, который попадёт в файл и в терминал. Управляющие символы (в том числе
 * нулевой байт, переводы строк и ANSI-escape) заменяются пробелом, длина режется по лимиту
 * заголовка. Чистим повторно, даже если звавший уже чистил: доверие к чужой очистке —
 * это отсутствие очистки.
 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Имя папки из названия задачи. Кириллица переводится в латиницу: так имя остаётся
 * читаемым и не ломается при переносе между системами и архиваторами.
 *
 * Белый список `[^a-z0-9]+ → '-'` и фолбэк 'zadacha' — часть контракта безопасности, а не
 * стиль: именно на них держится защита от `../`, двоеточий, нулевых байтов и омоглифов.
 * Копия из archive-task.mjs намеренная: два хука обязаны собирать одно и то же имя.
 */
function slug(title) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  return [...title.toLowerCase()]
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'zadacha';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp() {
  return `${today()} ${hhmm()}`;
}

/**
 * Обратное к `stamp()`: `"2026-08-27 14:40"` → миллисекунды. Разбираем сами, а не через
 * `new Date(строка)`, потому что это НЕ ISO-формат, и разные движки понимают такую строку
 * по-разному (где-то как локальное время, где-то как UTC, где-то не понимают вовсе).
 * Собираем по локальным компонентам — ровно так, как её и записали. Не совпало — `null`,
 * и вызывающий просто не пишет поле: ноль вместо факта не выдумываем.
 */
function parseStamp(s) {
  const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : null;
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

function die(msg) {
  for (const line of String(msg).split('\n')) process.stderr.write(`${TAG} ${line}\n`);
  process.exit(3);
}
